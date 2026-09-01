/* ============================================================================
   The broadcast lifecycle — the heart of the hackathon demo.

     1  Ambulance presses "Broadcast Request"
     2  Server resolves the target hospitals
          HACKATHON_MODE → the two hardcoded laptops, always both
          otherwise      → every registered hospital inside the radius
     3  One broadcast row + one PENDING target row per hospital
     4  Socket.IO pushes the case into every target's room at once
     5  The first laptop to Accept claims it. That claim is atomic, so a
        double-tap in the same millisecond still produces exactly one winner.
     6  Every other laptop is told "claimed" and drops the card immediately;
        the ambulance is told who won.
   ========================================================================== */

'use strict';

const hospitalsConfig = require('../config/hospitals');
const { getStore } = require('../store');
const { CASE_TYPES, labelFor, categoryFor } = require('../data/caseTypes');
const { haversine, roundKm, computePriority, criticalFlags } = require('./triage');

const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const text = v => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/* ── Who gets alerted ────────────────────────────────────────────────────── */

async function hospitalsFromDatabase() {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.query(
      'SELECT hospital_id, name, latitude, longitude, contact FROM hospitals WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    return rows.map(r => ({
      hospital_id: r.hospital_id,
      name: r.name,
      contact: r.contact,
      lat: Number(r.latitude),
      lng: Number(r.longitude)
    }));
  } catch (err) {
    console.warn('⚠️  hospital lookup fell back to the hardcoded list:', err.message);
    return hospitalsConfig.HOSPITAL_LAPTOPS.slice();
  }
}

async function resolveTargets(origin, radiusKm) {
  const lat = origin ? num(origin.lat) : null;
  const lng = origin ? num(origin.lng) : null;

  const withDistance = h => ({
    hospital_id: h.hospital_id,
    name: h.name,
    contact: h.contact || null,
    lat: h.lat === undefined ? null : h.lat,
    lng: h.lng === undefined ? null : h.lng,
    distance_km: roundKm(haversine(lat, lng, h.lat, h.lng)),
    status: 'PENDING'
  });

  if (hospitalsConfig.HACKATHON_MODE) {
    /* Both laptops, every time. The judges' table is not 15 km from a
       hospital, and a broadcast that reaches nobody is not a demo. */
    return hospitalsConfig.HOSPITAL_LAPTOPS.map(withDistance);
  }

  const all = (await hospitalsFromDatabase()).map(withDistance);
  const radius = num(radiusKm) || 15;
  const inRange = all.filter(h => h.distance_km !== null && h.distance_km <= radius);
  return inRange.sort((a, b) => a.distance_km - b.distance_km);
}

/* ── Shapes the two front-ends consume ───────────────────────────────────── */

/** One place derives lifecycle from a record's status.
     pending   — nobody has accepted yet, the card lives in the queue
     active    — accepted by SOME hospital, but the ambulance has not arrived yet.
                 The accepting hospital keeps an Active card; losers got `broadcast:claimed` and dropped it
     resolved  — handled (arrived / cancelled / expired / rejected / declined-everywhere)
     The lifecycle is a server-derived UI hint — only the backend decides, so the dashboard cannot
     independently claim a case is "recently handled" just because its Accept button was clicked. */
function lifecycleFor(record) {
  if (!record) return 'resolved';
  if (record.status === 'ARRIVED') return 'resolved';
  if (record.status === 'ACCEPTED') return 'active';
  /* PENDING is always a queue card. CANCELLED / EXPIRED / REJECTED are already out — resolved. */
  return record.status === 'PENDING' ? 'pending' : 'resolved';
}

