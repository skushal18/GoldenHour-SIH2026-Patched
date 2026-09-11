/* ============================================================================
   v5 broadcastService — Part II–V extensions.

   Adds:
     - match_score and match_reasons on each target's card
     - track, last_position, live_eta_minutes, eta_source on the record
     - emergencyNeeds attached to the card
     - patient_history kept on every patient edit (bounded to 40 entries)
     - audit hook on every state transition
   ========================================================================== */
'use strict';
const hospitalsConfig = require('../config/hospitals');
const { getStore } = require('../store');
const { CASE_TYPES, labelFor, categoryFor } = require('../data/caseTypes');
const { haversine, roundKm, computePriority, criticalFlags } = require('./triage');
const capacity = require('./capacityService');
const match = require('./matchService');
const audit = require('./auditService');

const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const text = v => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/* ── Targets ─────────────────────────────────────────────────────────── */
async function hospitalsFromDatabase() {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.query(
      'SELECT hospital_id, name, latitude, longitude, contact FROM hospitals WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    return rows.map(r => ({
      hospital_id: r.hospital_id, name: r.name, contact: r.contact,
      lat: Number(r.latitude), lng: Number(r.longitude),
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
    hospital_id: h.hospital_id, name: h.name, contact: h.contact || null,
    lat: h.lat === undefined ? null : h.lat, lng: h.lng === undefined ? null : h.lng,
    distance_km: roundKm(haversine(lat, lng, h.lat, h.lng)), status: 'PENDING',
  });
  if (hospitalsConfig.HACKATHON_MODE) return hospitalsConfig.HOSPITAL_LAPTOPS.map(withDistance);
  const all = (await hospitalsFromDatabase()).map(withDistance);
  const radius = num(radiusKm) || 15;
  return all.filter(h => h.distance_km !== null && h.distance_km <= radius).sort((a,b)=>a.distance_km - b.distance_km);
}

/* ── Shapes ─────────────────────────────────────────────────────────── */
function lifecycleFor(record) {
  if (!record) return 'resolved';
  if (record.status === 'ARRIVED') return 'resolved';
  if (record.status === 'ACCEPTED') return 'active';
  return record.status === 'PENDING' ? 'pending' : 'resolved';
}

function toDashboardCard(record, hospitalId) {
  const mine = record.targets.find(t => t.hospital_id === Number(hospitalId)) || null;
  const winner = record.accepted_hospital_id
    ? record.targets.find(t => t.hospital_id === record.accepted_hospital_id)
    : null;
  const myCap = mine ? capacity.get(mine.hospital_id) : null;
  const score = mine ? match.scoreFor(record, mine, myCap) : null;
  const reasons = mine ? match.reasonsFor(record, mine, myCap) : [];
  return {
    case_code: record.case_code, status: record.status, priority: record.priority,
    created_at: record.created_at, expires_at: record.expires_at,
    chief_complaint: record.chief_complaint, case_category: record.case_category,
    patient: record.patient, critical_flags: record.critical_flags,
    stroke_assessment: record.stroke_assessment || null, notes: record.notes,
    ambulance_id: record.ambulance_id, eta_minutes: record.eta_minutes,
    origin: record.origin, images: record.images || [],
    hospitals_notified: record.targets.length, distance_km: mine ? mine.distance_km : null,
    my_status: mine ? mine.status : null,
    accepted_hospital_id: record.accepted_hospital_id || null,
    accepted_by: winner ? winner.name : null,
    accepted_at: record.accepted_at || null, arrived_at: record.arrived_at || null,
    lifecycle: lifecycleFor(record),
    last_patient_updated_at: record.last_patient_updated_at || record.accepted_at || null,
    /* v5 additions */
    match_score: score, match_reasons: reasons,
    needs: match.needsFromCase(record),
    last_position: record.last_position || null,
    live_eta_minutes: record.live_eta_minutes || null,
    eta_source: record.eta_source || 'crew',
    patient_history: record.patient_history || [],
    capacity: myCap || null,
  };
}

function toAmbulanceStatus(record) {
  const winner = record.accepted_hospital_id
    ? record.targets.find(t => t.hospital_id === record.accepted_hospital_id)
    : null;
  const body = {
    id: record.case_code, status: record.status,
    hospitals_notified: record.targets.length,
    accepted_by: winner ? winner.name : null, priority: record.priority,
  };
  if (winner) {
    body.accepted_hospital = {
      name: winner.name, hospital_id: winner.hospital_id,
      distance_km: winner.distance_km, eta_min: record.eta_minutes || null,
      phone: winner.contact || null, lat: winner.lat, lng: winner.lng,
    };
  }
  if (record.status === 'ACCEPTED' || record.status === 'ARRIVED') {
    body.patient = record.patient || null;
    body.notes = record.notes || null;
    body.arrived_at = record.arrived_at || null;
    body.last_patient_updated_at = record.last_patient_updated_at || record.accepted_at || null;
    body.live_eta_minutes = record.live_eta_minutes || null;
    body.eta_source = record.eta_source || 'crew';
  }
  return body;
}

