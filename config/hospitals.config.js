/* ============================================================================
   GoldenHour — HACKATHON HARDWIRE
   ----------------------------------------------------------------------------
   ★★★  THIS IS THE ONLY FILE YOU NEED TO EDIT FOR THE INTERNAL HACKATHON  ★★★

   Two laptops stand in for two hospitals. Each laptop is identified by its
   LAN IP address. When the ambulance app broadcasts a request, the server
   pushes it to BOTH laptops at once. The first laptop to press Accept claims
   the case, and the request instantly disappears from the other laptop.

   HOW TO FIND A LAPTOP'S IP
     Windows :  ipconfig            → "IPv4 Address" of the Wi-Fi adapter
     macOS   :  ipconfig getifaddr en0
     Linux   :  hostname -I

   All three machines (server + 2 laptops) must be on the SAME Wi-Fi network.

   After the hackathon: set HACKATHON_MODE to false and register real
   hospitals in the database — nothing else in the codebase has to change.
   ========================================================================== */

'use strict';

/* ── 1 ▸ THE TWO LAPTOPS ─────────────────────────────────────────────────── */

const HOSPITAL_LAPTOPS = [
  {
    hospital_id: 1,
    code: 'HOSP-A',
    ip: '192.168.1.101',                     // ←←← EDIT ME: laptop #1 IP
    name: 'City Emergency Hospital',
    address: 'MG Road, Bengaluru',
    lat: 12.9716,
    lng: 77.5946,
    contact: '+918012345678',
    accent: '#25CED1'
  },
  {
    hospital_id: 2,
    code: 'HOSP-B',
    ip: '192.168.1.102',                     // ←←← EDIT ME: laptop #2 IP
    name: 'Apollo Hospital',
    address: 'Bannerghatta Road, Bengaluru',
    lat: 12.9121,
    lng: 77.5956,
    contact: '+918087654321',
    accent: '#FF8A5B'
  }
];

/* ── 2 ▸ DEMO BEHAVIOUR SWITCHES ─────────────────────────────────────────── */

const HACKATHON_MODE = true;
/*  true  → every broadcast goes to BOTH laptops above, whatever the GPS
            distance or the radius slider says. This is what you want on
            demo day: the judges' room is not 15 km from a real hospital,
            and a demo that silently notifies nobody is a dead demo.
    false → normal behaviour: hospitals are pulled from the database and
            filtered by Haversine distance against the broadcast radius.  */

const ALLOW_MANUAL_HOSPITAL_OVERRIDE = true;
/*  true  → a dashboard may force its identity with ?hospital=1 / ?hospital=2.
            Keep this on. It is the escape hatch for the two situations that
            bite at every hackathon: (a) both dashboards opened on the same
            machine while rehearsing, (b) the router handed a laptop a
            different IP than the one written above.                        */

const FALLBACK_HOSPITAL_ID = 1;
/*  Identity used when the caller's IP is unknown AND no override was given. */

const ACCEPT_WINDOW_SECONDS = 300;
/*  A broadcast nobody accepts within this many seconds becomes EXPIRED.     */

/* ── 3 ▸ HELPERS (no need to edit below this line) ───────────────────────── */

/** 127.0.0.1 / ::1 / ::ffff:192.168.1.5 → a plain dotted-quad. */
function normaliseIp(raw) {
  if (!raw) return '';
  let ip = String(raw).trim();
  if (ip.indexOf(',') !== -1) ip = ip.split(',')[0].trim();   // x-forwarded-for
  if (ip.indexOf('::ffff:') === 0) ip = ip.slice(7);          // IPv4-mapped IPv6
  if (ip === '::1') ip = '127.0.0.1';
  const port = ip.lastIndexOf(':');
  if (port !== -1 && ip.indexOf(':') === port) ip = ip.slice(0, port);
  return ip;
}

function byId(hospitalId) {
  const n = Number(hospitalId);
  return HOSPITAL_LAPTOPS.find(h => h.hospital_id === n) || null;
}

function byIp(rawIp) {
  const ip = normaliseIp(rawIp);
  if (!ip) return null;
  return HOSPITAL_LAPTOPS.find(h => normaliseIp(h.ip) === ip) || null;
}

/**
 * Work out which hospital a request is coming from.
 * Order: explicit ?hospital= override → hardcoded IP map → fallback.
 * Always returns a hospital plus how it was decided, so the dashboard can
 * tell the operator "I recognised your IP" vs "I guessed".
 */
function resolveHospital(rawIp, overrideId) {
  if (ALLOW_MANUAL_HOSPITAL_OVERRIDE && overrideId !== undefined && overrideId !== null && overrideId !== '') {
    const forced = byId(overrideId);
    if (forced) return { hospital: forced, matchedBy: 'override', ip: normaliseIp(rawIp) };
  }
  const matched = byIp(rawIp);
  if (matched) return { hospital: matched, matchedBy: 'ip', ip: normaliseIp(rawIp) };
  return { hospital: byId(FALLBACK_HOSPITAL_ID) || HOSPITAL_LAPTOPS[0], matchedBy: 'fallback', ip: normaliseIp(rawIp) };
}

module.exports = {
  HOSPITAL_LAPTOPS,
  HACKATHON_MODE,
  ALLOW_MANUAL_HOSPITAL_OVERRIDE,
  FALLBACK_HOSPITAL_ID,
  ACCEPT_WINDOW_SECONDS,
  normaliseIp,
  byId,
  byIp,
  resolveHospital
};
