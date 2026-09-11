/* ============================================================================
   v5 socketHandler — Part III–V: location, capacity, tracking, analytics.
   ========================================================================== */
'use strict';
const jwt = require('jsonwebtoken');
const hospitalsConfig = require('../config/hospitals');
const { getStore } = require('../store');
const { toDashboardCard, toAmbulanceStatus, updatePatient, markArrived } = require('../services/broadcastService');
const { deskAuthMode } = require('../middleware/hospitalIdentity');
const { lookupHospital } = require('../services/hospitalDirectory');
const tracking = require('../services/trackingService');
const capacity = require('../services/capacityService');
const audit = require('../services/auditService');
const match = require('../services/matchService');

function socketAddress(socket){
  const fwd = socket.handshake.headers['x-forwarded-for'];
  return hospitalsConfig.normaliseIp(fwd || socket.handshake.address || '');
}

async function resolveDeskIdentity(socket, ip){
  if (deskAuthMode() !== 'jwt'){
    const override = socket.handshake.query ? socket.handshake.query.hospital : undefined;
    const r = hospitalsConfig.resolveHospital(ip, override);
    return { hospital: r.hospital, matchedBy: r.matchedBy };
  }
  const token = (socket.handshake.auth && socket.handshake.auth.token) ||
                (socket.handshake.query && socket.handshake.query.token);
  if (!token) return { hospital:null, matchedBy:'rejected', error:'Token required' };
  let claims; try{ claims = jwt.verify(token, process.env.JWT_SECRET); }
  catch(_){ return { hospital:null, matchedBy:'rejected', error:'Invalid token' }; }
  if (!['HOSPITAL_STAFF','ADMIN'].includes(claims.role)) return { hospital:null, matchedBy:'rejected', error:'Not an ER desk' };
  const hospital = await lookupHospital(claims.hospital_id);
  if (!hospital) return { hospital:null, matchedBy:'rejected', error:'Hospital not registered' };
  return { hospital, matchedBy:'token' };
}

