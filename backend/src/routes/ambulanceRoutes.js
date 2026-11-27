/* ============================================================================
   The signed-in ambulance app: who am I, the phone I run on, the crew on
   shift, sign out. Every route needs the ambulance's own token.
   ========================================================================== */
'use strict';
const express = require('express');
const router = express.Router();
const ambulances = require('../services/ambulanceService');
const audit = require('../services/auditService');
const { createRateLimiter } = require('../middleware/protect');

const limiter = createRateLimiter({ windowMs: 60_000, max: 120, name: 'ambulance app requests' });

router.use(limiter, async (req, res, next) => {
  try {
    const h = req.get('Authorization') || '';
    const token = /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
    const v = await ambulances.verify(token);
    if (!v.ok) return res.status(v.status).json({ success: false, reason: v.reason, message: v.message });
    req.ambulance = v.ambulance;
    next();
  } catch (err) { next(err); }
});

router.get('/me', (req, res) => res.json({ success: true, ambulance: ambulances.view(req.ambulance),
  vehicle_types: ambulances.VEHICLE_TYPES, crew_roles: ambulances.CREW_ROLES, max_crew: ambulances.MAX_CREW }));

/* The app reports the phone it runs on when it opens and every few minutes. */
router.post('/heartbeat', async (req, res, next) => {
  try { res.json({ success: true, ambulance: await ambulances.heartbeat(req.ambulance, (req.body || {}).device) }); }
  catch (err) { next(err); }
});

router.put('/crew', async (req, res, next) => {
  try {
    const r = await ambulances.setCrew(req.ambulance, (req.body || {}).crew);
    if (!r.ok) return res.status(r.status).json({ success: false, reason: r.reason, message: r.message });
    res.json({ success: true, ambulance: r.ambulance });
  } catch (err) { next(err); }
});

router.post('/sign-out', async (req, res, next) => {
  try {
    await ambulances.signOut(req.ambulance);
    audit.record('ADMIN', 'AMBULANCE_SIGNED_OUT', { ambulance_id: req.ambulance.ambulance_id, registration: req.ambulance.registration }, { kind: 'ambulance' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
