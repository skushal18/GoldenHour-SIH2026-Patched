/* ============================================================================
   In-memory broadcast store.

   Zero setup: no MySQL, no schema, no root password. The server falls back to
   this automatically when it cannot reach MySQL, which means a demo can never
   die because someone forgot to start a database service on the morning of
   the hackathon. Everything is lost on restart — that is the trade.

   Node runs one broadcast at a time on a single thread, so "atomic
   first-accept-wins" here is simply a synchronous check-and-set. No two
   hospitals can interleave inside claim().
   ========================================================================== */

'use strict';

function nowIso() { return new Date().toISOString(); }

function createMemoryStore() {
  const broadcasts = new Map();      // case_code → record
  let counter = 0;

  return {
    driver: 'memory',

    async init() { return { driver: 'memory' }; },

    async nextCaseCode() {
      /* The counter restarts with the process, so skip past anything that
         somehow already exists rather than overwriting a live broadcast. */
      const year = new Date().getFullYear();
      let code;
      do {
        counter += 1;
        code = `GH-${year}-${String(counter).padStart(4, '0')}`;
      } while (broadcasts.has(code));
      return code;
    },

    async insertBroadcast(record) {
      broadcasts.set(record.case_code, record);
      return record;
    },

    async getBroadcast(caseCode) {
      return broadcasts.get(caseCode) || null;
    },

    async listForHospital(hospitalId, options) {
      const opts = options || {};
      const id = Number(hospitalId);
      const out = [];
      for (const record of broadcasts.values()) {
          const target = record.targets.find(t => t.hospital_id === id);
          if (!target) continue;
          /* A case claimed by another hospital must never be returned, even
             from the resolved-history endpoint. */
          if (record.accepted_hospital_id &&
              Number(record.accepted_hospital_id) !== id) continue;
          if (!opts.includeResolved && record.status === 'ARRIVED') continue;
          if (!opts.includeResolved && target.status === 'DECLINED') continue;
          out.push(record);
      }
      return out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },

    async listAll(limit) {
      const all = Array.from(broadcasts.values())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return limit ? all.slice(0, limit) : all;
    },

    /* ── The one operation that has to be exactly right ──────────────────
       Two laptops can press Accept in the same second. Exactly one wins,
       and the loser is told who beat them.                                */
    async claim(caseCode, hospitalId) {
      const id = Number(hospitalId);
      const record = broadcasts.get(caseCode);
      if (!record) return { ok: false, reason: 'NOT_FOUND', record: null };

      const target = record.targets.find(t => t.hospital_id === id);
      if (!target) return { ok: false, reason: 'NOT_TARGETED', record };

      if (record.status === 'ACCEPTED') {
        return { ok: false, reason: 'ALREADY_ACCEPTED', record };
      }
      if (record.status !== 'PENDING') {
        return { ok: false, reason: record.status, record };
      }

      record.status = 'ACCEPTED';
      record.accepted_hospital_id = id;
      record.accepted_at = nowIso();
      record.targets.forEach(t => { t.status = t.hospital_id === id ? 'ACCEPTED' : 'CANCELLED'; });
      return { ok: true, record };
    },

    async decline(caseCode, hospitalId) {
      const id = Number(hospitalId);
      const record = broadcasts.get(caseCode);
      if (!record) return { ok: false, reason: 'NOT_FOUND', record: null };
      const target = record.targets.find(t => t.hospital_id === id);
      if (!target) return { ok: false, reason: 'NOT_TARGETED', record };
      if (target.status === 'PENDING') target.status = 'DECLINED';

      const anyLeft = record.targets.some(t => t.status === 'PENDING');
      if (!anyLeft && record.status === 'PENDING') record.status = 'REJECTED';
      return { ok: true, record };
    },

    async cancel(caseCode) {
      const record = broadcasts.get(caseCode);
      if (!record) return { ok: false, reason: 'NOT_FOUND', record: null };
      if (record.status === 'PENDING') {
        record.status = 'CANCELLED';
        record.targets.forEach(t => { if (t.status === 'PENDING') t.status = 'CANCELLED'; });
      }
      return { ok: true, record };
    },

    async expireOverdue() {
      const now = Date.now();
      const expired = [];
      for (const record of broadcasts.values()) {
        if (record.status !== 'PENDING') continue;
        if (!record.expires_at) continue;
        if (new Date(record.expires_at).getTime() > now) continue;
        record.status = 'EXPIRED';
        record.targets.forEach(t => { if (t.status === 'PENDING') t.status = 'EXPIRED'; });
        expired.push(record);
      }
      return expired;
    },

    async reset() { broadcasts.clear(); counter = 0; },

    /* ── Patient edit (transport-only flow) ──────────────────────────────
       Memory store: just an object reassignment. Caller has already validated
       the patch; we still gate on the case's current status. */
    async updatePatientFields(caseCode, patch) {
      const record = broadcasts.get(caseCode);
      if (!record) return { ok: false, reason: 'NOT_FOUND' };
      if (record.status !== 'ACCEPTED' || record.arrived_at) return { ok: false, reason: 'NOT_ACTIVE' };

      record.patient = patch.patient || record.patient || {};
      if ('notes' in patch) record.notes = patch.notes;
      if ('last_patient_updated_at' in patch) record.last_patient_updated_at = patch.last_patient_updated_at;
      return { ok: true, record };
    },

    /* ── Arrival: one-way transition ACCEPTED -> ARRIVED ───────────────── */
    async markArrived(caseCode) {
      const record = broadcasts.get(caseCode);
      if (!record) return { ok: false, reason: 'NOT_FOUND' };
      if (record.status === 'ARRIVED') return { ok: true, record, already: true };
      if (record.status !== 'ACCEPTED') return { ok: false, reason: 'NOT_ACCEPTED' };

      const arrivedAt = new Date().toISOString();
      record.status = 'ARRIVED';
      record.arrived_at = arrivedAt;
      record.targets.forEach(t => { if (t.status === 'ACCEPTED') t.status = 'CLOSED'; });
      return { ok: true, record };
    }
  };
}

module.exports = { createMemoryStore };
