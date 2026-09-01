/* ============================================================================
   The three endpoints the ambulance app touches.

     GET  /api/v1/case-types
     POST /api/v1/requests
     GET  /api/v1/requests/:caseCode
     POST /api/v1/requests/:caseCode/cancel     (extra — crew stood down)

   Contract is documented in docs/ambulance-app-api-contract.md and has not
   been changed: the app still never sends a priority and never names a
   hospital.
   ========================================================================== */

'use strict';

const express = require('express');
const router = express.Router();

const { CASE_TYPES } = require('../data/caseTypes');
const {
  createBroadcast, cancelBroadcast, toAmbulanceStatus
} = require('../services/broadcastService');
const { getStore } = require('../store');

/* ── GET /case-types ─────────────────────────────────────────────────────── */
router.get('/case-types', (req, res) => {
  res.json(CASE_TYPES);
});

/* ── POST /requests ──────────────────────────────────────────────────────── */
router.post('/requests', async (req, res) => {
  const body = req.body || {};

  if (body.case_type_id === undefined || body.case_type_id === null || body.case_type_id === '') {
    return res.status(400).json({ success: false, message: 'case_type_id is required' });
  }
  /* null is not the same as "missing", and neither is usable here: without
     coordinates there is no distance, so no hospital can be matched. Reject
     loudly rather than storing a case nobody can be dispatched to.

     Note the raw check before Number(): Number(null) is 0, and 0,0 is a real
     point in the Atlantic. Coercing first would have quietly dispatched an
     ambulance to the Gulf of Guinea — the same null-versus-zero trap the
     vitals contract exists to avoid. */
  const coord = (raw, limit) => {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < -limit || n > limit) return null;
    return n;
  };

  const lat = body.origin ? coord(body.origin.lat, 90) : null;
  const lng = body.origin ? coord(body.origin.lng, 180) : null;

  if (lat === null || lng === null) {
    return res.status(400).json({
      success: false,
      message: 'origin.lat and origin.lng are required, and must be real coordinates'
    });
  }

  try {
    const record = await createBroadcast(body, req.app.get('io'));
    res.status(201).json({
      id: record.case_code,
      hospitals_notified: record.targets.length,
      status: record.status,
      priority: record.priority,
      expires_at: record.expires_at
    });
  } catch (err) {
    console.error('POST /requests failed:', err);
    res.status(500).json({ success: false, message: 'Could not create the broadcast' });
  }
});

/* ── GET /requests/:caseCode ─────────────────────────────────────────────── */
router.get('/requests/:caseCode', async (req, res) => {
  try {
    const record = await getStore().getBroadcast(req.params.caseCode);
    if (!record) return res.status(404).json({ success: false, message: 'Request not found' });
    res.json(toAmbulanceStatus(record));
  } catch (err) {
    console.error('GET /requests/:id failed:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ── POST /requests/:caseCode/cancel ─────────────────────────────────────── */
router.post('/requests/:caseCode/cancel', async (req, res) => {
  try {
    const result = await cancelBroadcast(req.params.caseCode, req.app.get('io'));
    if (!result.ok) return res.status(404).json({ success: false, message: 'Request not found' });
    res.json(toAmbulanceStatus(result.record));
  } catch (err) {
    console.error('POST /requests/:id/cancel failed:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
