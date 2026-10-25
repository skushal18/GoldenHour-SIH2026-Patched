/* ============================================================================
   Realtime channel.

   Two kinds of client connect:

   * ER desks (query role=hospital). Under DESK_AUTH=jwt the handshake must
     carry the desk's sign-in token (auth.token); the hospital room it joins
     comes from that account, so a desk only ever receives its own hospital's
     cases. No token, a revoked token or an administrator token: refused and
     disconnected. Desks also join the shared `desks` room for capacity news.

   * Ambulance crews. Every crew event names a case AND carries that case's
     crew token (returned once by POST /requests). Without it a crew socket
     can do nothing: case codes are sequential and must not be enough to read
     a patient's details, move the ambulance on a hospital's map or close
     the case.

   The v4 events join_case, join_hospital and location_update are gone: they
   let any socket join any room or push a fake location to any hospital.
   ========================================================================== */
'use strict';
const hospitalsConfig = require('../config/hospitals');
const { getStore } = require('../store');
const { toDashboardCard, toAmbulanceStatus, updatePatient, markArrived, crewTokenValid } = require('../services/broadcastService');
const { deskAuthMode } = require('../middleware/hospitalIdentity');
const auth = require('../services/authService');
const tracking = require('../services/trackingService');
const capacity = require('../services/capacityService');
const audit = require('../services/auditService');

const DELAY_REASONS = ['traffic', 'road_blocked', 'vehicle_issue', 'patient_deteriorating', 'diverting', 'other'];

function socketAddress(socket) {
  return hospitalsConfig.normaliseIp(socket.handshake.address || '');
}

async function resolveDeskIdentity(socket, ip) {
  if (deskAuthMode() !== 'jwt') {
    const override = socket.handshake.query ? socket.handshake.query.hospital : undefined;
    const r = hospitalsConfig.resolveHospital(ip, override);
    return { hospital: r.hospital, matchedBy: r.matchedBy };
  }
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const result = await auth.verify(token);
  if (!result.ok) return { hospital: null, error: result.message, reason: result.reason };
  const account = result.account;
  if (account.role !== 'HOSPITAL_STAFF') return { hospital: null, error: 'Not an ER desk login', reason: 'FORBIDDEN' };
  if (account.must_change_password) return { hospital: null, error: 'Set a new password first', reason: 'PASSWORD_CHANGE_REQUIRED' };
  const hospital = auth.hospitalFor(account);
  if (!hospital) return { hospital: null, error: 'Login not linked to a hospital', reason: 'NO_HOSPITAL' };
  return { hospital, matchedBy: 'account', account };
}

/* Loads a case for a crew event and checks its token. */
async function crewCase(payload) {
  const safe = payload && typeof payload === 'object' ? payload : {};
  const code = String(safe.case_code || safe.id || '').trim();
  if (!code) return { error: ['NO_CASE', 'case_code required'] };
  const record = await getStore().getBroadcast(code);
  if (!record || !crewTokenValid(record, safe.crew_token)) return { error: ['NOT_FOUND', 'No such case for this ambulance'] };
  return { code, record, safe };
}

