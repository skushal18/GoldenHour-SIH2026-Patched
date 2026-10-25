/* ============================================================================
   capacityService — each hospital's own capacity strip.

   Kept in memory for speed and, when MySQL is live, written through to
   hospital_capacity and reloaded at boot — capacity used to vanish on every
   restart, leaving every desk "unknown" until a nurse touched it again.

   An update is a PATCH: a field the desk did not send keeps its previous
   value. diversion_active used to reset to false whenever an update left it
   out, silently taking a diverting hospital off diversion.
   ========================================================================== */
'use strict';

const caps = new Map();
let listeners = [];
let pool = null;

const COUNTS = ['resus_bays_available', 'ventilators_available'];
const FLAGS = ['ct_available', 'ot_available', 'blood_available', 'cathlab_available', 'diversion_active'];
const DEFAULT_FLAG = { ct_available: true, ot_available: true, blood_available: true, cathlab_available: true, diversion_active: false };

function nowIso() { return new Date().toISOString(); }

function get(hospitalId) { return caps.get(Number(hospitalId)) || null; }
function all() { return Array.from(caps.entries()).map(([id, c]) => Object.assign({ hospital_id: id }, c)); }

/** Returns { ok:true, capacity } or { ok:false, message }. */
function validate(patch) {
  const p = patch || {};
  for (const k of COUNTS) {
    if (!(k in p)) continue;
    const n = Number(p[k]);
    if (!Number.isInteger(n) || n < 0 || n > 500) return { ok: false, field: k, message: k + ' must be a whole number from 0 to 500' };
  }
  for (const k of FLAGS) {
    if (!(k in p)) continue;
    if (typeof p[k] !== 'boolean' && p[k] !== 0 && p[k] !== 1) return { ok: false, field: k, message: k + ' must be true or false' };
  }
  return { ok: true };
}

function upsert(hospitalId, patch) {
  const v = validate(patch);
  if (!v.ok) return Object.assign({ error: true }, v);
  const id = Number(hospitalId);
  const prev = caps.get(id) || {};
  const p = patch || {};
  const next = {};
  for (const k of COUNTS) next[k] = k in p ? Number(p[k]) : (prev[k] == null ? 0 : prev[k]);
  for (const k of FLAGS) next[k] = k in p ? !!p[k] : (prev[k] == null ? DEFAULT_FLAG[k] : prev[k]);
  next.updated_at = nowIso();
  caps.set(id, next);
  persist(id, next);
  emit('capacity:changed', { hospital_id: id, capacity: next, at: next.updated_at });
  return next;
}

function persist(id, c) {
  if (!pool) return;
  pool.query(
    'INSERT INTO hospital_capacity (hospital_id, resus_bays_available, ventilators_available, ct_available, ot_available, blood_available, cathlab_available, diversion_active, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ' +
    'ON DUPLICATE KEY UPDATE resus_bays_available=VALUES(resus_bays_available), ventilators_available=VALUES(ventilators_available), ct_available=VALUES(ct_available), ot_available=VALUES(ot_available), blood_available=VALUES(blood_available), cathlab_available=VALUES(cathlab_available), diversion_active=VALUES(diversion_active), updated_at=VALUES(updated_at)',
    [id, c.resus_bays_available, c.ventilators_available, c.ct_available ? 1 : 0, c.ot_available ? 1 : 0, c.blood_available ? 1 : 0,
      c.cathlab_available ? 1 : 0, c.diversion_active ? 1 : 0, new Date(c.updated_at)])
    .catch(err => console.warn('⚠️  capacity persist failed (non-fatal):', err.message));
}

async function attachPersistence(mysqlPool) {
  pool = mysqlPool;
  try {
    const [rows] = await pool.query('SELECT * FROM hospital_capacity');
    for (const r of rows) {
      caps.set(Number(r.hospital_id), {
        resus_bays_available: Number(r.resus_bays_available), ventilators_available: Number(r.ventilators_available),
        ct_available: !!r.ct_available, ot_available: !!r.ot_available, blood_available: !!r.blood_available,
        cathlab_available: !!r.cathlab_available, diversion_active: !!r.diversion_active,
        updated_at: (r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at)).toISOString(),
      });
    }
    return rows.length;
  } catch (err) { console.warn('⚠️  could not load capacity:', err.message); return 0; }
}

function emit(evt, payload) { for (const l of listeners) { try { l(evt, payload); } catch (_) { } } }
function onListener(fn) { listeners.push(fn); }
function clearListeners() { listeners = []; }
function reset() { caps.clear(); pool = null; }

function minutesSince(updatedAt) {
  if (!updatedAt) return Infinity;
  const t = new Date(updatedAt).getTime();
  return isNaN(t) ? Infinity : (Date.now() - t) / 60000;
}

module.exports = { get, all, upsert, validate, onListener, clearListeners, minutesSince, attachPersistence, reset };
