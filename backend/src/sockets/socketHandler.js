/* ============================================================================
   Realtime.

   A hospital laptop does not have to ask which room to join — the server
   already knows, from the socket's IP address. That is the whole point of
   the hardcoded map: plug the laptop in, open the page, and it *is* that
   hospital.

   Rooms
     hospital_<id>   one per laptop
     case_<caseCode> one per live broadcast, joined by the ambulance

   Events out
     hospital:identity     "you are City Emergency Hospital"
     broadcast:new         a fresh case, pushed to both laptops at once
     broadcast:claimed     someone accepted — losers drop the card
     broadcast:declined / broadcast:cancelled / broadcast:expired
     case:status           the ambulance's live status line
   ========================================================================== */

'use strict';

const jwt = require('jsonwebtoken');
const hospitalsConfig = require('../config/hospitals');
const { getStore } = require('../store');
const { toDashboardCard, toAmbulanceStatus, updatePatient, markArrived } = require('../services/broadcastService');
const { deskAuthMode } = require('../middleware/hospitalIdentity');
const { lookupHospital } = require('../services/hospitalDirectory');

function socketAddress(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  return hospitalsConfig.normaliseIp(forwarded || socket.handshake.address || '');
}

/**
 * Work out which hospital a desk socket belongs to, honouring DESK_AUTH.
 * In jwt mode a socket with no valid token gets no room at all — the board
 * would otherwise receive live patient data over a channel the HTTP side
 * refuses to serve.
 */
async function resolveDeskIdentity(socket, ip) {
  if (deskAuthMode() !== 'jwt') {
    const override = socket.handshake.query ? socket.handshake.query.hospital : undefined;
    const resolved = hospitalsConfig.resolveHospital(ip, override);
    return { hospital: resolved.hospital, matchedBy: resolved.matchedBy };
  }

  const token = (socket.handshake.auth && socket.handshake.auth.token) ||
                (socket.handshake.query && socket.handshake.query.token);
  if (!token) return { hospital: null, matchedBy: 'rejected', error: 'A token is required' };

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return { hospital: null, matchedBy: 'rejected', error: 'Invalid or expired token' };
  }

  if (!['HOSPITAL_STAFF', 'ADMIN'].includes(claims.role)) {
    return { hospital: null, matchedBy: 'rejected', error: 'This account is not an ER desk' };
  }

  const hospital = await lookupHospital(claims.hospital_id);
  if (!hospital) return { hospital: null, matchedBy: 'rejected', error: 'Hospital not registered' };

  return { hospital, matchedBy: 'token' };
}