function socketHandler(io) {
  capacity.onListener((evt, payload) => {
    /* Capacity is for desks, not for every connected ambulance. */
    io.to('desks').emit(evt, payload);
  });

  io.on('connection', (socket) => {
    const ip = socketAddress(socket);
    const role = socket.handshake.query ? socket.handshake.query.role : undefined;
    socket.data.ip = ip;

    if (role === 'hospital') {
      resolveDeskIdentity(socket, ip).then(resolved => {
        if (!resolved.hospital) {
          socket.emit('hospital:rejected', { message: resolved.error, reason: resolved.reason });
          socket.disconnect(true); return;
        }
        const hospital = resolved.hospital;
        socket.data.hospital = hospital;
        socket.data.accountId = resolved.account ? resolved.account.account_id : null;
        socket.join(`hospital_${hospital.hospital_id}`);
        socket.join('desks');
        socket.emit('hospital:identity', { hospital, matched_by: resolved.matchedBy });
        return getStore().listForHospital(hospital.hospital_id)
          .then(records => socket.emit('broadcast:snapshot', records.map(r => toDashboardCard(r, hospital.hospital_id))));
      }).catch(err => { console.warn('⚠️  desk socket setup:', err.message); socket.disconnect(true); });
    }

    /* ── crew ─────────────────────────────────────────────────────────── */

    socket.on('case:follow', (payload, ack) => {
      crewCase(payload).then(c => {
        if (c.error) return respond(ack, false, c.error[0], c.error[1]);
        socket.join(`case_${c.code}`);
        socket.emit('case:status', toAmbulanceStatus(c.record));
        respond(ack, true, null, 'following', { case_code: c.code });
      }).catch(err => respond(ack, false, 'SERVER_ERROR', err.message));
    });

    socket.on('case:unfollow', (payload, ack) => {
      const code = String((payload && payload.case_code) || payload || '').trim();
      if (code) socket.leave(`case_${code}`);
      respond(ack, true, null, 'unfollowed', { case_code: code });
    });

    socket.on('patient:update', (payload, ack) => {
      crewCase(payload).then(c => {
        if (c.error) return respond(ack, false, c.error[0], c.error[1]);
        return updatePatient(c.code, c.safe.patient || null, io).then(r => {
          if (!r.ok) return respond(ack, false, r.reason, r.message);
          respond(ack, true, null, 'Patient details updated', { case_code: c.code, updated_at: r.record.last_patient_updated_at });
        });
      }).catch(err => respond(ack, false, 'SERVER_ERROR', err.message));
    });

    socket.on('ambulance:arrived', (payload, ack) => {
      crewCase(payload).then(c => {
        if (c.error) return respond(ack, false, c.error[0], c.error[1]);
        return markArrived(c.code, { actor: 'crew' }, io).then(r => {
          if (!r.ok) return respond(ack, false, r.reason, r.message);
          respond(ack, true, null, 'Arrival recorded', { case_code: c.code, arrived_at: r.record.arrived_at });
        });
      }).catch(err => respond(ack, false, 'SERVER_ERROR', err.message));
    });

    socket.on('ambulance:position', (payload, ack) => {
      crewCase(payload).then(c => {
        if (c.error) return respond(ack, false, c.error[0], c.error[1]);
        const { code, record, safe } = c;
        if (record.status !== 'ACCEPTED' || record.arrived_at) return respond(ack, false, 'NOT_TRACKING', 'Case is not in tracking state');
        if (safe.lat == null || safe.lng == null) return respond(ack, false, 'INVALID_COORD', 'lat/lng required');
        const winner = record.targets.find(t => t.hospital_id === record.accepted_hospital_id);
        if (!winner) return respond(ack, false, 'NO_ACCEPTOR', 'No accepting hospital');

        const r = tracking.append(code, winner.lat, winner.lng, {
          lat: safe.lat, lng: safe.lng,
          accuracy_m: safe.accuracy_m == null ? null : Number(safe.accuracy_m),
          speed_kmh: safe.speed_kmh == null ? null : Number(safe.speed_kmh),
          source: 'gps',
          at: safe.at || new Date().toISOString(),
        });
        if (r.error) return respond(ack, false, r.error, 'Location fix is invalid, inaccurate or too old');
        if (r.throttled) return respond(ack, true, null, 'throttled');
        const live = tracking.snapshot(code);
        audit.record(code, 'POSITION', { lat: r.point.lat, lng: r.point.lng,
          live_eta: r.record.live_eta_minutes, eta_source: r.record.eta_source }, { kind: 'crew' });
        /* The accepting hospital gets the full position. */
        io.to(`hospital_${record.accepted_hospital_id}`).emit('case:position', {
          case_code: code, lat: r.point.lat, lng: r.point.lng,
          accuracy_m: r.point.accuracy_m, speed_kmh: r.point.speed_kmh,
          source: r.point.source, at: r.point.at,
          distance_km: live.distance_km, live_eta_minutes: live.live_eta_minutes, eta_source: live.eta_source,
        });
        /* The crew gets only the derived ETA and distance. */
        io.to(`case_${code}`).emit('case:position', {
          case_code: code, distance_km: live.distance_km,
          live_eta_minutes: live.live_eta_minutes, eta_source: live.eta_source, at: r.point.at,
        });
        respond(ack, true, null, 'ok');
      }).catch(err => respond(ack, false, 'SERVER_ERROR', err.message));
    });

    socket.on('ambulance:delayed', (payload, ack) => {
      crewCase(payload).then(c => {
        if (c.error) return respond(ack, false, c.error[0], c.error[1]);
        const { code, record, safe } = c;
        if (record.status !== 'ACCEPTED') return respond(ack, false, 'NOT_TRACKING', 'Only an accepted case can report a delay');
        const reason = DELAY_REASONS.indexOf(safe.reason) !== -1 ? safe.reason : 'other';
        const minutes = Number.isFinite(Number(safe.extra_minutes)) ? Math.max(0, Math.min(180, Math.round(Number(safe.extra_minutes)))) : null;
        const at = new Date().toISOString();
        audit.record(code, 'DELAY_REPORTED', { reason, extra_minutes: minutes }, { kind: 'crew' });
        io.to(`hospital_${record.accepted_hospital_id}`).emit('case:delay', { case_code: code, reason, extra_minutes: minutes, at });
        respond(ack, true, null, 'The hospital has been told', { at });
      }).catch(err => respond(ack, false, 'SERVER_ERROR', err.message));
    });

    /* ── desk ─────────────────────────────────────────────────────────── */

    socket.on('capacity:updated', (payload, ack) => {
      if (!socket.data.hospital) return respond(ack, false, 'NO_IDENTITY', 'Not an identified desk');
      const updated = capacity.upsert(socket.data.hospital.hospital_id, payload || {});
      if (updated.error) return respond(ack, false, 'INVALID_CAPACITY', updated.message);
      audit.record('CAPACITY', 'CAPACITY_CHANGED',
        { hospital_id: socket.data.hospital.hospital_id, after: updated },
        { kind: 'desk', hospital_id: socket.data.hospital.hospital_id });
      respond(ack, true, null, 'ok', updated);
    });

    /* LAN rehearsal only: switch which demo laptop this desk is. */
    socket.on('hospital:identify', (hospitalId) => {
      if (deskAuthMode() === 'jwt') return;
      const resolved = hospitalsConfig.resolveHospital(ip, hospitalId);
      if (socket.data.hospital) socket.leave(`hospital_${socket.data.hospital.hospital_id}`);
      socket.data.hospital = resolved.hospital;
      socket.join(`hospital_${resolved.hospital.hospital_id}`);
      socket.join('desks');
      socket.emit('hospital:identity', { hospital: resolved.hospital, matched_by: resolved.matchedBy });
    });
  });
}

function respond(ack, ok, reason, message, extra) {
  if (typeof ack !== 'function') return;
  const body = Object.assign({ success: !!ok }, extra || {});
  if (!ok) { body.success = false; body.reason = reason; body.message = message; }
  else if (message) body.message = message;
  try { ack(body); } catch (_) { }
}

module.exports = socketHandler;
module.exports.DELAY_REASONS = DELAY_REASONS;