/* ── Create ─────────────────────────────────────────────────────────── */
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
    case_code: caseCode, case_id: null, status: 'PENDING', priority,
    created_at: createdAt.toISOString(), expires_at: expiresAt.toISOString(),
    accepted_hospital_id: null, accepted_at: null, arrived_at: null,
    case_type_id: num(payload.case_type_id),
    chief_complaint: labelFor(payload.case_type_id),
    case_category: categoryFor(payload.case_type_id),
    patient: {
      age: num(payload.age), gender: payload.gender || 'U',
      blood_group: text(payload.blood_group),
      consciousness: text(payload.consciousness),
      vitals: {
        systolic_bp: num(vitals.systolic_bp), diastolic_bp: num(vitals.diastolic_bp),
        heart_rate: num(vitals.heart_rate), resp_rate: num(vitals.resp_rate),
        spo2: num(vitals.spo2), glucose: num(vitals.glucose),
      },
    },
    critical_flags: criticalFlags(vitals, payload.consciousness, payload.case_type_id),
    stroke_assessment: payload.stroke_assessment || null,
    origin: {
      lat: payload.origin ? num(payload.origin.lat) : null,
      lng: payload.origin ? num(payload.origin.lng) : null,
      accuracy_m: payload.origin ? num(payload.origin.accuracy_m) : null,
      source: payload.origin ? (text(payload.origin.source) || 'gps') : 'gps',
    },
    radius_km: num(payload.broadcast_radius_km),
    eta_minutes: num(payload.eta_minutes),
    notes: text(payload.notes), ambulance_id: text(payload.ambulance_id),
    images: Array.isArray(payload.images) ? payload.images.slice(0, 4) : [],
    targets,
    /* v5 */
    track: [], last_position: null, live_eta_minutes: null, eta_source: 'crew',
    patient_history: [],
    resources: payload.resources || null,    // initial crew overrides
  };
  await store.insertBroadcast(record);

  audit.record(caseCode, 'BROADCAST_CREATED', {
    priority, case_category: record.case_category, targets: targets.length,
    radius_km: record.radius_km, origin_source: record.origin.source,
  }, { kind: 'crew' });

  if (io) {
    for (const t of targets) io.to(`hospital_${t.hospital_id}`).emit('broadcast:new', toDashboardCard(record, t.hospital_id));
  }
  console.log(`📡 ${caseCode} ${priority} "${record.chief_complaint}" → ${targets.map(t => `#${t.hospital_id} ${t.name}`).join(' + ')}`);
  return record;
}

/* ── Accept ─────────────────────────────────────────────────────────── */
async function acceptBroadcast(caseCode, hospitalId, io) {
  const store = getStore();
  const result = await store.claim(caseCode, hospitalId);
  if (!result.ok) {
    const winner = result.record && result.record.accepted_hospital_id
      ? result.record.targets.find(t => t.hospital_id === result.record.accepted_hospital_id) : null;
    return { ok: false, reason: result.reason,
      accepted_by: winner ? winner.name : null,
      accepted_hospital_id: result.record ? result.record.accepted_hospital_id : null,
      record: result.record };
  }
  const record = result.record;
  const winner = record.targets.find(t => t.hospital_id === Number(hospitalId));

  audit.record(caseCode, 'ACCEPTED', {
    hospital_id: Number(hospitalId),
    seconds_to_accept: Math.round((Date.now() - new Date(record.created_at).getTime())/1000),
    needs_met: (() => {
      const c = capacity.get(Number(hospitalId));
      if (!c) return null;
      const needs = match.needsFromCase(record);
      return !(needs.needs_ventilator && (c.ventilators_available|0)===0)
          && !(needs.needs_blood && !c.blood_available)
          && !(needs.needs_imaging && !c.ct_available)
          && !(needs.needs_ot && !c.ot_available)
          && !(needs.needs_cathlab && !c.cathlab_available);
    })(),
  }, { kind: 'desk', hospital_id: Number(hospitalId) });

  if (io) {
    for (const t of record.targets) {
      io.to(`hospital_${t.hospital_id}`).emit('broadcast:claimed', {
        case_code: record.case_code, accepted_hospital_id: Number(hospitalId),
        accepted_by: winner ? winner.name : null, accepted_at: record.accepted_at,
        won: t.hospital_id === Number(hospitalId),
      });
    }
    io.to(`case_${record.case_code}`).emit('case:status', toAmbulanceStatus(record));
    io.to(`case_${record.case_code}`).emit('case:position', { case_code: record.case_code, status: 'tracking_started' });
  }
  console.log(`✅ ${caseCode} accepted by #${hospitalId} ${winner ? winner.name : ''}`);
  return { ok: true, record };
}

