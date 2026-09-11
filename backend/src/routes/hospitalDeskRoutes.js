/* ============================================================================
   Hospital desk routes — v5 (capacity, track, timeline, handover, analytics).
   ========================================================================== */
'use strict';
const express = require('express');
const router = express.Router();
const hospitalsConfig = require('../config/hospitals');
const { deskGuard, deskAuthMode } = require('../middleware/hospitalIdentity');
const { getStore } = require('../store');
const { acceptBroadcast, declineBroadcast, toDashboardCard } = require('../services/broadcastService');
const capacity = require('../services/capacityService');
const tracking = require('../services/trackingService');
const audit = require('../services/auditService');

router.use(deskGuard);

router.get('/me', (req, res) => {
  const c = capacity.get(req.hospital.hospital_id);
  res.json({ hospital: req.hospital, matched_by: req.hospitalMatchedBy, client_ip: req.clientIp,
    hackathon_mode: hospitalsConfig.HACKATHON_MODE,
    accept_window_seconds: hospitalsConfig.ACCEPT_WINDOW_SECONDS,
    auth_mode: deskAuthMode(), capacity: c });
});

router.get('/laptops', (req, res) => {
  res.json({ hackathon_mode: hospitalsConfig.HACKATHON_MODE,
    laptops: hospitalsConfig.HOSPITAL_LAPTOPS.map(h => ({ hospital_id:h.hospital_id, code:h.code, ip:h.ip, name:h.name, accent:h.accent })) });
});

router.get('/queue', async (req, res) => {
  try{
    const records = await getStore().listForHospital(req.hospital.hospital_id);
    const cards = records.map(r => toDashboardCard(r, req.hospital.hospital_id));
    res.json({ hospital: req.hospital, matched_by: req.hospitalMatchedBy, cases: cards,
      pending: cards.filter(c => c.lifecycle==='pending'), active: cards.filter(c => c.lifecycle==='active') });
  }catch(e){ res.status(500).json({ success:false }); }
});

router.get('/history', async (req, res) => {
  try{
    const records = await getStore().listForHospital(req.hospital.hospital_id, { includeResolved:true });
    res.json({ hospital: req.hospital, cases: records.slice(0,50).map(r => toDashboardCard(r, req.hospital.hospital_id)) });
  }catch(e){ res.status(500).json({ success:false }); }
});

router.post('/accept/:caseCode', async (req, res) => {
  try{
    const r = await acceptBroadcast(req.params.caseCode, req.hospital.hospital_id, req.app.get('io'));
    if (!r.ok){
      const code = r.reason==='NOT_FOUND'?404:409;
      return res.status(code).json({ success:false, reason:r.reason, accepted_by:r.accepted_by, accepted_hospital_id:r.accepted_hospital_id });
    }
    res.json({ success:true, message:'Case accepted — cleared from every other hospital', case: toDashboardCard(r.record, req.hospital.hospital_id) });
  }catch(e){ res.status(500).json({ success:false }); }
});

router.post('/decline/:caseCode', async (req, res) => {
  try{
    const r = await declineBroadcast(req.params.caseCode, req.hospital.hospital_id, req.app.get('io'));
    if (!r.ok) return res.status(404).json({ success:false });
    res.json({ success:true, case: toDashboardCard(r.record, req.hospital.hospital_id) });
  }catch(e){ res.status(500).json({ success:false }); }
});

/* v5 ── Capacity ── */
router.get('/capacity', (req, res) => {
  const c = capacity.get(req.hospital.hospital_id);
  res.json({ capacity: c });
});
router.put('/capacity', (req, res) => {
  const c = capacity.upsert(req.hospital.hospital_id, req.body || {});
  res.json({ capacity: c });
});
router.get('/capacity/all', (req, res) => {
  res.json({ capacity: capacity.all(), stale_minutes: Number(process.env.CAPACITY_STALE_MINUTES || 60) });
});

/* v5 ── Track ── */
router.get('/track/:caseCode', async (req, res) => {
  try{
    const record = await getStore().getBroadcast(req.params.caseCode);
    if (!record) return res.status(404).json({ success:false });
    if (Number(record.accepted_hospital_id) !== Number(req.hospital.hospital_id))
      return res.status(403).json({ success:false, message:'Case is not yours' });
    const t = tracking.get(req.params.caseCode) || {};
    const winner = record.targets.find(x => x.hospital_id === record.accepted_hospital_id);
    res.json({ case_code: req.params.caseCode, track: t.track || [],
      last_position: t.last_position || record.last_position || null,
      live_eta_minutes: t.live_eta_minutes || null, eta_source: t.eta_source || 'crew',
      hospital: winner ? { lat: winner.lat, lng: winner.lng, name: winner.name, distance_km: winner.distance_km } : null });
  }catch(e){ res.status(500).json({ success:false }); }
});

