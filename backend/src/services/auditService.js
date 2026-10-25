/* ============================================================================
   auditService — append-only case timeline and account audit trail.

   NEVER fails an operation. POSITION rows are throttled to one per 60 s per
   case. Events are kept in memory for the timeline and analytics, and when
   MySQL is live every event is also written to case_events and the last
   ANALYTICS_RETENTION_DAYS are loaded back at boot — so analytics and case
   timelines survive a restart instead of silently resetting to zero.

   Pseudo case codes: 'AUTH' (sign-ins), 'ADMIN' (account changes),
   'CAPACITY' (capacity changes). Analytics only counts real cases.
   ========================================================================== */
'use strict';

const POSITION_INTERVAL_MS = Number(process.env.AUDIT_POSITION_INTERVAL_MS || 60000);
const RETENTION_DAYS = Number(process.env.ANALYTICS_RETENTION_DAYS || 90);
const MAX_IN_MEMORY = 50000;
const PSEUDO = new Set(['AUTH', 'ADMIN', 'CAPACITY']);

const events = [];
const lastPosition = new Map();
let pool = null;

function nowIso() { return new Date().toISOString(); }

function actorOf(actor) {
  if (!actor) return 'system';
  if (actor.user_id) return String(actor.user_id);
  if (actor.hospital_id) return 'desk:' + actor.hospital_id;
  return actor.kind || 'system';
}

function record(caseCode, eventType, data, actor) {
  try {
    if (eventType === 'POSITION') {
      const prev = lastPosition.get(caseCode);
      const t = Date.now();
      if (prev && (t - prev) < POSITION_INTERVAL_MS) return;
      lastPosition.set(caseCode, t);
    }
    const evt = { case_code: caseCode, event_type: eventType, event_data: data || {}, performed_by: actorOf(actor), performed_at: nowIso() };
    events.push(evt);
    if (events.length > MAX_IN_MEMORY) events.splice(0, events.length - MAX_IN_MEMORY);
    prune();
    if (pool) {
      pool.query('INSERT INTO case_events (case_code, event_type, event_data, actor, performed_at) VALUES (?,?,?,?,?)',
        [String(caseCode).slice(0, 20), String(eventType).slice(0, 40), JSON.stringify(evt.event_data), evt.performed_by.slice(0, 64), new Date(evt.performed_at)])
        .catch(err => console.warn('⚠️  audit persist failed (non-fatal):', err.message));
    }
  } catch (err) {
    console.warn('⚠️  audit write failed (non-fatal):', err.message);
  }
}

function list(caseCode) { return events.filter(e => e.case_code === caseCode); }
function all() { return events.slice(); }
function caseEvents() { return events.filter(e => !PSEUDO.has(e.case_code)); }

function prune() {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  let i = 0;
  while (i < events.length && new Date(events[i].performed_at).getTime() < cutoff) i++;
  if (i) events.splice(0, i);
}

/** Called once MySQL is live: load recent history, then write through. */
async function attachPersistence(mysqlPool) {
  pool = mysqlPool;
  try {
    const [rows] = await pool.query(
      'SELECT case_code, event_type, event_data, actor, performed_at FROM case_events WHERE performed_at >= ? ORDER BY performed_at ASC LIMIT ?',
      [new Date(Date.now() - RETENTION_DAYS * 86_400_000), MAX_IN_MEMORY]);
    for (const r of rows) {
      let data = r.event_data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { data = {}; } }
      events.push({ case_code: r.case_code, event_type: r.event_type, event_data: data || {}, performed_by: r.actor,
        performed_at: (r.performed_at instanceof Date ? r.performed_at : new Date(r.performed_at)).toISOString() });
    }
    return rows.length;
  } catch (err) {
    console.warn('⚠️  could not load audit history:', err.message);
    return 0;
  }
}

function reset() { events.length = 0; lastPosition.clear(); pool = null; }

module.exports = { record, list, all, caseEvents, attachPersistence, reset, PSEUDO };
