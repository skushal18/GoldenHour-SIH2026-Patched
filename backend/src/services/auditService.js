/* ============================================================================
   auditService — Part V §4.15.

   Append-only timeline. NEVER fails an operation. POSITION is throttled to
   one row per 60 s. Strings, not parsed SQL — the in-memory store is the
   default for a hackathon demo.
   ========================================================================== */
'use strict';

const POSITION_INTERVAL_MS = Number(process.env.AUDIT_POSITION_INTERVAL_MS || 60000);
const RETENTION_DAYS = Number(process.env.ANALYTICS_RETENTION_DAYS || 90);

const events = [];    // append-only (memory store); by case_code
let lastPosition = new Map();

function nowIso(){ return new Date().toISOString(); }

function record(caseCode, eventType, data, actor){
  try {
    if (eventType === 'POSITION') {
      const prev = lastPosition.get(caseCode);
      const t = Date.now();
      if (prev && (t - prev) < POSITION_INTERVAL_MS) return;
      lastPosition.set(caseCode, t);
    }
    events.push({
      case_code: caseCode,
      event_type: eventType,
      event_data: data || {},
      performed_by: actor && actor.user_id ? actor.user_id : (actor && actor.hospital_id ? `desk:${actor.hospital_id}` : (actor && actor.kind ? actor.kind : 'system')),
      performed_at: nowIso(),
    });
    prune();
  } catch (err) {
    console.warn('⚠️  audit write failed (non-fatal):', err.message);
  }
}

function list(caseCode){
  return events.filter(e => e.case_code === caseCode);
}

function all(){
  return events.slice();
}

function prune(){
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  for (let i = events.length - 1; i >= 0; i--){
    const t = new Date(events[i].performed_at).getTime();
    if (!isNaN(t) && t < cutoff) events.splice(i, 1);
  }
}

function reset(){ events.length = 0; lastPosition.clear(); }

module.exports = { record, list, all, reset };