function socketHandler(io) {
  io.on('connection', (socket) => {
    const ip = socketAddress(socket);
    const role = socket.handshake.query ? socket.handshake.query.role : undefined;

    socket.data.ip = ip;

    if (role === 'hospital') {
      resolveDeskIdentity(socket, ip).then(resolved => {
        if (!resolved.hospital) {
          socket.emit('hospital:rejected', { message: resolved.error });
          console.log(`⛔ desk socket from ${ip || 'unknown ip'} refused — ${resolved.error}`);
          socket.disconnect(true);
          return;
        }

        const hospital = resolved.hospital;
        socket.data.hospital = hospital;
        socket.join(`hospital_${hospital.hospital_id}`);
        socket.emit('hospital:identity', {
          hospital,
          matched_by: resolved.matchedBy,
          client_ip: ip
        });
        console.log(`🏥 ${hospital.name} (#${hospital.hospital_id}) desk online from ${ip || 'unknown ip'} [${resolved.matchedBy}]`);

        /* Catch-up: a laptop that joins late still sees everything waiting. */
        return getStore().listForHospital(hospital.hospital_id)
          .then(records => {
            socket.emit('broadcast:snapshot', records.map(r => toDashboardCard(r, hospital.hospital_id)));
          });
      }).catch(err => console.warn('⚠️  desk socket setup failed:', err.message));
    } else {
      console.log(`🚑 client connected from ${ip || 'unknown ip'}`);
    }

    /* Ambulance follows one case. */
    socket.on('case:follow', (caseCode) => {
      if (!caseCode) return;
      socket.join(`case_${caseCode}`);
      getStore().getBroadcast(String(caseCode))
        .then(record => { if (record) socket.emit('case:status', toAmbulanceStatus(record)); })
        .catch(() => {});
    });

    socket.on('case:unfollow', (caseCode) => {
      if (caseCode) socket.leave(`case_${caseCode}`);
    });

    /* ── NEW  patient:update  ────────────────────────────────────────────
       Ambulance → server. Spec §5 / §6 / §23. The authoritative server
       validates + persists, then emits patient:updated to the accepting
       hospital ONLY. The caller may supply a node-style ack callback so the
       ambulance UI can flip "Saving…" into "Patient details updated" or
       "Update failed — please retry" without re-fetching. */
    socket.on('patient:update', (payload, ack) => {
      const safe = payload || {};
      const caseCode = String(safe.case_code || safe.id || '').trim();
      if (!caseCode) return respond(ack, false, 'NO_CASE', 'case_code is required');
      const patch = safe.patient || null;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return respond(ack, false, 'INVALID_PATIENT', 'patient payload must be an object');
      }

      updatePatient(caseCode, patch, io).then(result => {
        if (!result.ok) return respond(ack, false, result.reason, result.message);
        respond(ack, true, null, 'Patient details updated', {
          case_code: caseCode,
          updated_at: result.record.last_patient_updated_at
        });
      }).catch(err => {
        console.warn('⚠️  patient:update failed:', err.message);
        respond(ack, false, 'SERVER_ERROR', 'Could not save the patient update');
      });
    });

    /* ── NEW  ambulance:arrived  ───────────────────────────────────────────
       Ambulance → server on arrivals. Spec §12. Same acknowledgement shape so
       the ambulance UI can verify the move before flipping the screen. */
    socket.on('ambulance:arrived', (payload, ack) => {
      const safe = payload || {};
      const caseCode = String(safe.case_code || safe.id || '').trim();
      if (!caseCode) return respond(ack, false, 'NO_CASE', 'case_code is required');

      markArrived(caseCode, { hospital_id: safe.hospital_id }, io).then(result => {
        if (!result.ok) return respond(ack, false, result.reason, result.message);
        respond(ack, true, null, 'Arrival recorded', {
          case_code: caseCode,
          arrived_at: result.record.arrived_at
        });
      }).catch(err => {
        console.warn('⚠️  ambulance:arrived failed:', err.message);
        respond(ack, false, 'SERVER_ERROR', 'Could not record arrival');
      });
    });

    /* A laptop may re-declare itself (used by the ?hospital= override).
       Ignored under DESK_AUTH=jwt, where the token decides, not the client. */
    socket.on('hospital:identify', (hospitalId) => {
      if (deskAuthMode() === 'jwt') return;
      const resolved = hospitalsConfig.resolveHospital(ip, hospitalId);
      if (socket.data.hospital) socket.leave(`hospital_${socket.data.hospital.hospital_id}`);
      socket.data.hospital = resolved.hospital;
      socket.join(`hospital_${resolved.hospital.hospital_id}`);
      socket.emit('hospital:identity', { hospital: resolved.hospital, matched_by: resolved.matchedBy, client_ip: ip });
    });

    /* ── Legacy events from the original backend, still supported ───────── */
    socket.on('join_case', (caseId) => socket.join(`case_${caseId}`));
    socket.on('join_hospital', (hospitalId) => {
      /* Under DESK_AUTH=jwt this would be a free pass into any hospital's
         room, so it only works in the LAN-trust mode it was written for. */
      if (deskAuthMode() === 'jwt') return;
      socket.join(`hospital_${hospitalId}`);
    });
    socket.on('location_update', (data) => {
      if (!data) return;
      io.to(`hospital_${data.hospital_id}`).emit('ambulance_location', data);
      io.to(`case_${data.case_id}`).emit('eta_updated', data);
    });

    socket.on('disconnect', () => {
      if (socket.data.hospital) {
        console.log(`🏥 ${socket.data.hospital.name} desk offline`);
      }
    });
  });
}

/* Best-effort ack helper. If the caller didn't pass a function — older
   clients, test harness without an ack — we silently no-op so emitting
   .emit() with no callback never throws. */
function respond(ack, ok, reason, message, extra) {
  if (typeof ack !== 'function') return;
  const body = Object.assign({ success: !!ok }, extra || {});
  if (!ok) { body.success = false; body.reason = reason; body.message = message; }
  try { ack(body); } catch (e) { /* ack throwing is not fatal */ }
}

module.exports = socketHandler;
