/* ============================================================================
   trackingService — Part III.

   Stores the ambulance's position ring-buffer per case and derives the
   live ETA from it. Rate-limited to 1 update per 5 s per case. Emits
   case:position to the accepting hospital only.
   ========================================================================== */
'use strict';

const MIN_INTERVAL_MS = Number(process.env.TRACK_MIN_INTERVAL_MS || 5000);
const MAX_POINTS      = Number(process.env.TRACK_MAX_POINTS || 120);
const STALL_SECONDS   = Number(process.env.TRACK_STALL_SECONDS || 90);
const ROAD_FACTOR     = Number(process.env.TRACK_ETA_ROAD_FACTOR || 1.25);
const STALL_KMH       = Number(process.env.TRACK_STALL_KMH || 5);
const SPEED_MIN_KMH   = Number(process.env.TRACK_SPEED_MIN_KMH || 15);
const SPEED_MAX_KMH   = Number(process.env.TRACK_SPEED_MAX_KMH || 80);

const haversine = (a, b, c, d) => {
  if ([a,b,c,d].some(v => v==null || v==='' || Number.isNaN(Number(v)))) return null;
  const R = 6371, toRad = x => Number(x)*Math.PI/180;
  const dLat = toRad(c-a), dLng = toRad(d-b);
  const A = Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(A), Math.sqrt(1-A));
};

// { caseCode: { track: [], last_position: null, live_eta_minutes: null, eta_source: 'crew', lastUpdateMs: 0 } }
const cases = new Map();

function ensure(code){ if (!cases.has(code)) cases.set(code, { track: [] }); return cases.get(code); }

function append(caseCode, hospitalLat, hospitalLng, pos){
  const now = Date.now();
  if (!pos || !validCoordinate(pos.lat, 90) || !validCoordinate(pos.lng, 180)) return { error: 'INVALID_COORD' };
  const at = pos.at == null ? now : Date.parse(pos.at);
  if (!Number.isFinite(at) || at > now + 30000 || now - at > 120000) return { error: 'STALE_POSITION' };
  if (pos.accuracy_m != null && (!Number.isFinite(Number(pos.accuracy_m)) || Number(pos.accuracy_m) < 0 || Number(pos.accuracy_m) > 200)) return { error: 'INACCURATE_POSITION' };
  const rec = ensure(caseCode);
  if (rec.lastUpdateMs && (now - rec.lastUpdateMs) < MIN_INTERVAL_MS) return { throttled: true };
  if (rec.last_position && at <= Date.parse(rec.last_position.at)) return { error: 'OUT_OF_ORDER' };
  const point = {
    lat: Number(pos.lat),
    lng: Number(pos.lng),
    accuracy_m: pos.accuracy_m == null ? null : Number(pos.accuracy_m),
    speed_kmh: pos.speed_kmh == null ? null : Number(pos.speed_kmh),
    source: pos.source || 'gps',
    at: new Date(at).toISOString(),
  };
  rec.track.push(point);
  while (rec.track.length > MAX_POINTS) rec.track.shift();
  rec.last_position = point;
  rec.lastUpdateMs = now;
  rec.distance_km = haversine(point.lat, point.lng, hospitalLat, hospitalLng);
  rec.live_eta_minutes = computeEta(rec.track, hospitalLat, hospitalLng);
  rec.eta_source = classify(rec.track, rec.live_eta_minutes);
  return { throttled: false, record: rec, point };
}