/** What a hospital laptop renders on its board. */
function toDashboardCard(record, hospitalId) {
  const mine = record.targets.find(t => t.hospital_id === Number(hospitalId)) || null;
  const winner = record.accepted_hospital_id
    ? record.targets.find(t => t.hospital_id === record.accepted_hospital_id)
    : null;

  return {
    case_code: record.case_code,
    status: record.status,
    priority: record.priority,
    created_at: record.created_at,
    expires_at: record.expires_at,
    chief_complaint: record.chief_complaint,
    case_category: record.case_category,
    patient: record.patient,
    critical_flags: record.critical_flags,
    stroke_assessment: record.stroke_assessment || null,
    notes: record.notes,
    ambulance_id: record.ambulance_id,
    eta_minutes: record.eta_minutes,
    origin: record.origin,
    images: record.images || [],
    hospitals_notified: record.targets.length,
    distance_km: mine ? mine.distance_km : null,
    my_status: mine ? mine.status : null,
    accepted_hospital_id: record.accepted_hospital_id || null,
    accepted_by: winner ? winner.name : null,
    accepted_at: record.accepted_at || null,
    arrived_at: record.arrived_at || null,
    /* server-derived UI hint (see lifecycleFor) */
    lifecycle: lifecycleFor(record),
    last_patient_updated_at: record.last_patient_updated_at || record.accepted_at || null
  };
}

/** What the ambulance app polls for on GET /requests/:id. */
function toAmbulanceStatus(record) {
  const winner = record.accepted_hospital_id
    ? record.targets.find(t => t.hospital_id === record.accepted_hospital_id)
    : null;

  const body = {
    id: record.case_code,
    status: record.status,
    hospitals_notified: record.targets.length,
    accepted_by: winner ? winner.name : null,
    priority: record.priority
  };

  if (winner) {
    body.accepted_hospital = {
      name: winner.name,
      hospital_id: winner.hospital_id,
      distance_km: winner.distance_km,
      eta_min: record.eta_minutes || null,
      phone: winner.contact || null,
      lat: winner.lat,
      lng: winner.lng
    };
  }
  /* patients on the move need the values too, so the Edit Patient form has
     something real to pre-fill when the crew taps it on the active-card screen */
  if (record.status === 'ACCEPTED' || record.status === 'ARRIVED') {
    body.patient = record.patient || null;
    body.notes = record.notes || null;
    body.arrived_at = record.arrived_at || null;
    body.last_patient_updated_at = record.last_patient_updated_at || record.accepted_at || null;
  }
  return body;
}

/* ── 1 ▸ Create ──────────────────────────────────────────────────────────── */

async function createBroadcast(body, io) {
  const store = getStore();
  const payload = body || {};
  const vitals = payload.vitals || {};

  const priority = computePriority(vitals, payload.consciousness, payload.case_type_id);
  const targets = await resolveTargets(payload.origin, payload.broadcast_radius_km);
  const caseCode = await store.nextCaseCode();

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + hospitalsConfig.ACCEPT_WINDOW_SECONDS * 1000);

  const record = {
    case_code: caseCode,
    case_id: null,
    status: 'PENDING',
    priority,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    accepted_hospital_id: null,
    accepted_at: null,

    case_type_id: num(payload.case_type_id),
    chief_complaint: labelFor(payload.case_type_id),
    case_category: categoryFor(payload.case_type_id),

    patient: {
      age: num(payload.age),
      gender: payload.gender || 'U',
      blood_group: text(payload.blood_group),
      consciousness: text(payload.consciousness),
      vitals: {
        systolic_bp: num(vitals.systolic_bp),
        diastolic_bp: num(vitals.diastolic_bp),
        heart_rate: num(vitals.heart_rate),
        resp_rate: num(vitals.resp_rate),
        spo2: num(vitals.spo2),
        glucose: num(vitals.glucose)
      }
    },

    critical_flags: criticalFlags(vitals, payload.consciousness, payload.case_type_id),
    stroke_assessment: payload.stroke_assessment || null,
    origin: {
      lat: payload.origin ? num(payload.origin.lat) : null,
      lng: payload.origin ? num(payload.origin.lng) : null,
      accuracy_m: payload.origin ? num(payload.origin.accuracy_m) : null,
      /* "gps" | "last-known" | "manual". A distance computed from a position
         somebody typed in deserves less trust than a measured one, and the
         ER desk is told which it is rather than left to assume. */
      source: payload.origin ? (text(payload.origin.source) || 'gps') : 'gps'
    },
    radius_km: num(payload.broadcast_radius_km),
    eta_minutes: num(payload.eta_minutes),
    notes: text(payload.notes),
    ambulance_id: text(payload.ambulance_id),
    images: Array.isArray(payload.images) ? payload.images.slice(0, 4) : [],

    targets
  };

  await store.insertBroadcast(record);

  /* Push it to every laptop at the same instant. */
  if (io) {
    for (const t of targets) {
      io.to(`hospital_${t.hospital_id}`).emit('broadcast:new', toDashboardCard(record, t.hospital_id));
    }
  }

  console.log(
    `📡 ${caseCode} ${priority} "${record.chief_complaint}" → ` +
    targets.map(t => `#${t.hospital_id} ${t.name}`).join(' + ')
  );

  return record;
}