function socketHandler(io) {
  capacity.onListener((evt, payload) => {
    // fan out capacity changes to all desks (sidebar will refresh)
    io.of('/').emit(evt, payload);
  });

  io.on('connection', (socket) => {
    const ip = socketAddress(socket);
    const role = socket.handshake.query ? socket.handshake.query.role : undefined;
    socket.data.ip = ip;

    if (role === 'hospital') {
      resolveDeskIdentity(socket, ip).then(resolved => {
        if (!resolved.hospital){
          socket.emit('hospital:rejected', { message: resolved.error });
          socket.disconnect(true); return;
        }
        const hospital = resolved.hospital;
        socket.data.hospital = hospital;
        socket.join(`hospital_${hospital.hospital_id}`);
        socket.emit('hospital:identity', { hospital, matched_by: resolved.matchedBy, client_ip: ip });
        return getStore().listForHospital(hospital.hospital_id)
          .then(records => socket.emit('broadcast:snapshot', records.map(r => toDashboardCard(r, hospital.hospital_id))));
      }).catch(err => console.warn('⚠️  desk socket setup:', err.message));
    }

    /* Both acknowledge. Without an ack a crew's phone cannot tell "I am
       subscribed to this case" from "the server never heard me", and after a
       tunnel that is exactly the distinction that decides whether the app
       falls back to polling. */
    socket.on('case:follow', (caseCode, ack) => {
      const code = String(caseCode || '').trim();
      if (!code) return respond(ack, false, 'NO_CASE', 'case_code required');
      socket.join(`case_${code}`);
      getStore().getBroadcast(code)
        .then(record => {
          if (record) socket.emit('case:status', toAmbulanceStatus(record));
          respond(ack, true, null, 'following', { case_code: code, known: !!record });
        })
        .catch(err => respond(ack, false, 'SERVER_ERROR', err.message));
    });
    socket.on('case:unfollow', (caseCode, ack) => {
      const code = String(caseCode || '').trim();
      if (code) socket.leave(`case_${code}`);
      respond(ack, true, null, 'unfollowed', { case_code: code });
    });

    socket.on('patient:update', (payload, ack) => {
      const safe = payload || {};
      const code = String(safe.case_code || safe.id || '').trim();
      if (!code) return respond(ack, false, 'NO_CASE', 'case_code required');
      updatePatient(code, safe.patient || null, io).then(r => {
        if (!r.ok) return respond(ack, false, r.reason, r.message);
        respond(ack, true, null, 'Patient details updated', { case_code: code, updated_at: r.record.last_patient_updated_at });
      }).catch(err => respond(ack, false, 'SERVER_ERROR', err.message));
    });

    socket.on('ambulance:arrived', (payload, ack) => {
      const safe = payload || {};
      const code = String(safe.case_code || safe.id || '').trim();
      if (!code) return respond(ack, false, 'NO_CASE', 'case_code required');
      markArrived(code, { hospital_id: safe.hospital_id }, io).then(r => {
        if (!r.ok) return respond(ack, false, r.reason, r.message);
        respond(ack, true, null, 'Arrival recorded', { case_code: code, arrived_at: r.record.arrived_at });
      }).catch(err => respond(ack, false, 'SERVER_ERROR', err.message));
    });

    socket.on('hospital:identify', (hospitalId) => {
      if (deskAuthMode() === 'jwt') return;
      const resolved = hospitalsConfig.resolveHospital(ip, hospitalId);
      if (socket.data.hospital) socket.leave(`hospital_${socket.data.hospital.hospital_id}`);
      socket.data.hospital = resolved.hospital;
      socket.join(`hospital_${resolved.hospital.hospital_id}`);
      socket.emit('hospital:identity', { hospital: resolved.hospital, matched_by: resolved.matchedBy, client_ip: ip });
    });

    /* v5 ─ ambulance:position (Part III) */
    socket.on('ambulance:position', (payload, ack) => {
      const safe = payload || {};
      const code = String(safe.case_code || '').trim();
      if (!code) return respond(ack, false, 'NO_CASE', 'case_code required');
      getStore().getBroadcast(code).then(record => {
        if (!record) return respond(ack, false, 'NOT_FOUND', 'Case not found');
        if (record.status !== 'ACCEPTED' || record.arrived_at) return respond(ack, false, 'NOT_TRACKING', 'Case is not in tracking state');
        if (safe.lat == null || safe.lng == null) return respond(ack, false, 'INVALID_COORD', 'lat/lng required');
        const winner = record.targets.find(t => t.hospital_id === record.accepted_hospital_id);
        if (!winner) return respond(ack, false, 'NO_ACCEPTOR', 'No accepting hospital');

        const r = tracking.append(code, winner.lat, winner.lng, {
          lat: Number(safe.lat), lng: Number(safe.lng),
          accuracy_m: safe.accuracy_m == null ? null : Number(safe.accuracy_m),
          speed_kmh: safe.speed_kmh == null ? null : Number(safe.speed_kmh),
          source: safe.source || 'gps',
          at: safe.at || new Date().toISOString(),
        });
        if (r.throttled) return respond(ack, true, null, 'throttled');
        Object.assign(record, { last_position: r.record.last_position,
          live_eta_minutes: r.record.live_eta_minutes, eta_source: r.record.eta_source });
        audit.record(code, 'POSITION', { lat: r.point.lat, lng: r.point.lng,
          live_eta: r.record.live_eta_minutes, eta_source: r.record.eta_source },
          { kind:'crew' });
        /* The accepting hospital gets the full position — that is the whole
           point of the feature. */
        io.to(`hospital_${record.accepted_hospital_id}`).emit('case:position', {
          case_code: code, lat: r.point.lat, lng: r.point.lng,
          accuracy_m: r.point.accuracy_m, speed_kmh: r.point.speed_kmh,
          source: r.point.source, at: r.point.at,
          distance_km: winner.distance_km,
          live_eta_minutes: r.record.live_eta_minutes,
          eta_source: r.record.eta_source,
        });

        /* The crew gets only what it does not already know: the derived ETA
           and how far there is to go. Coordinates are deliberately withheld —
           the ambulance is the source of them, and anyone holding a case code
           can join the case room, so echoing them back would turn a case code
           into a way to track a vehicle. */
        io.to(`case_${code}`).emit('case:position', {
          case_code: code,
          distance_km: winner.distance_km,
          live_eta_minutes: r.record.live_eta_minutes,
          eta_source: r.record.eta_source,
          at: r.point.at,
        });
        respond(ack, true, null, 'ok');
      }).catch(err => respond(ack, false, 'SERVER_ERROR', err.message));
    });

    /* v5 ─ ambulance:delayed (Part III §4.6) */
    socket.on('ambulance:delayed', (payload, ack) => {
      const safe = payload || {};
      const code = String(safe.case_code || '').trim();
      const reason = safe.reason || 'unknown';
      getStore().getBroadcast(code).then(record => {
        if (!record || record.status !== 'ACCEPTED') return respond(ack, false, 'NOT_TRACKING');
        audit.record(code, 'DELAY_REPORTED', { reason, minutes_stalled: safe.minutes_stalled||0 }, { kind:'crew' });
        if (record.accepted_hospital_id)
          io.to(`hospital_${record.accepted_hospital_id}`).emit('case:delay', {
            case_code: code, reason, minutes_stalled: safe.minutes_stalled||0 });
        respond(ack, true, null, 'log');
      }).catch(err => respond(ack, false, 'SERVER_ERROR', err.message));
    });

    /* v5 ─ capacity:updated (Part IV) - desk side */
    socket.on('capacity:updated', (payload, ack) => {
      const safe = payload || {};
      if (!socket.data.hospital) return respond(ack, false, 'NO_IDENTITY');
      const updated = capacity.upsert(socket.data.hospital.hospital_id, safe);
      audit.record('CAPACITY', 'CAPACITY_CHANGED',
        { hospital_id: socket.data.hospital.hospital_id, after: updated, actor_kind:'desk' },
        { kind:'desk', hospital_id: socket.data.hospital.hospital_id });
      respond(ack, true, null, 'ok', updated);
    });

    /* legacy fallback (kept for older clients) */
    socket.on('join_case', (id) => socket.join(`case_${id}`));
    socket.on('join_hospital', (id) => { if (deskAuthMode()==='jwt') return; socket.join(`hospital_${id}`); });
    socket.on('location_update', (data) => { if (!data) return;
      io.to(`hospital_${data.hospital_id}`).emit('ambulance_location', data);
      io.to(`case_${data.case_id}`).emit('eta_updated', data);
    });
  });
}

function respond(ack, ok, reason, message, extra){
  if (typeof ack !== 'function') return;
  const body = Object.assign({ success: !!ok }, extra || {});
  if (!ok){ body.success = false; body.reason = reason; body.message = message; }
  try { ack(body); } catch(_){}
}
module.exports = socketHandler;