/** Milliseconds, or null when the timestamp is not a real instant. */
function timeOf(point){
  const t = new Date(point && point.at).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Median speed over the recent points.
 *
 * Returns null for "cannot tell" and 0 for "measured, and not moving". Those
 * are different facts and collapsing them is what made a stationary ambulance
 * indistinguishable from one with no usable fix — precisely the case this
 * feature exists to surface.
 *
 * Median rather than mean, because one GPS jump across a tunnel mouth should
 * not double the ETA.
 */
function recentSpeedKmh(track){
  if (!track || track.length < 2) return null;
  const last = track.slice(-6);
  const speeds = [];
  for (let i=1;i<last.length;i++){
    const a = last[i-1], b = last[i];
    const ta = timeOf(a), tb = timeOf(b);
    if (ta === null || tb === null) continue;
    const dt = (tb - ta) / 1000;
    if (!(dt > 0)) continue;
    const km = haversine(a.lat, a.lng, b.lat, b.lng);
    if (km == null || !Number.isFinite(km)) continue;
    speeds.push((km / dt) * 3600);
  }
  if (!speeds.length) return null;
  speeds.sort((x,y)=>x-y);
  return speeds[Math.floor(speeds.length/2)];
}

/** Seconds covered by a run of points, or null if it cannot be established. */
function spanSeconds(points){
  if (!points || points.length < 2) return null;
  const first = timeOf(points[0]);
  const last = timeOf(points[points.length - 1]);
  if (first === null || last === null) return null;
  return (last - first) / 1000;
}

function computeEta(track, hopLat, hopLng){
  if (hopLat == null || hopLng == null) return null;
  if (!track || track.length < 3) return null;
  const measured = recentSpeedKmh(track);
  if (measured === null || !Number.isFinite(measured)) return null;
  const last = track[track.length - 1];
  const km = haversine(last.lat, last.lng, hopLat, hopLng);
  if (km == null || !Number.isFinite(km)) return null;

  /* Clamped, and the clamp is load-bearing at both ends: an ambulance stopped
     at a light is not a four-hour ETA, and a 300 km/h GPS artefact is not an
     ETA of thirty seconds. The road factor is an honest admission that roads
     are not straight lines — the UI says the number is an estimate. */
  const speed = Math.min(SPEED_MAX_KMH, Math.max(SPEED_MIN_KMH, measured));
  const minutes = Math.round(((km / speed) * ROAD_FACTOR) * 60);
  return Number.isFinite(minutes) ? Math.max(1, minutes) : null;
}

function classify(track, etaMin){
  if (!track || track.length < 3) return 'crew';
  const speed = recentSpeedKmh(track);
  if (speed === null) return etaMin != null ? 'live' : 'crew';

  /* Below walking pace for long enough is a stall — a blocked junction, a
     breakdown, a re-route. The whole clinical value of tracking is that the
     ER learns this before the patient is late rather than after. */
  if (speed < STALL_KMH){
    const span = spanSeconds(track.slice(-Math.ceil(STALL_SECONDS / 5) - 2));
    if (span !== null && span >= STALL_SECONDS) return 'stalled';
  }
  return speed < STALL_KMH ? 'stationary' : (etaMin != null ? 'live' : 'crew');
}

function validCoordinate(value, limit){
  return (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= limit;
}

// Read-time freshness is essential: a disconnected ambulance emits no event.
function snapshot(caseCode, now = Date.now()){
  const rec = cases.get(caseCode);
  if (!rec || !rec.last_position) return { last_position: null, track: [], live_eta_minutes: null, eta_source: 'crew', distance_km: null };
  const stale = now - Date.parse(rec.last_position.at) > 30000;
  const etaUsable = !stale && rec.eta_source === 'live';
  return { last_position: rec.last_position, track: rec.track.slice(),
    live_eta_minutes: etaUsable ? rec.live_eta_minutes : null,
    eta_source: stale ? 'stale' : rec.eta_source, distance_km: rec.distance_km };
}

function get(caseCode){
  return cases.get(caseCode) || null;
}

function drop(caseCode){
  const rec = cases.get(caseCode);
  if (!rec) return null;
  // Privacy: drop raw track on resolve. Keep the aggregate only.
  const aggregate = rec.last_position ? {
    last_position: rec.last_position, live_eta_minutes: rec.live_eta_minutes, eta_source: rec.eta_source,
  } : null;
  cases.delete(caseCode);
  return aggregate;
}

module.exports = { snapshot, haversine, append, get, drop, recentSpeedKmh, computeEta, classify, spanSeconds };