/* ── 2 ▸ Accept (first one wins) ─────────────────────────────────────────── */

async function acceptBroadcast(caseCode, hospitalId, io) {
  const store = getStore();
  const result = await store.claim(caseCode, hospitalId);

  if (!result.ok) {
    const winner = result.record && result.record.accepted_hospital_id
      ? result.record.targets.find(t => t.hospital_id === result.record.accepted_hospital_id)
      : null;
    console.log(`🚫 ${caseCode} accept refused for hospital #${hospitalId} — ${result.reason}`);
    return {
      ok: false,
      reason: result.reason,
      accepted_by: winner ? winner.name : null,
      accepted_hospital_id: result.record ? result.record.accepted_hospital_id : null,
      record: result.record
    };
  }

  const record = result.record;
  const winner = record.targets.find(t => t.hospital_id === Number(hospitalId));

  if (io) {
    /* Every target hears it — the winner to lock the card in, the losers to
       drop it off the board. One event, one source of truth. */
    for (const t of record.targets) {
      io.to(`hospital_${t.hospital_id}`).emit('broadcast:claimed', {
        case_code: record.case_code,
        accepted_hospital_id: Number(hospitalId),
        accepted_by: winner ? winner.name : null,
        accepted_at: record.accepted_at,
        won: t.hospital_id === Number(hospitalId)
      });
    }
    io.to(`case_${record.case_code}`).emit('case:status', toAmbulanceStatus(record));
  }

  console.log(`✅ ${caseCode} accepted by #${hospitalId} ${winner ? winner.name : ''} — cleared from every other laptop`);
  return { ok: true, record };
}

/* ── 3 ▸ Decline / cancel / expire ───────────────────────────────────────── */

async function declineBroadcast(caseCode, hospitalId, io) {
  const store = getStore();
  const result = await store.decline(caseCode, hospitalId);
  if (!result.ok) return result;

  const record = result.record;
  if (io) {
    io.to(`hospital_${hospitalId}`).emit('broadcast:declined', { case_code: caseCode, hospital_id: Number(hospitalId) });
    if (record.status === 'REJECTED') {
      io.to(`case_${record.case_code}`).emit('case:status', toAmbulanceStatus(record));
    }
  }
  return result;
}

async function cancelBroadcast(caseCode, io) {
  const store = getStore();
  const result = await store.cancel(caseCode);
  if (!result.ok) return result;
  if (io) {
    for (const t of result.record.targets) {
      io.to(`hospital_${t.hospital_id}`).emit('broadcast:cancelled', { case_code: caseCode });
    }
    io.to(`case_${caseCode}`).emit('case:status', toAmbulanceStatus(result.record));
  }
  return result;
}

