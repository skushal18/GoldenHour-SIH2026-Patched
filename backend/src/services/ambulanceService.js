/* ============================================================================
   Ambulance logins.

   Every ambulance on GoldenHour has its own login. The administrator
   registers the vehicle and gets a one-time sign-in code (shown once, stored
   as a SHA-256, valid ACTIVATION_DAYS). The crew types it into the app on the
   phone that rides in that ambulance; the phone gets a long-lived token
   (AMBULANCE_TOKEN_TTL, default 30 days) and from then on:

   * every case it sends is stamped with this vehicle (registration, unit,
     operator) — the body cannot claim another;
   * it reports the phone it runs on (model, OS, app version, screen, memory,
     battery, network, location permission) when it signs in and every few
     minutes while open;
   * the crew on shift is recorded with the vehicle.

   A new code, a disable or a sign-out bumps token_version, which voids every
   token issued before — the old phone is signed out on its next request.
   ========================================================================== */
'use strict';

const jwt = require('jsonwebtoken');
const auth = require('./authService');
const { getAmbulances } = require('../store');

const TOKEN_TTL = process.env.AMBULANCE_TOKEN_TTL || '30d';
const ONLINE_MINUTES = Number(process.env.AMBULANCE_ONLINE_MINUTES || 10);
const REG_RE = /^[A-Z0-9][A-Z0-9-]{3,19}$/;
const VEHICLE_TYPES = ['BLS', 'ALS', 'Neonatal', 'Patient transport', 'Other'];
const CREW_ROLES = ['Driver', 'EMT', 'Paramedic', 'Nurse', 'Doctor', 'Other'];
const MAX_CREW = 6;

const text = (v, max) => { if (v == null) return null; const s = String(v).trim().replace(/\s+/g, ' '); return s ? s.slice(0, max) : null; };
function normaliseRegistration(r) { return String(r || '').toUpperCase().replace(/[\s.]/g, ''); }

/* ── shapes ─────────────────────────────────────────────────────────────── */
function stateOf(a, now) {
  const t = now || Date.now();
  if (a.status === 'DISABLED') return 'DISABLED';
  if (a.status === 'PENDING') {
    if (!a.code_hash) return 'SIGNED_OUT';
    return a.code_expires_at && new Date(a.code_expires_at).getTime() <= t ? 'CODE_EXPIRED' : 'WAITING';
  }
  return 'ACTIVE';
}
function online(a, now) {
  return a.status === 'ACTIVE' && !!a.last_seen_at && (now || Date.now()) - new Date(a.last_seen_at).getTime() < ONLINE_MINUTES * 60000;
}
/** What the administrator and the app may see — never the code hash. */
function view(a) {
  if (!a) return null;
  return {
    ambulance_id: a.ambulance_id, registration: a.registration, unit_name: a.unit_name, operator: a.operator,
    vehicle_type: a.vehicle_type, base_location: a.base_location, phone: a.phone,
    status: a.status, state: stateOf(a), online: online(a),
    code_expires_at: a.status === 'PENDING' ? a.code_expires_at : null,
    paired_at: a.paired_at, last_seen_at: a.last_seen_at,
    device: a.device || null, crew: Array.isArray(a.crew) ? a.crew : [], crew_updated_at: a.crew_updated_at,
    created_by: a.created_by || null, created_at: a.created_at,
  };
}
/** The vehicle as a case carries it. */
function caseStamp(a) {
  return { ambulance_id: a.ambulance_id, registration: a.registration, unit_name: a.unit_name || null, operator: a.operator || null,
    vehicle_type: a.vehicle_type || null };
}

/* ── validation ─────────────────────────────────────────────────────────── */
function details(body, partial) {
  const b = body || {};
  const out = {};
  if (!partial || 'registration' in b) {
    const reg = normaliseRegistration(b.registration);
    if (!REG_RE.test(reg)) return { error: 'BAD_REGISTRATION', message: 'Enter the vehicle registration, like KA01AB1234 (letters, digits, dashes).' };
    out.registration = reg;
  }
  for (const [k, max] of [['unit_name', 120], ['operator', 120], ['base_location', 160], ['phone', 40]]) {
    if (!partial || k in b) out[k] = text(b[k], max);
  }
  if (!partial || 'vehicle_type' in b) {
    const t = text(b.vehicle_type, 20);
    if (t && VEHICLE_TYPES.indexOf(t) === -1) return { error: 'BAD_TYPE', message: 'Vehicle type is one of ' + VEHICLE_TYPES.join(', ') + '.' };
    out.vehicle_type = t;
  }
  return { fields: out };
}

