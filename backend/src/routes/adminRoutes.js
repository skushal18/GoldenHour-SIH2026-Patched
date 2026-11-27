/* ============================================================================
   Super-admin console API. Every route requires a SUPER_ADMIN login.

   GET  /api/v1/admin/accounts?q=&state=&status=  hospital and admin logins (status PENDING|EXPIRED|LOCKED|DISABLED|ACTIVE)
   POST /api/v1/admin/accounts                  { hospital_id, username? } → temporary password, shown once
                                                { hospital_id, mode: 'activation' } → activation code, shown once
   POST /api/v1/admin/accounts/activation-codes  a PENDING login + activation code for every hospital without a login
   POST /api/v1/admin/accounts/:id/activation   re-issue an activation code (the login goes back to PENDING)
   POST /api/v1/admin/accounts/:id/reset-password                          → temporary password, shown once
   POST /api/v1/admin/accounts/:id/disable | /enable
   GET  /api/v1/admin/directory?q=&state=&limit=  the GoldenHour network (hospitals table)
   GET  /api/v1/admin/directory/states
   GET  /api/v1/admin/directory/summary
   POST /api/v1/admin/directory/import          { ids: [directory id, …] } add hospitals from the national catalogue
   POST /api/v1/admin/directory/:id/enable | /disable  switch a network hospital on or off
   GET  /api/v1/admin/catalogue?q=&state=&limit=  search the all-India catalogue (CSV) to import from
   GET  /api/v1/admin/catalogue/states
   GET  /api/v1/admin/live                      open cases across the network
   GET  /api/v1/admin/audit?limit=              recent sign-in and account events
   ========================================================================== */
'use strict';
const express = require('express');
const router = express.Router();
const auth = require('../services/authService');
const directory = require('../services/directoryService');
const catalogue = require('../services/catalogueService');
const audit = require('../services/auditService');
const { requireAuth } = require('../middleware/auth');
const { getStore, getAccounts } = require('../store');
const tracking = require('../services/trackingService');
const deskLocation = require('../services/deskLocationService');
const { hospitalEnd } = require('../services/broadcastService');
const ambulances = require('../services/ambulanceService');

router.use(requireAuth(['SUPER_ADMIN']));

function send(res, result) {
  if (!result.ok) return res.status(result.status).json({ success: false, reason: result.reason, message: result.message });
  const { ok, ...body } = result;
  return res.json(Object.assign({ success: true }, body));
}

router.get('/accounts', async (req, res, next) => {
  try { res.json({ success: true, accounts: await auth.listAccounts({ q: req.query.q, state: req.query.state, status: req.query.status }) }); }
  catch (err) { next(err); }
});

router.post('/accounts', async (req, res, next) => {
  try {
    const body = req.body || {};
    const byCode = body.mode === 'activation';
    const result = byCode
      ? await auth.createPendingAccount({ hospital_id: body.hospital_id }, req.account)
      : await auth.createHospitalAccount({ hospital_id: body.hospital_id, username: body.username }, req.account);
    if (result.ok) audit.record('ADMIN', 'ACCOUNT_CREATED', { username: result.account.username, hospital_id: result.account.hospital_id,
      method: byCode ? 'activation code' : 'temporary password', by: req.account.username }, { kind: 'admin' });
    send(res.status(result.ok ? 201 : result.status), result);
  } catch (err) { next(err); }
});

/* The codes are in this response and nowhere else: the server keeps only
   their hashes. The console turns them into a CSV for the administrator. */
router.post('/accounts/activation-codes', async (req, res, next) => {
  try {
    const result = await auth.createPendingForAll(req.account);
    audit.record('ADMIN', 'ACTIVATION_CODES_ISSUED', { count: result.created.length, skipped: result.skipped, by: req.account.username }, { kind: 'admin' });
    res.status(201).json({ success: true, skipped: result.skipped, created: result.created.map(r => ({
      account_id: r.account.account_id, hospital_id: r.account.hospital_id, hospital: r.hospital ? r.hospital.name : null,
      district: r.hospital ? r.hospital.district : null, state: r.hospital ? r.hospital.state : null,
      phone: r.hospital ? r.hospital.contact : null, activation_code: r.activation_code, expires_at: r.expires_at })) });
  } catch (err) { next(err); }
});

