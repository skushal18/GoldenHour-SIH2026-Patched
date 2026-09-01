/* ============================================================================
   MySQL broadcast store.

   Two tables carry the hackathon flow:

     broadcasts         one row per Broadcast Request
     broadcast_targets  one row per hospital that was alerted

   First-accept-wins is a single conditional UPDATE:

     UPDATE broadcasts SET status='ACCEPTED', ... WHERE case_code=? AND status='PENDING'

   If affectedRows is 0 somebody else already won. Two laptops pressing Accept
   in the same millisecond therefore cannot both succeed — the database, not
   the application, decides the winner. The whole claim runs inside a
   transaction with the row locked by that UPDATE.

   The legacy relational tables (cases, case_clinical_data, critical_flags,
   activity_events) are ALSO written, best-effort, so the rest of the original
   backend keeps working. A failure there is logged and swallowed: it must
   never take down a live broadcast.
   ========================================================================== */

'use strict';

const { PRIORITY_TO_DB } = require('../services/triage');

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function createMysqlStore(pool) {
  /** DB rows → the same record shape the memory store returns. */
  function hydrate(row, targetRows) {
    const snapshot = parseJson(row.payload, {});
    return {
      case_code: row.case_code,
      case_id: row.legacy_case_id || null,
      status: row.status,
      priority: row.priority,
      created_at: toIso(row.created_at),
      expires_at: toIso(row.expires_at),
      accepted_hospital_id: row.accepted_hospital_id || null,
      accepted_at: toIso(row.accepted_at),
      arrived_at: toIso(row.arrived_at),
      ...snapshot,
      targets: (targetRows || []).map(t => ({
        hospital_id: t.hospital_id,
        name: t.hospital_name,
        contact: t.hospital_contact,
        lat: t.hospital_lat === null ? null : Number(t.hospital_lat),
        lng: t.hospital_lng === null ? null : Number(t.hospital_lng),
        distance_km: t.distance_km === null ? null : Number(t.distance_km),
        status: t.status
      }))
    };
  }

  async function loadTargets(conn, caseCode) {
    const [rows] = await conn.query(
      'SELECT * FROM broadcast_targets WHERE case_code = ? ORDER BY distance_km IS NULL, distance_km ASC, hospital_id ASC',
      [caseCode]
    );
    return rows;
  }

  async function loadOne(conn, caseCode) {
    const [rows] = await conn.query('SELECT * FROM broadcasts WHERE case_code = ?', [caseCode]);
    if (rows.length === 0) return null;
    return hydrate(rows[0], await loadTargets(conn, caseCode));
  }

  /* Mirror into the original relational tables. Never fatal. */
  async function mirrorLegacyCase(record) {
    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const patient = record.patient || {};
        const vitals = patient.vitals || {};
        const flags = record.critical_flags || {};
        const destination = record.targets && record.targets.length ? record.targets[0].hospital_id : 1;

        let ambulanceRowId = 1;
        if (record.ambulance_id) {
          const [amb] = await conn.query(
            'SELECT ambulance_id FROM ambulances WHERE registration_number = ?',
            [record.ambulance_id]
          );
          if (amb.length) ambulanceRowId = amb[0].ambulance_id;
        }

        const [result] = await conn.query(
          `INSERT INTO cases
             (case_code, ambulance_id, destination_hospital_id, priority, age_band, sex,
              chief_complaint, eta_minutes, latitude, longitude, created_by, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENT')`,
          [
            record.case_code, ambulanceRowId, destination,
            PRIORITY_TO_DB[record.priority] || 'HIGH',
            patient.age === null || patient.age === undefined ? 'UNKNOWN' : String(patient.age),
            patient.gender === 'M' ? 'M' : patient.gender === 'F' ? 'F' : 'OTHER',
            record.chief_complaint || 'Emergency',
            record.eta_minutes || null,
            record.origin ? record.origin.lat : null,
            record.origin ? record.origin.lng : null,
            1
          ]
        );
        const legacyId = result.insertId;

        await conn.query(
          `INSERT INTO case_clinical_data (case_id, age, signs_symptoms, treatment_given, gcs, spo2, bp, pulse)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            legacyId,
            patient.age === null || patient.age === undefined ? null : String(patient.age),
            patient.consciousness || null,
            record.stroke_assessment
              ? `FAST: face=${record.stroke_assessment.face}, arm=${record.stroke_assessment.arm}, ` +
                `speech=${record.stroke_assessment.speech}, onset=${record.stroke_assessment.onset_hours}h`
              : null,
            null,
            vitals.spo2 === undefined ? null : vitals.spo2,
            vitals.systolic_bp !== null && vitals.systolic_bp !== undefined &&
            vitals.diastolic_bp !== null && vitals.diastolic_bp !== undefined
              ? `${vitals.systolic_bp}/${vitals.diastolic_bp}` : null,
            vitals.heart_rate === undefined ? null : vitals.heart_rate
          ]
        );

        await conn.query(
          `INSERT INTO critical_flags (case_id, shock, hypoxia, low_gcs, cardiac_arrest, airway_compromise)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [legacyId, !!flags.shock, !!flags.hypoxia, !!flags.low_gcs, !!flags.cardiac_arrest, !!flags.airway_compromise]
        );

        await conn.query(
          'INSERT INTO activity_events (case_id, event_type, event_data) VALUES (?, ?, ?)',
          [legacyId, 'ALERT_SENT', JSON.stringify({
            case_code: record.case_code,
            priority: record.priority,
            hospitals_notified: record.targets.length
          })]
        );

        await conn.query('UPDATE broadcasts SET legacy_case_id = ? WHERE case_code = ?', [legacyId, record.case_code]);
        await conn.commit();
        record.case_id = legacyId;
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.warn('⚠️  legacy case mirror skipped:', err.message);
    }
  }

  async function mirrorLegacyStatus(record, status, eventType) {
    if (!record.case_id) return;
    try {
      await pool.query('UPDATE cases SET status = ? WHERE case_id = ?', [status, record.case_id]);
      await pool.query(
        'INSERT INTO activity_events (case_id, event_type, event_data) VALUES (?, ?, ?)',
        [record.case_id, eventType, JSON.stringify({
          case_code: record.case_code,
          accepted_hospital_id: record.accepted_hospital_id || null
        })]
      );
      if (record.accepted_hospital_id) {
        await pool.query(
          'UPDATE cases SET destination_hospital_id = ? WHERE case_id = ?',
          [record.accepted_hospital_id, record.case_id]
        );
      }
    } catch (err) {
      console.warn('⚠️  legacy status mirror skipped:', err.message);
    }
  }

  return {
    driver: 'mysql',

    async init() {
      const conn = await pool.getConnection();
      conn.release();
      return { driver: 'mysql' };
    },

    async nextCaseCode() {
      /* COUNT+1 is not a sequence: delete a row, or insert concurrently, and
         it hands out a code that is already taken — which would fail on the
         primary key mid-broadcast. Step forward until one is free. */
      const year = new Date().getFullYear();
      const [rows] = await pool.query(
        'SELECT COUNT(*) AS n FROM broadcasts WHERE YEAR(created_at) = ?', [year]
      );
      let n = Number(rows[0].n) + 1;
      for (let attempt = 0; attempt < 50; attempt++) {
        const code = `GH-${year}-${String(n).padStart(4, '0')}`;
        const [clash] = await pool.query('SELECT case_code FROM broadcasts WHERE case_code = ?', [code]);
        if (clash.length === 0) return code;
        n += 1;
      }
      throw new Error('Could not allocate a free case code');
    },

    async insertBroadcast(record) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        const { targets, ...snapshot } = record;
        delete snapshot.status;
        delete snapshot.priority;
        delete snapshot.created_at;
        delete snapshot.expires_at;
        delete snapshot.accepted_hospital_id;
        delete snapshot.accepted_at;
        delete snapshot.case_id;

        await conn.query(
          `INSERT INTO broadcasts (case_code, status, priority, payload, expires_at)
           VALUES (?, 'PENDING', ?, ?, ?)`,
          [record.case_code, record.priority, JSON.stringify(snapshot), new Date(record.expires_at)]
        );

        /* record.arrived_at may be set in memory after insert for symmetry with hydrate,
           but the row did not exist when this method returned, so safe to clear it. */
        delete snapshot.arrived_at;
        delete snapshot.last_patient_updated_at;

        for (const t of targets) {
          await conn.query(
            `INSERT INTO broadcast_targets
               (case_code, hospital_id, hospital_name, hospital_contact, hospital_lat, hospital_lng, distance_km, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
            [record.case_code, t.hospital_id, t.name, t.contact || null, t.lat, t.lng, t.distance_km]
          );
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        conn.release();
        throw err;
      }
      conn.release();

      await mirrorLegacyCase(record);
      return record;
    },

    async getBroadcast(caseCode) {
      return loadOne(pool, caseCode);
    },

    async listForHospital(hospitalId, options) {
      const opts = options || {};
      const [rows] = await pool.query(
        `SELECT b.*, t.status AS target_status
           FROM broadcasts b
           JOIN broadcast_targets t ON t.case_code = b.case_code
          WHERE t.hospital_id = ?
          ORDER BY b.created_at DESC
          LIMIT 100`,
        [Number(hospitalId)]
      );
      /* Spec §21: initial page load must include accepted-but-not-arrived cases
         so the hospital sees them in the Active column even on a hard refresh. */
      const keep = rows.filter(r => {
        /* The recipient list contains every initially alerted hospital, but
           a claimed case belongs only to its accepting hospital. */
        if (r.accepted_hospital_id &&
            Number(r.accepted_hospital_id) !== Number(hospitalId)) return false;
        if (opts.includeResolved) return true;
        if (r.status === 'ARRIVED') return false;
        /* ACCEPTED active OR PENDING-incoming. DECLINED is filtered out. */
        if (r.target_status === 'DECLINED') return false;
        return r.status === 'PENDING' || r.status === 'ACCEPTED';
      });
      const out = [];
      for (const row of keep) out.push(hydrate(row, await loadTargets(pool, row.case_code)));
      return out;
    },

    async listAll(limit) {
      const [rows] = await pool.query(
        'SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT ?', [Number(limit) || 50]
      );
      const out = [];
      for (const row of rows) out.push(hydrate(row, await loadTargets(pool, row.case_code)));
      return out;
    },

    /* ── First-accept-wins, decided by the database ─────────────────────── */
    async claim(caseCode, hospitalId) {
      const id = Number(hospitalId);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        const [targetRows] = await conn.query(
          'SELECT * FROM broadcast_targets WHERE case_code = ? AND hospital_id = ? FOR UPDATE',
          [caseCode, id]
        );
        if (targetRows.length === 0) {
          const [exists] = await conn.query('SELECT case_code FROM broadcasts WHERE case_code = ?', [caseCode]);
          await conn.commit();
          const record = await loadOne(pool, caseCode);
          return { ok: false, reason: exists.length ? 'NOT_TARGETED' : 'NOT_FOUND', record };
        }

        const [update] = await conn.query(
          `UPDATE broadcasts
              SET status = 'ACCEPTED', accepted_hospital_id = ?, accepted_at = NOW()
            WHERE case_code = ? AND status = 'PENDING'`,
          [id, caseCode]
        );

        if (update.affectedRows === 0) {
          const [cur] = await conn.query('SELECT status FROM broadcasts WHERE case_code = ?', [caseCode]);
          await conn.commit();
          const record = await loadOne(pool, caseCode);
          const reason = cur.length ? (cur[0].status === 'ACCEPTED' ? 'ALREADY_ACCEPTED' : cur[0].status) : 'NOT_FOUND';
          return { ok: false, reason, record };
        }

        await conn.query(
          `UPDATE broadcast_targets
              SET status = CASE WHEN hospital_id = ? THEN 'ACCEPTED' ELSE 'CANCELLED' END
            WHERE case_code = ?`,
          [id, caseCode]
        );

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        conn.release();
        throw err;
      }
      conn.release();

      const record = await loadOne(pool, caseCode);
      await mirrorLegacyStatus(record, 'ACKNOWLEDGED', 'ALERT_ACKNOWLEDGED');
      return { ok: true, record };
    },

    async decline(caseCode, hospitalId) {
      const id = Number(hospitalId);
      await pool.query(
        `UPDATE broadcast_targets SET status = 'DECLINED'
          WHERE case_code = ? AND hospital_id = ? AND status = 'PENDING'`,
        [caseCode, id]
      );
      const [left] = await pool.query(
        `SELECT COUNT(*) AS n FROM broadcast_targets WHERE case_code = ? AND status = 'PENDING'`,
        [caseCode]
      );
      if (Number(left[0].n) === 0) {
        await pool.query(
          `UPDATE broadcasts SET status = 'REJECTED' WHERE case_code = ? AND status = 'PENDING'`,
          [caseCode]
        );
      }
      const record = await loadOne(pool, caseCode);
      return record ? { ok: true, record } : { ok: false, reason: 'NOT_FOUND', record: null };
    },

    async cancel(caseCode) {
      await pool.query(
        `UPDATE broadcasts SET status = 'CANCELLED' WHERE case_code = ? AND status = 'PENDING'`, [caseCode]
      );
      await pool.query(
        `UPDATE broadcast_targets SET status = 'CANCELLED' WHERE case_code = ? AND status = 'PENDING'`, [caseCode]
      );
      const record = await loadOne(pool, caseCode);
      if (record) await mirrorLegacyStatus(record, 'CANCELLED', 'CASE_CANCELLED');
      return record ? { ok: true, record } : { ok: false, reason: 'NOT_FOUND', record: null };
    },

    async expireOverdue() {
      const [due] = await pool.query(
        `SELECT case_code FROM broadcasts WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= NOW()`
      );
      const expired = [];
      for (const row of due) {
        const [update] = await pool.query(
          `UPDATE broadcasts SET status = 'EXPIRED' WHERE case_code = ? AND status = 'PENDING'`,
          [row.case_code]
        );
        if (update.affectedRows === 0) continue;
        await pool.query(
          `UPDATE broadcast_targets SET status = 'EXPIRED' WHERE case_code = ? AND status = 'PENDING'`,
          [row.case_code]
        );
        const record = await loadOne(pool, row.case_code);
        if (record) { await mirrorLegacyStatus(record, 'ACK_FAILURE', 'ALERT_EXPIRED'); expired.push(record); }
      }
      return expired;
    },

    /* ── Patient edit (transport-only flow) ──────────────────────────────
       payload stays a JSON blob; the active row is identified by case_code.
       Returns the hydrated record so the controller can emit patient:updated
       with the same shape the dashboard already knows. */
    async updatePatientFields(caseCode, patch) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [cur] = await conn.query(
          `SELECT payload, status FROM broadcasts WHERE case_code = ? FOR UPDATE`,
          [caseCode]
        );
        if (cur.length === 0) { await conn.commit(); return { ok: false, reason: 'NOT_FOUND' }; }
        if (cur[0].status !== 'ACCEPTED' || cur[0].arrived_at) { await conn.commit(); return { ok: false, reason: 'NOT_ACTIVE' }; }

        const snapshot = parseJson(cur[0].payload, {});
        snapshot.patient = patch.patient || snapshot.patient || {};
        if ('notes' in patch) snapshot.notes = patch.notes;
        if ('last_patient_updated_at' in patch) snapshot.last_patient_updated_at = patch.last_patient_updated_at;

        const [u] = await conn.query(
          `UPDATE broadcasts SET payload = ? WHERE case_code = ?`,
          [JSON.stringify(snapshot), caseCode]
        );
        if (u.affectedRows === 0) { await conn.commit(); return { ok: false, reason: 'NOT_FOUND' }; }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
      const record = await loadOne(pool, caseCode);
      return record ? { ok: true, record } : { ok: false, reason: 'NOT_FOUND' };
    },

    /* ── Arrival: ACCEPTED -> ARRIVED, exactly once per case ─────────────── */
    async markArrived(caseCode) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [u] = await conn.query(
          `UPDATE broadcasts SET status = 'ARRIVED', arrived_at = NOW()
             WHERE case_code = ? AND status = 'ACCEPTED'`,
          [caseCode]
        );
        await conn.commit();
        if (u.affectedRows === 0) {
          const record = await loadOne(pool, caseCode);
          if (record && record.status === 'ARRIVED') return { ok: true, record, already: true };
          return { ok: false, reason: 'NOT_ACCEPTED' };
        }
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
      const record = await loadOne(pool, caseCode);
      await mirrorLegacyStatus(record, 'ARRIVED', 'CASE_ARRIVED');
      return { ok: true, record };
    }
  };
}

module.exports = { createMysqlStore };