/* ── Decline / cancel / expire ─────────────────────────────────────── */
async function declineBroadcast(caseCode, hospitalId, io) {
  const store = getStore();
  const result = await store.decline(caseCode, hospitalId);
  if (!result.ok) return result;
  audit.record(caseCode, 'DECLINED', { hospital_id: Number(hospitalId) }, { kind: 'desk', hospital_id: Number(hospitalId) });
  if (io) {
    io.to(`hospital_${hospitalId}`).emit('broadcast:declined', { case_code: caseCode, hospital_id: Number(hospitalId) });
    if (result.record.status === 'REJECTED') {
      /* Everybody turned it down. The crew has to hear that immediately — it
         is the moment they need to widen the radius or call ahead by voice —
         and every desk should drop the card rather than leave it sitting
         there unanswerable. (This line previously referenced an undeclared
         `record`, so it threw instead of notifying anyone.) */
      for (const t of result.record.targets) {
        io.to(`hospital_${t.hospital_id}`).emit('broadcast:expired', { case_code: caseCode, reason: 'REJECTED' });
      }
      io.to(`case_${caseCode}`).emit('case:status', toAmbulanceStatus(result.record));
    }
  }
  return result;
}
async function cancelBroadcast(caseCode, io) {
  const store = getStore();
  const result = await store.cancel(caseCode);
  if (!result.ok) return result;
  audit.record(caseCode, 'CANCELLED', {}, { kind: 'crew' });
  if (io) {
    for (const t of result.record.targets) {
      io.to(`hospital_${t.hospital_id}`).emit('broadcast:cancelled', { case_code: caseCode });
    }
    io.to(`case_${caseCode}`).emit('case:status', toAmbulanceStatus(result.record));
  }
  return result;
}

/* ── Patient update ─────────────────────────────────────────────────── */
const PATIENT_SCALAR_KEYS = ['age', 'gender', 'blood_group', 'consciousness'];
const PATIENT_NOTES_KEY = 'notes';
const PATIENT_VITAL_KEYS = ['systolic_bp', 'diastolic_bp', 'heart_rate', 'resp_rate', 'spo2', 'glucose'];

function numOrNull(v){ if (v===null||v===undefined||v==='') return null; const n=Number(v); return Number.isFinite(n)?n:null; }
function textOrNull(v, max){ if (v===null||v===undefined) return null; const s=String(v).trim(); if(!s) return null; return s.length>max?s.slice(0,max):s; }

async function updatePatient(caseCode, patch, io) {
  const store = getStore();
  const record = await store.getBroadcast(caseCode);
  if (!record) return { ok:false, reason:'NOT_FOUND', message:'Case not found' };
  if (record.status === 'ARRIVED' || record.status === 'CANCELLED' ||
      record.status === 'EXPIRED' || record.status === 'REJECTED')
    return { ok:false, reason:'NOT_ACTIVE', message:'Case is no longer active.' };
  if (record.status !== 'ACCEPTED')
    return { ok:false, reason:'NOT_ACCEPTED', message:'No hospital has accepted this case.' };

  const before = JSON.parse(JSON.stringify(record.patient || {}));
  const cleanPatient = Object.assign({}, record.patient || {});
  for (const key of PATIENT_SCALAR_KEYS) {
    if (!(key in patch)) continue;
    if (key === 'age') {
      const n = numOrNull(patch.age);
      if (n !== null && (n < 0 || n > 120)) return { ok:false, reason:'INVALID_AGE' };
      cleanPatient.age = n;
    } else if (key === 'gender') {
      if (patch.gender !== null && patch.gender !== undefined && !['M','F','O','U'].includes(String(patch.gender)))
        return { ok:false, reason:'INVALID_GENDER' };
      cleanPatient.gender = (patch.gender === null || patch.gender === undefined) ? null : String(patch.gender);
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
      if (n !== null) {
        const ranges = {
          systolic_bp:[40,300], diastolic_bp:[20,200],
          heart_rate:[20,300], resp_rate:[4,80],
          spo2:[50,100], glucose:[10,900],
        };
        const r = ranges[key];
        if (r && (n < r[0] || n > r[1])) return { ok:false, reason:'INVALID_VITALS', message: key + ' out of range.' };
      }
      cleanVitals[key] = n;
    }
    cleanPatient.vitals = cleanVitals;
  }
  const updatedAt = new Date().toISOString();
  const result = await store.updatePatientFields(caseCode, {
    patient: cleanPatient,
    notes: 'notes' in patch ? textOrNull(patch[PATIENT_NOTES_KEY], 500) : record.notes,
    last_patient_updated_at: updatedAt,
  });
  if (!result || !result.ok) return { ok:false, reason:(result && result.reason) || 'NOT_FOUND' };

  /* v5 — bounded history of changes */
  const changed = diff(before, cleanPatient);
  if (changed && Object.keys(changed).length) {
    result.record.patient_history = result.record.patient_history || [];
    result.record.patient_history.push({ at: updatedAt, changed, by: 'crew' });
    if (result.record.patient_history.length > 40) result.record.patient_history.shift();
    await store.appendHistory(caseCode, result.record.patient_history);
  }
  audit.record(caseCode, 'PATIENT_UPDATED', { changed }, { kind:'crew' });

  const accepted = result.record.accepted_hospital_id;
  if (io && accepted) {
    const card = toDashboardCard(result.record, accepted);
    io.to(`hospital_${accepted}`).emit('patient:updated', {
      case_code: caseCode, patient: card.patient, notes: card.notes,
      updated_at: updatedAt, patient_history: card.patient_history,
    });
  }
  if (io) io.to(`case_${caseCode}`).emit('case:status', toAmbulanceStatus(result.record));
  return { ok:true, record: result.record };
}
function diff(a, b){
  const out = {};
  function walk(x, y, path){
    if (Array.isArray(x) || Array.isArray(y)) return;
    if (x && typeof x === 'object' && y && typeof y === 'object'){
      const keys = new Set([...Object.keys(x||{}), ...Object.keys(y||{})]);
      for (const k of keys) walk(x ? x[k] : undefined, y ? y[k] : undefined, path.concat(k));
      return;
    }
    if (x !== y) out[path.join('.')] = [x, y];
  }
  walk(a, b, []);
  return out;
}