/** The phone the app runs on, as the app reports it. Only known keys, bounded. */
function cleanDevice(d, previous) {
  const s = d && typeof d === 'object' ? d : {};
  const str = (v, n) => text(v, n || 80);
  const num = (v, lo, hi) => { const x = Number(v); return v == null || v === '' || !Number.isFinite(x) ? null : Math.min(hi, Math.max(lo, x)); };
  const out = {
    installation_id: str(s.installation_id, 64),
    platform: str(s.platform, 20), model: str(s.model), manufacturer: str(s.manufacturer),
    os: str(s.os, 30), os_version: str(s.os_version, 30), app_version: str(s.app_version, 30), webview: str(s.webview, 60),
    screen: str(s.screen, 30), memory_gb: num(s.memory_gb, 0, 64), cpu_cores: num(s.cpu_cores, 0, 64),
    battery_pct: num(s.battery_pct, 0, 100), charging: s.charging == null ? null : !!s.charging,
    network: str(s.network, 20), online: s.online == null ? null : !!s.online,
    location_permission: str(s.location_permission, 20), language: str(s.language, 20), user_agent: str(s.user_agent, 300),
  };
  /* A heartbeat without the installation id keeps the one from sign-in. */
  if (!out.installation_id && previous && previous.installation_id) out.installation_id = previous.installation_id;
  out.reported_at = new Date().toISOString();
  return out;
}

function cleanCrew(list) {
  if (!Array.isArray(list)) return { error: 'BAD_CREW', message: 'Send the crew as a list.' };
  if (list.length > MAX_CREW) return { error: 'BAD_CREW', message: 'At most ' + MAX_CREW + ' people on a crew.' };
  const crew = [];
  for (const m of list) {
    const name = text(m && m.name, 60);
    if (!name) return { error: 'BAD_CREW', message: 'Every crew member needs a name.' };
    const role = text(m.role, 20) || 'Other';
    if (CREW_ROLES.indexOf(role) === -1) return { error: 'BAD_CREW', message: 'Role is one of ' + CREW_ROLES.join(', ') + '.' };
    const phone = text(m.phone, 20);
    if (phone && !/^[+0-9 ()-]{5,20}$/.test(phone)) return { error: 'BAD_CREW', message: 'Check the phone number for ' + name + '.' };
    crew.push({ name, role, phone });
  }
  return { crew };
}

/* ── administrator actions ──────────────────────────────────────────────── */
function newCode() {
  const code = auth.generateActivationCode();
  return { code, hash: auth.hashCode(code), expires_at: new Date(Date.now() + auth.ACTIVATION_DAYS * 86_400_000).toISOString() };
}

async function create(body, actor) {
  const d = details(body, false);
  if (d.error) return { ok: false, status: 400, reason: d.error, message: d.message };
  const c = newCode();
  try {
    const a = await getAmbulances().create(Object.assign({}, d.fields, { status: 'PENDING', code_hash: c.hash, code_expires_at: c.expires_at,
      crew: [], created_by: actor ? actor.username : null }));
    return { ok: true, ambulance: view(a), sign_in_code: c.code, expires_at: c.expires_at };
  } catch (err) {
    if (err.code === 'DUPLICATE') return { ok: false, status: 409, reason: 'DUPLICATE', message: 'That vehicle is already on GoldenHour.' };
    throw err;
  }
}

async function edit(id, body) {
  const store = getAmbulances();
  if (!(await store.findById(id))) return { ok: false, status: 404, reason: 'NOT_FOUND', message: 'No such ambulance.' };
  const d = details(body, true);
  if (d.error) return { ok: false, status: 400, reason: d.error, message: d.message };
  try { return { ok: true, ambulance: view(await store.update(id, d.fields)) }; }
  catch (err) {
    if (err.code === 'DUPLICATE') return { ok: false, status: 409, reason: 'DUPLICATE', message: 'Another ambulance has that registration.' };
    throw err;
  }
}

/** A fresh sign-in code; the phone signed in now is signed out. */
async function reissueCode(id) {
  const store = getAmbulances();
  const a = await store.findById(id);
  if (!a) return { ok: false, status: 404, reason: 'NOT_FOUND', message: 'No such ambulance.' };
  const c = newCode();
  const updated = await store.update(id, { status: 'PENDING', code_hash: c.hash, code_expires_at: c.expires_at,
    token_version: (a.token_version || 0) + 1 });
  return { ok: true, ambulance: view(updated), sign_in_code: c.code, expires_at: c.expires_at };
}

async function setEnabled(id, enabled) {
  const store = getAmbulances();
  const a = await store.findById(id);
  if (!a) return { ok: false, status: 404, reason: 'NOT_FOUND', message: 'No such ambulance.' };
  /* Switching off signed the phone out (token_version moved on), so
     switching on cannot bring that phone back: the vehicle waits for a new
     sign-in code (or the one already issued, if still valid). */
  const patch = enabled
    ? { status: a.status === 'DISABLED' ? 'PENDING' : a.status }
    : { status: 'DISABLED', token_version: (a.token_version || 0) + 1 };
  return { ok: true, ambulance: view(await store.update(id, patch)) };
}

