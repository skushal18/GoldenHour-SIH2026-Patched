/* ============================================================================
   Ambulance-facing routes: create a broadcast, read its status, cancel it,
   record arrival.

   These are the endpoints a crew's phone depends on, so they are the ones
   that must not surprise anybody. Two things are load-bearing:

   * Idempotency. The offline outbox retries, and "flush on `online`" and
     "flush on socket connect" can fire together. Without a client request id
     that pair puts the same patient on two ER boards.

   * Validation before creation. A case that reaches a desk is a case a nurse
     acts on; it is much cheaper to refuse a malformed one here than to
     explain a phantom ambulance later.
   ========================================================================== */
'use strict';

const express = require('express');
const router = express.Router();

const { CASE_TYPES } = require('../data/caseTypes');
const { createBroadcast, cancelBroadcast, markArrived, toAmbulanceStatus, crewTokenValid } = require('../services/broadcastService');
const { getStore } = require('../store');
const { validateBroadcast } = require('../services/validation');
const { createRateLimiter } = require('../middleware/protect');

/* ── Idempotency ────────────────────────────────────────────────────────────
   client_request_id -> { case_code, expires }. In-process because the
   deployment is a single instance; a multi-instance deployment would move
   this to the database or to Redis, and the TTL is the only tuning knob. */
const idemMap = new Map();
const IDEM_TTL = Number(process.env.REQUEST_IDEMPOTENCY_TTL_MS || 30 * 60 * 1000);

const idemSweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idemMap.entries()) if (entry.expires < now) idemMap.delete(key);
}, 60_000);
if (idemSweeper.unref) idemSweeper.unref();

/* Generous on purpose: a refused emergency broadcast is a far worse failure
   than the flood this prevents. It is a runaway-client guard, not a policy. */
const broadcastLimiter = createRateLimiter({ windowMs: 60_000, max: 30, name: 'broadcasts' });
const readLimiter = createRateLimiter({ windowMs: 60_000, max: 600, name: 'status checks' });

router.get('/case-types', readLimiter, (req, res) => res.json(CASE_TYPES));

router.post('/requests', broadcastLimiter, async (req, res, next) => {
  const body = req.body || {};
  const crid = req.get('X-Client-Request-Id') || body.client_request_id || null;

  if (crid && idemMap.has(crid)) {
    const entry = idemMap.get(crid);
    if (entry.expires > Date.now()) {
      const record = await getStore().getBroadcast(entry.case_code);
      /* 200, not 201: this repeat created nothing. The client can tell the
         difference and so can anybody reading the access log. */
      return res.status(200).json({
        id: entry.case_code,
        crew_token: entry.crew_token,
        hospitals_notified: record ? record.targets.length : 0,
        status: record && record.status,
        priority: record && record.priority,
        expires_at: record && record.expires_at,
        call_ahead: (record && record.call_ahead) || [],
        idempotent_replay: true,
      });
    }
    idemMap.delete(crid);
  }

  const valid = validateBroadcast(body);
  if (!valid.ok) {
    return res.status(400).json({ success: false, reason: 'INVALID_REQUEST', field: valid.field, message: valid.message });
  }

  try {
    const record = await createBroadcast(body, req.app.get('io'));
    /* The replay entry keeps the crew token so a retried POST (offline
       outbox, double flush) hands the same ambulance the same token. It
       lives only in process memory, for REQUEST_IDEMPOTENCY_TTL_MS. */
    if (crid) idemMap.set(crid, { case_code: record.case_code, crew_token: record.crew_token, expires: Date.now() + IDEM_TTL });
    res.status(201).json({
      id: record.case_code,
      crew_token: record.crew_token,
      hospitals_notified: record.targets.length,
      status: record.status,
      priority: record.priority,
      expires_at: record.expires_at,
      call_ahead: record.call_ahead || [],
    });
  } catch (err) {
    next(err);
  }
});

/* Everything below acts on one case and needs that case's crew token,
   sent as X-Crew-Token. A wrong token and a missing case look the same, so
   probing sequential codes learns nothing. */
function crewToken(req) { return req.get('X-Crew-Token') || (req.body && req.body.crew_token) || null; }
async function loadForCrew(req, res) {
  const record = await getStore().getBroadcast(req.params.code);
  if (!record || !crewTokenValid(record, crewToken(req))) {
    res.status(404).json({ success: false, reason: 'NOT_FOUND', message: 'No such case for this ambulance' });
    return null;
  }
  return record;
}

router.get('/requests/:code', readLimiter, async (req, res, next) => {
  try {
    const record = await loadForCrew(req, res);
    if (!record) return;
    res.json(toAmbulanceStatus(record));
  } catch (err) { next(err); }
});

router.post('/requests/:code/cancel', broadcastLimiter, async (req, res, next) => {
  try {
    if (!(await loadForCrew(req, res))) return;
    const result = await cancelBroadcast(req.params.code, req.app.get('io'));
    if (!result.ok) return res.status(404).json({ success: false, reason: 'NOT_FOUND', message: 'No such case' });
    res.json(toAmbulanceStatus(result.record));
  } catch (err) { next(err); }
});

/* The socket is the normal path for arrival, because the crew's phone is
   already holding one. This exists for the case that matters most: the socket
   dropped somewhere between acceptance and the hospital forecourt, and the
   crew still has to be able to close the case. Arrival is always recorded at
   the accepting hospital; the body cannot name another. */
router.post('/requests/:code/arrived', broadcastLimiter, async (req, res, next) => {
  try {
    if (!(await loadForCrew(req, res))) return;
    const result = await markArrived(req.params.code, { actor: 'crew' }, req.app.get('io'));
    if (!result.ok) {
      const status = result.reason === 'NOT_FOUND' ? 404 : 409;
      return res.status(status).json({ success: false, reason: result.reason, message: result.message });
    }
    res.json(Object.assign({ success: true, already: !!result.already }, toAmbulanceStatus(result.record)));
  } catch (err) { next(err); }
});

module.exports = router;
