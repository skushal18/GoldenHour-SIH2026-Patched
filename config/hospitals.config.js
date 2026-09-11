/* Hackathon laptop map. In production the same demo code accepts the JWT
   identity from authRoutes — this file only matters while DESK_AUTH != 'jwt'. */
'use strict';
const LAPTOPS = [
  { hospital_id: 1, code: 'CITY_ER',     ip: '127.0.0.1', name: 'City Emergency Hospital', accent: '#25CED1', lat: 12.9716, lng: 77.5946, contact: '080-12345678' },
  { hospital_id: 2, code: 'APOLLO_ER',   ip: '127.0.0.1', name: 'Apollo Hospital',          accent: '#FF8A5B', lat: 12.9121, lng: 77.5956, contact: '080-87654321' },
];
const BY_ID = LAPTOPS.reduce((m, h) => (m[h.hospital_id] = h, m), {});

function byId(id){ return BY_ID[Number(id)] || null; }
function normaliseIp(ip){
  if (!ip) return '';
  let s = String(ip).trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}
/* The demo override can be switched off for a hardened LAN deployment. In
   production DESK_AUTH=jwt is what actually decides identity and this
   function is never consulted at all. */
function overrideAllowed(){
  return String(process.env.ALLOW_MANUAL_HOSPITAL_OVERRIDE || 'true').toLowerCase() !== 'false';
}

/**
 * Which hospital is this desk?
 *
 * An explicit statement of identity — ?hospital=2, or the X-Hospital-Id
 * header — beats a guess made from the network address. That order matters:
 * IP was checked first, and because both demo laptops can legitimately carry
 * 127.0.0.1 (two browser windows on the same machine, which is how the demo
 * is usually rehearsed), the first entry always won and hospital 2 was
 * unreachable. Every "one hospital wins the race" and "the losing desk is
 * cleared" behaviour in the system silently collapsed to a single desk.
 *
 * The IP is still trusted, but only when it names exactly one hospital.
 */
function resolveHospital(ip, override){
  if (overrideAllowed() && override !== undefined && override !== null && override !== ''){
    const configured = BY_ID[Number(override)];
    if (configured) return { hospital: configured, matchedBy: 'override' };
  }
  const matches = LAPTOPS.filter(h => h.ip && h.ip === ip);
  if (matches.length === 1) return { hospital: matches[0], matchedBy: 'ip' };

  const fallback = LAPTOPS[0] || null;
  return { hospital: fallback, matchedBy: matches.length > 1 ? 'ambiguous-ip' : 'fallback' };
}

module.exports = {
  HACKATHON_MODE: process.env.HACKATHON_MODE !== 'false',  // default ON for the demo
  ACCEPT_WINDOW_SECONDS: Number(process.env.ACCEPT_WINDOW_SECONDS || 180),
  HOSPITAL_LAPTOPS: LAPTOPS,
  byId, normaliseIp, resolveHospital,
};
