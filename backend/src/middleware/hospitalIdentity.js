/* ============================================================================
   Which hospital is this request coming from?

   Two modes, chosen by DESK_AUTH in .env:

     DESK_AUTH=ip    (default)  the laptop's IP address, matched against the
                                hardcoded map in config/hospitals.config.js.
                                No login. Right for a hackathon on a closed
                                LAN, wrong for anything reachable from the
                                internet — the LAN is the only thing standing
                                between a stranger and your patients.

     DESK_AUTH=jwt   production  a signed token. Identity comes from the
                                token's hospital_id, so an IP address is not
                                a credential any more. See DEPLOYMENT.md.
   ========================================================================== */

'use strict';

const hospitalsConfig = require('../config/hospitals');
const { authenticateToken, authorizeRoles } = require('./auth');
const { lookupHospital } = require('../services/hospitalDirectory');

function deskAuthMode() {
  return (process.env.DESK_AUTH || 'ip').toLowerCase();
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return hospitalsConfig.normaliseIp(forwarded || req.ip || (req.socket && req.socket.remoteAddress) || '');
}

/* ── Mode 1 ▸ identity by IP ─────────────────────────────────────────────── */
function hospitalIdentity(req, res, next) {
  const ip = clientIp(req);
  const override = req.query.hospital !== undefined ? req.query.hospital : req.headers['x-hospital-id'];
  const resolved = hospitalsConfig.resolveHospital(ip, override);

  req.clientIp = ip;
  req.hospital = resolved.hospital;
  req.hospitalMatchedBy = resolved.matchedBy;
  next();
}

/* ── Mode 2 ▸ identity from the token ────────────────────────────────────── */
async function hospitalFromToken(req, res, next) {
  req.clientIp = clientIp(req);

  const hospitalId = req.user && req.user.hospital_id;
  if (!hospitalId) {
    return res.status(403).json({
      success: false,
      message: 'This account is not attached to a hospital'
    });
  }

  const hospital = await lookupHospital(hospitalId);
  if (!hospital) {
    return res.status(404).json({
      success: false,
      message: `Hospital ${hospitalId} is not registered`
    });
  }

  req.hospital = hospital;
  req.hospitalMatchedBy = 'token';
  next();
}

/**
 * The middleware chain the desk routes should mount, for whichever mode is
 * configured. Evaluated per request so a test can flip DESK_AUTH without
 * rebuilding the router.
 */
function deskGuard(req, res, next) {
  if (deskAuthMode() !== 'jwt') return hospitalIdentity(req, res, next);

  authenticateToken(req, res, function () {
    authorizeRoles('HOSPITAL_STAFF', 'ADMIN')(req, res, function () {
      hospitalFromToken(req, res, next).catch(next);
    });
  });
}

module.exports = { hospitalIdentity, hospitalFromToken, deskGuard, deskAuthMode, clientIp };
