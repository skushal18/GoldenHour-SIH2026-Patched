/* ============================================================================
   Which hospital is this ER desk?

   DESK_AUTH=jwt (the default): the hospital comes from the signed-in
   account — each hospital's login opens that hospital's desk only. Nothing in
   the request (query string, header, IP) can change it.

   DESK_AUTH=ip (explicit opt-in, closed LAN rehearsals only): the old demo
   identity from ?hospital=<id> or the client IP. Refused in production by
   config/security.js.
   ========================================================================== */
'use strict';
const hospitalsConfig = require('../config/hospitals');
const security = require('../config/security');
const { requireAuth } = require('./auth');
const auth = require('../services/authService');

function deskAuthMode() { return security.deskAuthMode(); }

function clientIp(req) {
  return hospitalsConfig.normaliseIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
}

function ipIdentity(req, res, next) {
  const ip = clientIp(req);
  const override = req.query.hospital !== undefined ? req.query.hospital : req.headers['x-hospital-id'];
  const resolved = hospitalsConfig.resolveHospital(ip, override);
  req.clientIp = ip; req.hospital = resolved.hospital; req.hospitalMatchedBy = resolved.matchedBy;
  next();
}

const staffOnly = requireAuth(['HOSPITAL_STAFF']);

function deskGuard(req, res, next) {
  if (deskAuthMode() !== 'jwt') return ipIdentity(req, res, next);
  staffOnly(req, res, () => {
    const hospital = auth.hospitalFor(req.account);
    if (!hospital) return res.status(403).json({ success: false, reason: 'NO_HOSPITAL', message: 'This login is not linked to a hospital.' });
    req.clientIp = clientIp(req);
    req.hospital = hospital;
    req.hospitalMatchedBy = 'account';
    next();
  });
}

module.exports = { deskGuard, deskAuthMode, clientIp };