/* ── 4 ▸ Patient update (transport-only edit flow) ─────────────────────── */
/* Patient edits during transport. Validation is intentionally narrow:
     - case_code MUST exist
     - the case MUST be ACCEPTED and not yet ARRIVED (spec §6.4)
     - only whitelisted scalar fields are written; random keys are dropped, not stored
     - vitals subset: same keys the dashboard already renders
   Anything outside the whitelist is silently dropped so a malicious or buggy
   client cannot invent metadata and silently overwrite server data (spec §23). */
const PATIENT_SCALAR_KEYS = ['age', 'gender', 'blood_group', 'consciousness'];
const PATIENT_NOTES_KEY = 'notes';
const PATIENT_VITAL_KEYS = ['systolic_bp', 'diastolic_bp', 'heart_rate', 'resp_rate', 'spo2', 'glucose'];

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function textOrNull(v, maxLen) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/* spec §23: return a clear reason when the update is refused, do not silently no-op */
async function updatePatient(caseCode, patch, io) {
  const store = getStore();
  const record = await store.getBroadcast(caseCode);
  if (!record) return { ok: false, reason: 'NOT_FOUND', message: 'Case not found' };

  /* Reject once it has arrived, per spec §1.1 / §6.4:
     "Updates are not accepted after the case has arrived/closed." */
  if (record.status === 'ARRIVED' || record.status === 'CANCELLED' ||
      record.status === 'EXPIRED' || record.status === 'REJECTED') {
    return { ok: false, reason: 'NOT_ACTIVE', message: 'This case is no longer active and cannot be edited through the transport workflow.' };
  }
  if (record.status !== 'ACCEPTED') {
    return { ok: false, reason: 'NOT_ACCEPTED', message: 'No hospital has accepted this case yet.' };
  }

  /* Build a clean patch — only known keys, numbers we want to store as numbers,
     text trimmed and length-bounded. Unknown keys silently dropped. */
  const cleanPatient = Object.assign({}, record.patient || {});
  for (const key of PATIENT_SCALAR_KEYS) {
    if (!(key in patch)) continue;
    if (key === 'age') {
      const n = numOrNull(patch.age);
      if (n !== null && (n < 0 || n > 120)) return { ok: false, reason: 'INVALID_AGE', message: 'Age must be between 0 and 120.' };
      cleanPatient.age = n;
    } else if (key === 'gender') {
      const v = patch.gender;
      if (v !== null && v !== undefined && !['M', 'F', 'O', 'U'].includes(String(v))) {
        return { ok: false, reason: 'INVALID_GENDER', message: 'Gender must be M, F, O or U.' };
      }
      cleanPatient.gender = v === null || v === undefined ? null : String(v);
    } else {
      cleanPatient[key] = textOrNull(patch[key], 16);
    }
  }
  if ('vitals' in patch && patch.vitals && typeof patch.vitals === 'object' && !Array.isArray(patch.vitals)) {
    const v = patch.vitals;
    const cleanVitals = Object.assign({}, cleanPatient.vitals || {});
    for (const key of PATIENT_VITAL_KEYS) {
      if (!(key in v)) continue;
      const n = numOrNull(v[key]);
      /* ranges from app/www/app.js (RANGES table) — refuse wildly invalid numbers */
      if (n !== null) {
        const ranges = {
          systolic_bp: [40, 300], diastolic_bp: [20, 200],
          heart_rate: [20, 300], resp_rate: [4, 80],
          spo2: [50, 100], glucose: [10, 900]
        };
        const r = ranges[key];
        if (r && (n < r[0] || n > r[1])) {
          return { ok: false, reason: 'INVALID_VITALS', message: key + ' is outside the plausible range for a vital sign.' };
        }
      }
      cleanVitals[key] = n;
    }
    cleanPatient.vitals = cleanVitals;
  }

  const updatedAt = new Date().toISOString();

  const result = await store.updatePatientFields(caseCode, {
    patient: cleanPatient,
    notes: 'notes' in patch ? textOrNull(patch[PATIENT_NOTES_KEY], 500) : record.notes,
    last_patient_updated_at: updatedAt
  });

  if (!result || !result.ok) return { ok: false, reason: (result && result.reason) || 'NOT_FOUND', message: 'Case not found' };

  /* spec §1.2 / §18: notify ONLY the accepted hospital. Every other desk must
     not learn the patient's edited details — the case is theirs, not yours. */
  const accepted = result.record.accepted_hospital_id;
  if (io && accepted) {
    io.to(`hospital_${accepted}`).emit('patient:updated', {
      case_code: caseCode,
      patient: result.record.patient,
      notes: result.record.notes,
      updated_at: updatedAt
    });
  }
  /* The ambulance crew should also see the server-side echo so the "Saving…" →
     "Patient details updated" transition matches the actual store. */
  if (io) io.to(`case_${caseCode}`).emit('case:status', toAmbulanceStatus(result.record));

  console.log(`🩹 ${caseCode} patient details edited · accepted by #${accepted}`);
  return { ok: true, record: result.record };
}

