/* ============================================================================
   Road route from the ambulance to the accepting hospital: the line to draw,
   the road distance and time, and turn-by-turn directions.

   Asked of an OSRM server (ROUTING_URL, default the public OSRM demo at
   router.project-osrm.org, which suits a pilot; for real traffic run your
   own OSRM or point ROUTING_URL at a provider). ROUTING=off switches it off.
   The server asks, not the phone: the pages' security policy lets them talk
   only to this site, and one cached answer serves every poll.

   Cached per case: a new route is fetched only when the ambulance has moved
   more than ROUTE_REFRESH_M from where the last one started, or it is older
   than ROUTE_TTL_S. Any failure returns null — the app then draws a straight
   line and the estimate it already has. A route is never invented.
   ========================================================================== */
'use strict';

const BASE = String(process.env.ROUTING_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
const ENABLED = String(process.env.ROUTING || 'on').toLowerCase() !== 'off';
const TIMEOUT_MS = Number(process.env.ROUTING_TIMEOUT_MS || 6000);
const REFRESH_M = Number(process.env.ROUTE_REFRESH_M || 250);
const TTL_S = Number(process.env.ROUTE_TTL_S || 90);

const cache = new Map();   // case_code -> { from, to, at, route }

function metres(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* OSRM maneuver → a sentence a driver can act on. */
const MOD = { left: 'left', right: 'right', 'slight left': 'slightly left', 'slight right': 'slightly right', 'sharp left': 'sharp left',
  'sharp right': 'sharp right', straight: 'straight', uturn: 'around (U-turn)' };
function instruction(step) {
  const m = step.maneuver || {}, type = m.type, mod = MOD[m.modifier] || '';
  const road = step.name ? step.name : (step.ref || '');
  const onto = road ? ' onto ' + road : '';
  if (m.modifier === 'uturn' && type !== 'depart' && type !== 'arrive') return 'Make a U-turn' + onto;
  switch (type) {
    case 'depart': return 'Head ' + (m.bearing_after != null ? compass(m.bearing_after) : 'off') + (road ? ' on ' + road : '');
    case 'arrive': return 'Arrive at the hospital' + (mod && mod !== 'straight' ? ', on your ' + m.modifier.replace('slight ', '') : '');
    case 'turn': case 'end of road': return (mod === 'straight' ? 'Continue straight' : 'Turn ' + mod) + onto;
    case 'new name': case 'continue': return 'Continue' + (mod && mod !== 'straight' ? ' ' + mod : '') + onto;
    case 'merge': return 'Merge' + (mod ? ' ' + mod.replace('slightly ', '') : '') + onto;
    case 'on ramp': return 'Take the ramp' + (mod ? ' on the ' + m.modifier.replace('slight ', '') : '') + onto;
    case 'off ramp': return 'Take the exit' + (mod ? ' on the ' + m.modifier.replace('slight ', '') : '') + onto;
    case 'fork': return 'Keep ' + (m.modifier && m.modifier.indexOf('left') !== -1 ? 'left' : 'right') + ' at the fork' + onto;
    case 'roundabout': case 'rotary': return 'At the roundabout, take exit ' + (m.exit || 1) + onto;
    case 'exit roundabout': case 'exit rotary': return 'Leave the roundabout' + onto;
    default: return (mod ? 'Go ' + mod : 'Continue') + onto;
  }
}
function compass(b) { return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((b % 360) + 360) % 360 / 45) % 8]; }

async function fetchRoute(from, to) {
  const url = BASE + '/route/v1/driving/' + from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat +
    '?overview=full&geometries=geojson&steps=true&alternatives=false';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'GoldenHour/7 (ambulance pre-arrival)' } });
    if (!res.ok) return null;
    const body = await res.json();
    const r = body && body.code === 'Ok' && body.routes && body.routes[0];
    if (!r || !r.geometry || !Array.isArray(r.geometry.coordinates)) return null;
    const steps = [];
    for (const leg of r.legs || []) for (const s of leg.steps || []) {
      if (!s.maneuver) continue;
      steps.push({ instruction: instruction(s), distance_m: Math.round(s.distance || 0), duration_s: Math.round(s.duration || 0),
        road: s.name || null, type: s.maneuver.type, modifier: s.maneuver.modifier || null,
        at: Array.isArray(s.maneuver.location) ? { lat: s.maneuver.location[1], lng: s.maneuver.location[0] } : null });
    }
    return {
      distance_m: Math.round(r.distance), duration_s: Math.round(r.duration),
      geometry: r.geometry.coordinates.map(c => [Math.round(c[1] * 1e5) / 1e5, Math.round(c[0] * 1e5) / 1e5]),
      steps, source: 'osrm', from, to, fetched_at: new Date().toISOString(),
    };
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}

/** The route for a case from `from` to `to`, cached; null when unavailable. */
async function routeFor(caseCode, from, to) {
  if (!ENABLED || !from || !to || from.lat == null || to.lat == null) return null;
  const hit = cache.get(caseCode);
  const fresh = hit && Date.now() - hit.at < TTL_S * 1000 && metres(hit.from, from) < REFRESH_M && metres(hit.to, to) < 50;
  if (fresh) return hit.route;
  const route = await fetchRoute(from, to);
  if (route) cache.set(caseCode, { from, to, at: Date.now(), route });
  else if (hit) return hit.route;          // keep the last good one rather than nothing
  return route;
}

function drop(caseCode) { cache.delete(caseCode); }

module.exports = { routeFor, drop, instruction, ENABLED, BASE };