async function list() { return (await getAmbulances().list()).map(view); }

/* ── the app ────────────────────────────────────────────────────────────── */
function issueToken(a) {
  return jwt.sign({ sub: 'amb:' + a.ambulance_id, kind: 'ambulance', tv: a.token_version || 0 }, auth.secret(),
    { expiresIn: TOKEN_TTL, algorithm: 'HS256' });
}

/** Sign this phone in as the ambulance the code belongs to. Single use. */
async function pair(code, device) {
  const norm = auth.normaliseCode(code);
  if (norm.length !== 16) return { ok: false, status: 400, reason: 'INVALID_CODE', message: 'That sign-in code is not right. It has 16 letters and digits.' };
  const store = getAmbulances();
  const hash = auth.hashCode(norm);
  const a = await store.findByCodeHash(hash);
  if (!a || a.status !== 'PENDING') return { ok: false, status: 400, reason: 'INVALID_CODE', message: 'That sign-in code is not right, or it has already been used.' };
  if (!a.code_expires_at || new Date(a.code_expires_at).getTime() <= Date.now()) {
    return { ok: false, status: 410, reason: 'CODE_EXPIRED', message: 'That sign-in code has expired. Ask your GoldenHour administrator for a new one.' };
  }
  const now = new Date().toISOString();
  const updated = await store.pair(a.ambulance_id, hash, { status: 'ACTIVE', code_hash: null, code_expires_at: null,
    token_version: (a.token_version || 0) + 1, paired_at: now, last_seen_at: now, device: cleanDevice(device) });
  if (!updated) return { ok: false, status: 400, reason: 'INVALID_CODE', message: 'That sign-in code has already been used.' };
  return { ok: true, token: issueToken(updated), expires_in: TOKEN_TTL, ambulance: view(updated) };
}

/** The ambulance a token belongs to, or why not. */
async function verify(token) {
  if (!token) return { ok: false, status: 401, reason: 'AMBULANCE_SIGN_IN', message: 'Sign this ambulance in first.' };
  let claims;
  try { claims = jwt.verify(String(token), auth.secret(), { algorithms: ['HS256'] }); }
  catch (err) { return { ok: false, status: 401, reason: 'AMBULANCE_SIGN_IN', message: 'This phone was signed out. Sign the ambulance in again.' }; }
  if (claims.kind !== 'ambulance' || !/^amb:\d+$/.test(String(claims.sub))) return { ok: false, status: 401, reason: 'AMBULANCE_SIGN_IN', message: 'Sign this ambulance in first.' };
  const a = await getAmbulances().findById(String(claims.sub).slice(4));
  if (!a || (a.token_version || 0) !== (claims.tv || 0)) return { ok: false, status: 401, reason: 'AMBULANCE_SIGN_IN', message: 'This phone was signed out. Sign the ambulance in again.' };
  if (a.status === 'DISABLED') return { ok: false, status: 403, reason: 'AMBULANCE_DISABLED', message: 'This ambulance has been switched off on GoldenHour.' };
  if (a.status !== 'ACTIVE') return { ok: false, status: 401, reason: 'AMBULANCE_SIGN_IN', message: 'Sign this ambulance in again.' };
  return { ok: true, ambulance: a };
}

async function heartbeat(a, device) {
  const updated = await getAmbulances().update(a.ambulance_id, { last_seen_at: new Date().toISOString(), device: cleanDevice(device, a.device) });
  return view(updated);
}

async function setCrew(a, list) {
  const c = cleanCrew(list);
  if (c.error) return { ok: false, status: 400, reason: c.error, message: c.message };
  const updated = await getAmbulances().update(a.ambulance_id, { crew: c.crew, crew_updated_at: new Date().toISOString(), last_seen_at: new Date().toISOString() });
  return { ok: true, ambulance: view(updated) };
}

/** The crew signs this phone out: it needs a new code from the administrator. */
async function signOut(a) {
  await getAmbulances().update(a.ambulance_id, { status: 'PENDING', code_hash: null, code_expires_at: null, token_version: (a.token_version || 0) + 1 });
  return { ok: true };
}

/** Is a signed-in ambulance required to send a case? */
function required() {
  const mode = String(process.env.CREW_AUTH || '').toLowerCase();
  if (mode === 'required') return true;
  if (mode === 'optional') return false;
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

module.exports = {
  create, edit, reissueCode, setEnabled, list, pair, verify, heartbeat, setCrew, signOut, required,
  view, caseStamp, cleanDevice, cleanCrew, normaliseRegistration, stateOf,
  VEHICLE_TYPES, CREW_ROLES, MAX_CREW,
};