/* ── 5 ▸ Arrived (transport completion) ─────────────────────────────────── */
/* spec §12: ambulance sends `ambulance:arrived` once it reaches the hospital.
   Only the accepting hospital's desk gets `case:arrived`. The state change
   is persisted before the socket fire, so a page refresh on the desk still
   shows ARRIVED, not ACTIVE. */
async function markArrived(caseCode, payload, io) {
  const store = getStore();
  const record = await store.getBroadcast(caseCode);
  if (!record) return { ok: false, reason: 'NOT_FOUND', message: 'Case not found' };

  /* Validate the destination before treating a duplicate arrival as a safe
     no-op. Otherwise a later report naming another hospital would be falsely
     acknowledged once the case had already arrived. */
  const hospitalId = Number(payload && payload.hospital_id) || record.accepted_hospital_id || null;
  if (!hospitalId || hospitalId !== record.accepted_hospital_id) {
    return { ok: false, reason: 'WRONG_HOSPITAL', message: 'Arrival must be reported to the accepting hospital.' };
  }

  if (record.status === 'ARRIVED') return { ok: true, record, already: true };
  if (record.status !== 'ACCEPTED') {
    return { ok: false, reason: 'NOT_ACCEPTED', message: 'This case was not in an ACCEPTED state when arrival was reported.' };
  }

  const result = await store.markArrived(caseCode);
  if (!result || !result.ok) return { ok: false, reason: (result && result.reason) || 'NOT_FOUND', message: 'Could not mark arrival.' };

  if (io) {
    io.to(`hospital_${result.record.accepted_hospital_id}`).emit('case:arrived', {
      case_code: caseCode,
      status: 'ARRIVED',
      arrived_at: result.record.arrived_at
    });
    io.to(`case_${caseCode}`).emit('case:status', toAmbulanceStatus(result.record));
  }
  console.log(`🏥 ${caseCode} arrived at #${result.record.accepted_hospital_id}`);
  return { ok: true, record: result.record };
}

function startExpiryLoop(io, intervalMs) {
  const tick = async () => {
    try {
      const expired = await getStore().expireOverdue();
      for (const record of expired) {
        console.log(`⌛ ${record.case_code} expired — nobody accepted in time`);
        if (!io) continue;
        for (const t of record.targets) {
          io.to(`hospital_${t.hospital_id}`).emit('broadcast:expired', { case_code: record.case_code });
        }
        io.to(`case_${record.case_code}`).emit('case:status', toAmbulanceStatus(record));
      }
    } catch (err) {
      console.warn('⚠️  expiry sweep failed:', err.message);
    }
  };
  const timer = setInterval(tick, intervalMs || 10000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  CASE_TYPES,
  createBroadcast,
  acceptBroadcast,
  declineBroadcast,
  cancelBroadcast,
  updatePatient,
  markArrived,
  resolveTargets,
  toDashboardCard,
  toAmbulanceStatus,
  lifecycleFor,
  startExpiryLoop
};
