/* ============================================================================
   Super-admin console API. Every route requires a SUPER_ADMIN login.

   GET  /api/v1/admin/accounts?q=&state=        hospital and admin logins
   POST /api/v1/admin/accounts                  { hospital_id, username? } → temporary password, shown once
   POST /api/v1/admin/accounts/:id/reset-password                          → temporary password, shown once
   POST /api/v1/admin/accounts/:id/disable | /enable
   GET  /api/v1/admin/directory?q=&state=&limit=  search the all-India directory
   GET  /api/v1/admin/directory/states
   GET  /api/v1/admin/directory/summary
   GET  /api/v1/admin/live                      open cases across the network
   GET  /api/v1/admin/audit?limit=              recent sign-in and account events
   ========================================================================== */
'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../services/authService');
const directory = require('../services/directoryService');
const audit = require('../services/auditService');
const { requireAuth } = require('../middleware/auth');
const { getStore, getAccounts } = require('../store');

router.use(requireAuth(['SUPER_ADMIN']));

function send(res, result) {
  if (!result.ok) return res.status(result.status).json({ success: false, reason: result.reason, message: result.message });
  const { ok, ...body } = result;
  return res.json(Object.assign({ success: true }, body));
}

router.get('/accounts', async (req, res, next) => {
  try { res.json({ success: true, accounts: await auth.listAccounts({ q: req.query.q, state: req.query.state }) }); }
  catch (err) { next(err); }
});

router.post('/accounts', async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await auth.createHospitalAccount({ hospital_id: body.hospital_id, username: body.username }, req.account);
    if (result.ok) audit.record('ADMIN', 'ACCOUNT_CREATED', { username: result.account.username, hospital_id: result.account.hospital_id, by: req.account.username }, { kind: 'admin' });
    send(res.status(result.ok ? 201 : result.status), result);
  } catch (err) { next(err); }
});

router.post('/accounts/:id/reset-password', async (req, res, next) => {
  try {
    const result = await auth.resetPassword(req.params.id, req.account);
    if (result.ok) audit.record('ADMIN', 'PASSWORD_RESET', { username: result.account.username, by: req.account.username }, { kind: 'admin' });
    send(res, result);
  } catch (err) { next(err); }
});

for (const [path, status, event] of [['disable', 'DISABLED', 'ACCOUNT_DISABLED'], ['enable', 'ACTIVE', 'ACCOUNT_ENABLED']]) {
  router.post('/accounts/:id/' + path, async (req, res, next) => {
    try {
      const result = await auth.setStatus(req.params.id, status, req.account);
      if (result.ok) audit.record('ADMIN', event, { username: result.account.username, by: req.account.username }, { kind: 'admin' });
      send(res, result);
    } catch (err) { next(err); }
  });
}

router.get('/directory', async (req, res, next) => {
  try {
    const accounts = await getAccounts().list();
    const withLogin = new Set(accounts.filter(a => a.role === 'HOSPITAL_STAFF').map(a => a.hospital_id));
    const hits = directory.search(req.query.q, { state: req.query.state, limit: req.query.limit,
      emergencyOnly: req.query.emergency === '1' });
    res.json({ success: true, hospitals: hits.map(h => Object.assign({}, h, { has_login: withLogin.has(h.hospital_id) })) });
  } catch (err) { next(err); }
});

router.get('/directory/states', (req, res) => res.json({ success: true, states: directory.states() }));

router.get('/directory/summary', async (req, res, next) => {
  try {
    const ids = await getAccounts().activeHospitalIds();
    res.json({ success: true, summary: Object.assign(directory.summary(), { hospitals_with_login: ids.length }) });
  } catch (err) { next(err); }
});

router.get('/live', async (req, res, next) => {
  try {
    const recent = await getStore().listAll(100);
    res.json({ success: true, cases: recent.map(r => ({
      case_code: r.case_code, status: r.status, priority: r.priority, chief_complaint: r.chief_complaint,
      created_at: r.created_at, accepted_at: r.accepted_at, arrived_at: r.arrived_at,
      hospitals_notified: r.targets.length,
      accepted_by: r.accepted_hospital_id ? ((r.targets.find(t => t.hospital_id === r.accepted_hospital_id) || {}).name || null) : null,
    })) });
  } catch (err) { next(err); }
});

router.get('/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const events = audit.all().filter(e => e.case_code === 'AUTH' || e.case_code === 'ADMIN').slice(-limit).reverse();
  res.json({ success: true, events });
});

module.exports = router;