/* v5 ── Handover ── */
router.get('/handover/:caseCode', async (req, res) => {
  try{
    const record = await getStore().getBroadcast(req.params.caseCode);
    if (!record) return res.status(404).json({ success:false });
    if (Number(record.accepted_hospital_id) !== Number(req.hospital.hospital_id))
      return res.status(403).json({ success:false });
    const winner = record.targets.find(x => x.hospital_id === record.accepted_hospital_id);
    const intervals = {
      broadcast_to_accept: record.accepted_at ? Math.round((new Date(record.accepted_at)-new Date(record.created_at))/1000) : null,
      accept_to_arrival: record.arrived_at && record.accepted_at ? Math.round((new Date(record.arrived_at)-new Date(record.accepted_at))/1000) : null,
    };
    res.json({
      case_code: record.case_code, priority: record.priority,
      hospital: req.hospital, ambulance_id: record.ambulance_id,
      created_at: record.created_at, accepted_at: record.accepted_at, arrived_at: record.arrived_at,
      intervals,
      patient_history: record.patient_history || [],
      patient: record.patient, vitals_initial_vs_latest: vitalsHistory(record),
      chief_complaint: record.chief_complaint, case_category: record.case_category,
      critical_flags: record.critical_flags, stroke_assessment: record.stroke_assessment,
      resources: record.resources, notes: record.notes, etas: { eta_minutes: record.eta_minutes,
        live_eta_minutes: record.live_eta_minutes, eta_source: record.eta_source },
      track_aggregate: record.last_position ? { last: record.last_position } : null,
      images: record.images || [],
      distance_km: winner ? winner.distance_km : null,
    });
  }catch(e){ res.status(500).json({ success:false }); }
});

function vitalsHistory(record){
  const initial = record.patient && record.patient.vitals;
  const last = record.patient_history && record.patient_history.length
    ? (record.patient_history[record.patient_history.length-1].changed || {})
    : null;
  const out = [];
  for (const k of (initial ? Object.keys(initial) : [])){
    out.push({ key: k, initial: initial ? initial[k] : null,
      latest: last && last['vitals.'+k] ? last['vitals.'+k][1] : (initial?initial[k]:null) });
  }
  return out;
}

/* v5 ── Timeline ── */
router.get('/timeline/:caseCode', async (req, res) => {
  try{
    const record = await getStore().getBroadcast(req.params.caseCode);
    if (!record) return res.status(404).json({ success:false });
    if (Number(record.accepted_hospital_id) !== Number(req.hospital.hospital_id))
      return res.status(403).json({ success:false });
    res.json({ case_code: req.params.caseCode, events: audit.list(req.params.caseCode) });
  }catch(e){ res.status(500).json({ success:false }); }
});

/* v5 ── Analytics ── */
router.get('/analytics', async (req, res) => {
  try{
    const scope = req.query.scope === 'network' ? 'network' : 'hospital';
    const events = audit.all();
    const mine = (scope === 'hospital')
      ? events.filter(e => (e.performed_by||'').startsWith(`desk:${req.hospital.hospital_id}`) || e.event_type === 'BROADCAST_CREATED')
      : events;

    const broadcastToAccept = events.filter(e => e.event_type==='ACCEPTED').map(e => e.event_data && e.event_data.seconds_to_accept).filter(x => typeof x === 'number');
    const leadTime = events.filter(e => e.event_type==='ARRIVED').map(e => e.event_data && e.event_data.seconds_accept_to_arrival).filter(x => typeof x === 'number');

    const accepted = events.filter(e => e.event_type==='ACCEPTED').length;
    const created = events.filter(e => e.event_type==='BROADCAST_CREATED').length;
    const expired = events.filter(e => e.event_type==='EXPIRED').length;

    function percentile(arr, p){
      if (!arr.length) return null;
      const a = arr.slice().sort((x,y)=>x-y);
      const idx = Math.min(a.length-1, Math.floor((p/100) * a.length));
      return a[idx];
    }
    function median(arr){ return percentile(arr, 50); }

    let store = 'memory';
    try { store = require('../store').getStore().driver; } catch(_){}

    res.json({
      scope,
      store,
      counts: { created, accepted, expired, lead_time_samples: leadTime.length, time_to_accept_samples: broadcastToAccept.length },
      time_to_accept: { median: median(broadcastToAccept), p90: percentile(broadcastToAccept, 90) },
      lead_time: { median: median(leadTime) },
      accept_rate: created ? Math.round((accepted/created) * 100) : 0,
      delays: events.filter(e => e.event_type==='DELAY_REPORTED').length,
    });
  }catch(e){ res.status(500).json({ success:false }); }
});

module.exports = router;
