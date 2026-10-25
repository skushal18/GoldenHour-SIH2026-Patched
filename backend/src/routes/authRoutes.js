/* ============================================================================
   Sign-in for hospital ER desks and GoldenHour administrators.

   POST /api/v1/auth/login            { username, password } → { token, account, hospital }
   GET  /api/v1/auth/me               the signed-in account and its hospital
   POST /api/v1/auth/change-password  { current_password, new_password } → fresh session
   POST /api/v1/auth/logout           ends every session of this login

   There is no public registration: accounts are created by an administrator
   (routes/adminRoutes.js) or at first run (authService.bootstrap).
   ========================================================================== */
'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../services/authService');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/protect');
const { publicView } = require('../store/accountStore');
const audit = require('../services/auditService');

/* Per client address. The per-account lockout in authService is what stops a
   guess against one login from many addresses. */
const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 30, name: 'sign-in attempts' });

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const result = await auth.login(username, password);
    if (!result.ok) {
      if (result.retry_after) res.setHeader('Retry-After', String(result.retry_after));
      audit.record('AUTH', 'SIGN_IN_FAILED', { username: String(username || '').slice(0, 64).toLowerCase(), reason: result.reason }, { kind: 'auth' });
      return res.status(result.status).json({ success: false, reason: result.reason, message: result.message });
    }
    audit.record('AUTH', 'SIGNED_IN', { username: result.session.account.username, hospital_id: result.session.account.hospital_id }, { kind: 'auth' });
    res.json(Object.assign({ success: true }, result.session));
  } catch (err) { next(err); }
});

router.get('/me', requireAuth(null, { allowPasswordChange: true }), (req, res) => {
  res.json({ success: true, account: publicView(req.account), hospital: auth.hospitalFor(req.account) });
});

router.post('/change-password', loginLimiter, requireAuth(null, { allowPasswordChange: true }), async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    const result = await auth.changePassword(req.account, current_password, new_password);
    if (!result.ok) return res.status(result.status).json({ success: false, reason: result.reason, message: result.message });
    audit.record('AUTH', 'PASSWORD_CHANGED', { username: req.account.username }, { kind: 'auth' });
    res.json(Object.assign({ success: true }, result.session));
  } catch (err) { next(err); }
});

router.post('/logout', requireAuth(null, { allowPasswordChange: true }), async (req, res, next) => {
  try { await auth.signOutEverywhere(req.account); res.json({ success: true }); }
  catch (err) { next(err); }
});

module.exports = router;