/* ── Arrived ─────────────────────────────────────────────────────────── */
async function markArrived(caseCode, payload, io) {
  const store = getStore();
  const record = await store.getBroadcast(caseCode);
  if (!record) return { ok:false, reason:'NOT_FOUND' };
  const hospitalId = Number(payload&&payload.hospital_id) || record.accepted_hospital_id || null;
  if (!hospitalId || hospitalId !== record.accepted_hospital_id) {
    return { ok:false, reason:'WRONG_HOSPITAL', message:'Arrival must be at the accepting hospital.' };
  }
  if (record.status === 'ARRIVED') return { ok:true, record, already:true };
  if (record.status !== 'ACCEPTED') return { ok:false, reason:'NOT_ACCEPTED' };

  const result = await store.markArrived(caseCode);
  if (!result || !result.ok) return { ok:false, reason:(result && result.reason) || 'NOT_FOUND' };

  const t = require('./trackingService');
  const aggregate = t.drop(caseCode);
  audit.record(caseCode, 'ARRIVED', {
    hospital_id: hospitalId,
    seconds_accept_to_arrival: Math.round((Date.now() - new Date(record.accepted_at).getTime())/1000),
    eta_error_minutes: (aggregate && aggregate.last_position && record.eta_minutes)
      ? Math.abs((aggregate.last_position.speed_kmh||0)) : null,
  }, { kind:'crew' });

  if (io) {
    io.to(`hospital_${result.record.accepted_hospital_id}`).emit('case:arrived', {
      case_code: caseCode, status:'ARRIVED', arrived_at: result.record.arrived_at,
    });
    io.to(`case_${caseCode}`).emit('case:status', toAmbulanceStatus(result.record));
  }
  console.log(`🏥 ${caseCode} arrived at #${result.record.accepted_hospital_id}`);
  return { ok:true, record: result.record };
}

function startExpiryLoop(io, intervalMs) {
  const tick = async () => {
    try {
      const expired = await getStore().expireOverdue();
      for (const record of expired) {
        audit.record(record.case_code, 'EXPIRED', {
          targets_notified: record.targets.length,
          seconds_open: Math.round((Date.now() - new Date(record.created_at).getTime())/1000),
        }, { kind:'system' });
        if (!io) continue;
        for (const t of record.targets) io.to(`hospital_${t.hospital_id}`).emit('broadcast:expired', { case_code: record.case_code });
        io.to(`case_${record.case_code}`).emit('case:status', toAmbulanceStatus(record));
      }
    } catch (e) { console.warn('⚠️  expiry failed:', e.message); }
  };
  const timer = setInterval(tick, intervalMs || 10000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  CASE_TYPES, createBroadcast, acceptBroadcast, declineBroadcast, cancelBroadcast,
  updatePatient, markArrived, resolveTargets, toDashboardCard, toAmbulanceStatus,
  lifecycleFor, startExpiryLoop,
};
