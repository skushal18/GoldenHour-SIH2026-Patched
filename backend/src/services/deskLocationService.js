/* ============================================================================
   Where each hospital is, for the live map and the ETA.

   Every signed-in ER desk reports the location of the screen it runs on
   (PUT /api/v1/desk/location). That fix is the hospital end of the map, of
   the remaining distance and of the ETA for every ambulance coming to that
   hospital — the directory address is the fallback, because 40 % of the
   directory locations are only pincode or district centres.

   A desk fix is NOT used, and the directory address is, when:
     * it is rougher than DESK_MAX_ACCURACY_M (default 1000 m) — a PC on
       Wi-Fi or IP geolocation can be kilometres out;
     * it is further than DESK_MAX_DRIFT_KM (default 50 km) from the
       directory address — a VPN or a misconfigured location service, not a
       hospital that moved;
     * it is older than DESK_LOCATION_TTL_HOURS (default 12) — the desk is
       expected to report again whenever it opens.
   The reason is returned so the desk can say which one it is using and why.

   Matching (which hospitals a broadcast reaches) still uses the directory
   address: it must not depend on whether a desk happens to be open.

   Held in memory. A restart forgets the fixes; every open desk reports again
   when its socket reconnects.
   ========================================================================== */
'use strict';

const directory = require('./directoryService');

const MAX_ACCURACY_M = Number(process.env.DESK_MAX_ACCURACY_M || 1000);
const MAX_DRIFT_KM = Number(process.env.DESK_MAX_DRIFT_KM || 50);
const TTL_MS = Number(process.env.DESK_LOCATION_TTL_HOURS || 12) * 3600 * 1000;

const fixes = new Map();   // hospital_id -> { lat, lng, accuracy_m, at, received_at }

function km(a, b, c, d) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (c - a) * r, dLng = (d - b) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
const finite = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

function directoryPoint(hospitalId) {
  const h = directory.get(Number(hospitalId));
  if (!h || !finite(h.lat) || !finite(h.lng)) return null;
  return { lat: Number(h.lat), lng: Number(h.lng), coord_source: h.coord_source || null, name: h.name };
}

/** Why a desk fix cannot be used, or null when it can. */
function rejection(fix, dir) {
  if (!fix) return 'NO_DESK_FIX';
  if (Date.now() - fix.received_at > TTL_MS) return 'DESK_FIX_OLD';
  if (fix.accuracy_m != null && fix.accuracy_m > MAX_ACCURACY_M) return 'DESK_FIX_ROUGH';
  if (dir && km(dir.lat, dir.lng, fix.lat, fix.lng) > MAX_DRIFT_KM) return 'DESK_FIX_FAR';
  return null;
}

/**
 * Record a desk's location. Returns { ok, error? , location } where location is
 * what the hospital end now is (see effective()).
 */
function report(hospitalId, body) {
  const b = body || {};
  if (!finite(b.lat) || !finite(b.lng) || Math.abs(Number(b.lat)) > 90 || Math.abs(Number(b.lng)) > 180) {
    return { ok: false, error: 'INVALID_COORD', message: 'lat and lng are required' };
  }
  if (Number(b.lat) === 0 && Number(b.lng) === 0) return { ok: false, error: 'INVALID_COORD', message: '0,0 is not a location' };
  if (b.accuracy_m != null && (!finite(b.accuracy_m) || Number(b.accuracy_m) < 0)) {
    return { ok: false, error: 'INVALID_ACCURACY', message: 'accuracy_m must be a positive number' };
  }
  fixes.set(Number(hospitalId), {
    lat: Number(b.lat), lng: Number(b.lng),
    accuracy_m: b.accuracy_m == null ? null : Math.round(Number(b.accuracy_m)),
    at: new Date().toISOString(), received_at: Date.now(),
  });
  return { ok: true, location: effective(hospitalId) };
}

/**
 * The hospital end of the map and the ETA:
 * { lat, lng, source: 'desk'|'directory', accuracy_m, at, coord_source, reason }
 * or null when neither a usable desk fix nor a directory location exists.
 */
function effective(hospitalId) {
  const dir = directoryPoint(hospitalId);
  const fix = fixes.get(Number(hospitalId)) || null;
  const why = rejection(fix, dir);
  if (!why) {
    return { lat: fix.lat, lng: fix.lng, source: 'desk', accuracy_m: fix.accuracy_m, at: fix.at, coord_source: dir ? dir.coord_source : null, reason: null,
      drift_km: dir ? Math.round(km(dir.lat, dir.lng, fix.lat, fix.lng) * 100) / 100 : null };
  }
  if (!dir) return null;
  return { lat: dir.lat, lng: dir.lng, source: 'directory', accuracy_m: null, at: null, coord_source: dir.coord_source, reason: why,
    desk_accuracy_m: fix ? fix.accuracy_m : null };
}

function clear(hospitalId) { fixes.delete(Number(hospitalId)); }
function _reset() { fixes.clear(); }

module.exports = { report, effective, clear, _reset, MAX_ACCURACY_M, MAX_DRIFT_KM };