router.post('/accounts/:id/activation', async (req, res, next) => {
  try {
    const result = await auth.reissueActivation(req.params.id, req.account);
    if (result.ok) audit.record('ADMIN', 'ACTIVATION_REISSUED', { hospital_id: result.account.hospital_id, by: req.account.username }, { kind: 'admin' });
    send(res, result);
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

/* hospital_id → the state of its hospital login, for the directory tables. */
async function loginStates() {
  const out = new Map();
  for (const a of await getAccounts().list()) {
    if (a.role === 'HOSPITAL_STAFF' && !out.has(a.hospital_id)) out.set(a.hospital_id, auth.accountState(a));
  }
  return out;
}

router.get('/directory', async (req, res, next) => {
  try {
    const states = await loginStates();
    const hits = directory.search(req.query.q, { state: req.query.state, limit: req.query.limit || 200,
      emergencyOnly: req.query.emergency === '1', includeInactive: true });
    res.json({ success: true, hospitals: hits.map(h => Object.assign({}, h, { has_login: states.has(h.hospital_id),
      login_state: states.get(h.hospital_id) || null })) });
  } catch (err) { next(err); }
});

router.get('/directory/states', (req, res) => res.json({ success: true, states: directory.states() }));

router.get('/directory/summary', async (req, res, next) => {
  try {
    const ids = await getAccounts().activeHospitalIds();
    const states = Array.from((await loginStates()).values());
    const pending = states.filter(s => s === 'PENDING').length;
    res.json({ success: true, summary: Object.assign(directory.summary(), { hospitals_with_login: ids.length,
      logins_pending: pending, catalogue_records: catalogue.count() }) });
  } catch (err) { next(err); }
});

router.post('/directory/import', async (req, res, next) => {
  try {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) {
      return res.status(400).json({ success: false, reason: 'BAD_IDS', message: 'Send 1–500 directory ids.' });
    }
    const result = await directory.importFromCatalogue(ids);
    if (result.added.length) audit.record('ADMIN', 'HOSPITALS_IMPORTED', { ids: result.added, by: req.account.username }, { kind: 'admin' });
    res.json(Object.assign({ success: true }, result));
  } catch (err) { next(err); }
});

for (const [path, active, event] of [['enable', true, 'HOSPITAL_ENABLED'], ['disable', false, 'HOSPITAL_DISABLED']]) {
  router.post('/directory/:id/' + path, async (req, res, next) => {
    try {
      const h = await directory.setActive(req.params.id, active);
      if (!h) return res.status(404).json({ success: false, reason: 'NOT_FOUND', message: 'That hospital is not in the GoldenHour directory.' });
      audit.record('ADMIN', event, { hospital_id: h.hospital_id, by: req.account.username }, { kind: 'admin' });
      res.json({ success: true, hospital: h });
    } catch (err) { next(err); }
  });
}

router.get('/catalogue', (req, res) => {
  const hits = catalogue.search(req.query.q, { state: req.query.state, limit: req.query.limit,
    emergencyOnly: req.query.emergency === '1' });
  res.json({ success: true, hospitals: hits.map(h => Object.assign({}, h, { in_network: !!directory.get(h.hospital_id) })) });
});

router.get('/catalogue/states', (req, res) => res.json({ success: true, states: catalogue.states() }));

/* Live cases, and what the network map needs: where each open case was sent
   from, where each accepted ambulance is now and where it is going, and the
   hospitals that can receive cases. Patient details stay with the hospitals. */
router.get('/live', async (req, res, next) => {
  try {
    const recent = await getStore().listAll(100);
    const point = (lat, lng) => (lat == null || lng == null ? null : { lat: Number(lat), lng: Number(lng) });
    const cases = recent.map(r => {
      const winner = r.accepted_hospital_id ? r.targets.find(t => t.hospital_id === r.accepted_hospital_id) || null : null;
      const row = {
        case_code: r.case_code, status: r.status, priority: r.priority, chief_complaint: r.chief_complaint,
        created_at: r.created_at, accepted_at: r.accepted_at, arrived_at: r.arrived_at,
        hospitals_notified: r.targets.length,
        accepted_by: winner ? winner.name : null,
        ambulance: r.ambulance ? r.ambulance.registration : (r.ambulance_id || null),
        origin: r.status === 'PENDING' || r.status === 'ACCEPTED' ? point(r.origin && r.origin.lat, r.origin && r.origin.lng) : null,
      };
      if (r.status === 'ACCEPTED' && winner) {
        const live = tracking.snapshot(r.case_code);
        const end = hospitalEnd(r);
        row.destination = end ? { hospital_id: winner.hospital_id, name: winner.name, lat: end.lat, lng: end.lng, source: end.source } : null;
        row.position = live.last_position ? { lat: live.last_position.lat, lng: live.last_position.lng, at: live.last_position.at,
          accuracy_m: live.last_position.accuracy_m, approximate: !!live.last_position.approximate } : null;
        row.remaining_distance_km = live.distance_km == null ? null : Math.round(live.distance_km * 10) / 10;
        row.live_eta_minutes = live.live_eta_minutes;
        row.est_eta_minutes = live.est_eta_minutes;
        row.eta_source = live.eta_source;
      }
      return row;
    });
    const ids = await getAccounts().activeHospitalIds();
    const hospitals = ids.map(id => {
      const h = directory.get(id);
      const end = deskLocation.effective(id);
      if (!h || !end) return null;
      return { hospital_id: id, name: h.name, lat: end.lat, lng: end.lng, source: end.source };
    }).filter(Boolean);
    res.json({ success: true, cases, hospitals });
  } catch (err) { next(err); }
});

/* ── Ambulances: one login per vehicle ─────────────────────────────────────
   Register a vehicle (a one-time sign-in code comes back once), see which
   phone the app is signed in on and the crew on shift, issue a new code
   (signs the old phone out), switch a vehicle off or on, edit details. */
router.get('/ambulances', async (req, res, next) => {
  try {
    const units = await ambulances.list();
    const open = (await getStore().listAll(100)).filter(r => r.ambulance && (r.status === 'PENDING' || r.status === 'ACCEPTED'));
    for (const u of units) {
      const c = open.find(r => r.ambulance.ambulance_id === u.ambulance_id);
      if (!c) { u.current_case = null; continue; }
      const winner = c.accepted_hospital_id ? c.targets.find(t => t.hospital_id === c.accepted_hospital_id) : null;
      const live = c.status === 'ACCEPTED' ? tracking.snapshot(c.case_code) : {};
      u.current_case = { case_code: c.case_code, status: c.status, priority: c.priority, chief_complaint: c.chief_complaint,
        hospital: winner ? winner.name : null, remaining_distance_km: live.distance_km == null ? null : Math.round(live.distance_km * 10) / 10 };
    }
    res.json({ success: true, ambulances: units, vehicle_types: ambulances.VEHICLE_TYPES,
      sign_in_required: ambulances.required() });
  } catch (err) { next(err); }
});
router.post('/ambulances', async (req, res, next) => {
  try {
    const r = await ambulances.create(req.body || {}, req.account);
    if (!r.ok) return res.status(r.status).json({ success: false, reason: r.reason, message: r.message });
    audit.record('ADMIN', 'AMBULANCE_CREATED', { ambulance_id: r.ambulance.ambulance_id, registration: r.ambulance.registration, by: req.account.username }, { kind: 'admin' });
    res.status(201).json({ success: true, ambulance: r.ambulance, sign_in_code: r.sign_in_code, expires_at: r.expires_at });
  } catch (err) { next(err); }
});
router.put('/ambulances/:id', async (req, res, next) => {
  try {
    const r = await ambulances.edit(req.params.id, req.body || {});
    if (!r.ok) return res.status(r.status).json({ success: false, reason: r.reason, message: r.message });
    audit.record('ADMIN', 'AMBULANCE_EDITED', { ambulance_id: r.ambulance.ambulance_id, registration: r.ambulance.registration, by: req.account.username }, { kind: 'admin' });
    res.json({ success: true, ambulance: r.ambulance });
  } catch (err) { next(err); }
});
router.post('/ambulances/:id/code', async (req, res, next) => {
  try {
    const r = await ambulances.reissueCode(req.params.id);
    if (!r.ok) return res.status(r.status).json({ success: false, reason: r.reason, message: r.message });
    audit.record('ADMIN', 'AMBULANCE_CODE_ISSUED', { ambulance_id: r.ambulance.ambulance_id, registration: r.ambulance.registration, by: req.account.username }, { kind: 'admin' });
    res.json({ success: true, ambulance: r.ambulance, sign_in_code: r.sign_in_code, expires_at: r.expires_at });
  } catch (err) { next(err); }
});
for (const [path, on, evt] of [['disable', false, 'AMBULANCE_DISABLED'], ['enable', true, 'AMBULANCE_ENABLED']]) {
  router.post('/ambulances/:id/' + path, async (req, res, next) => {
    try {
      const r = await ambulances.setEnabled(req.params.id, on);
      if (!r.ok) return res.status(r.status).json({ success: false, reason: r.reason, message: r.message });
      audit.record('ADMIN', evt, { ambulance_id: r.ambulance.ambulance_id, registration: r.ambulance.registration, by: req.account.username }, { kind: 'admin' });
      res.json({ success: true, ambulance: r.ambulance });
    } catch (err) { next(err); }
  });
}

router.get('/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const events = audit.all().filter(e => e.case_code === 'AUTH' || e.case_code === 'ADMIN').slice(-limit).reverse();
  res.json({ success: true, events });
});

module.exports = router;
