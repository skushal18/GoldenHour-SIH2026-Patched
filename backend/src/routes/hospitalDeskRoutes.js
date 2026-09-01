/* ============================================================================
   The hospital laptop's own API.

     GET  /api/v1/desk/me                     who am I, judged by my IP
     GET  /api/v1/desk/laptops                the hardcoded map, for the docs page
     GET  /api/v1/desk/queue                  cases waiting for MY answer
     GET  /api/v1/desk/history                everything I have seen
     POST /api/v1/desk/accept/:caseCode       claim it (first one wins)
     POST /api/v1/desk/decline/:caseCode      pass on it

   Unauthenticated by default: for the internal hackathon the LAN is the
   security boundary and a login screen between a judge and the demo is a
   liability. Set DESK_AUTH=jwt before this is reachable from anywhere but a
   closed network — see DEPLOYMENT.md. The authenticated /api/v1/hospitals
   routes are untouched either way.
   ========================================================================== */

'use strict';

const express = require('express');
const router = express.Router();

const hospitalsConfig = require('../config/hospitals');
const { deskGuard, deskAuthMode } = require('../middleware/hospitalIdentity');
const { getStore } = require('../store');
const {
  acceptBroadcast, declineBroadcast, toDashboardCard
} = require('../services/broadcastService');

router.use(deskGuard);

/* ── Identity ────────────────────────────────────────────────────────────── */
router.get('/me', (req, res) => {
  res.json({
    hospital: req.hospital,
    matched_by: req.hospitalMatchedBy,   // 'ip' | 'override' | 'fallback'
    client_ip: req.clientIp,
    hackathon_mode: hospitalsConfig.HACKATHON_MODE,
    accept_window_seconds: hospitalsConfig.ACCEPT_WINDOW_SECONDS,
    auth_mode: deskAuthMode()
  });
});

router.get('/laptops', (req, res) => {
  res.json({
    hackathon_mode: hospitalsConfig.HACKATHON_MODE,
    laptops: hospitalsConfig.HOSPITAL_LAPTOPS.map(h => ({
      hospital_id: h.hospital_id, code: h.code, ip: h.ip, name: h.name, accent: h.accent
    }))
  });
});

/* ── Board ───────────────────────────────────────────────────────────────── */
/* /queue now returns BOTH the incoming queue and the active case cards (spec §21).
   The legacy `cases` field still carries the combined list so dashboard.js can
   be tested with the old contract; new clients should prefer the split fields. */
router.get('/queue', async (req, res) => {
  try {
    const records = await getStore().listForHospital(req.hospital.hospital_id);
    const cards = records.map(r => toDashboardCard(r, req.hospital.hospital_id));
    const pending = cards.filter(c => c.lifecycle === 'pending');
    const active  = cards.filter(c => c.lifecycle === 'active');
    res.json({
      hospital: req.hospital,
      matched_by: req.hospitalMatchedBy,
      cases: cards,
      pending,
      active
    });
  } catch (err) {
    console.error('GET /desk/queue failed:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const records = await getStore().listForHospital(req.hospital.hospital_id, { includeResolved: true });
    res.json({
      hospital: req.hospital,
      cases: records.slice(0, 50).map(r => toDashboardCard(r, req.hospital.hospital_id))
    });
  } catch (err) {
    console.error('GET /desk/history failed:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ── Accept — the moment the whole demo exists for ───────────────────────── */
router.post('/accept/:caseCode', async (req, res) => {
  try {
    const result = await acceptBroadcast(req.params.caseCode, req.hospital.hospital_id, req.app.get('io'));

    if (!result.ok) {
      const code = result.reason === 'NOT_FOUND' ? 404 : 409;
      return res.status(code).json({
        success: false,
        reason: result.reason,
        message:
          result.reason === 'ALREADY_ACCEPTED'
            ? `Already accepted by ${result.accepted_by || 'another hospital'}`
            : result.reason === 'NOT_FOUND' ? 'Case not found'
            : result.reason === 'EXPIRED' ? 'This request expired'
            : result.reason === 'CANCELLED' ? 'The ambulance stood this request down'
            : 'This request is no longer open',
        accepted_by: result.accepted_by || null,
        accepted_hospital_id: result.accepted_hospital_id || null
      });
    }

    res.json({
      success: true,
      message: 'Case accepted — cleared from every other hospital',
      case: toDashboardCard(result.record, req.hospital.hospital_id)
    });
  } catch (err) {
    console.error('POST /desk/accept failed:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ── Decline ─────────────────────────────────────────────────────────────── */
router.post('/decline/:caseCode', async (req, res) => {
  try {
    const result = await declineBroadcast(req.params.caseCode, req.hospital.hospital_id, req.app.get('io'));
    if (!result.ok) return res.status(404).json({ success: false, message: 'Case not found' });
    res.json({ success: true, case: toDashboardCard(result.record, req.hospital.hospital_id) });
  } catch (err) {
    console.error('POST /desk/decline failed:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
