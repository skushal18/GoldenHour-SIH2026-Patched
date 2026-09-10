'use strict';
const hospitalsConfig = require('../config/hospitals');
const { authenticateToken, authorizeRoles } = require('./auth');
const { lookupHospital } = require('../services/hospitalDirectory');

function deskAuthMode(){ return (process.env.DESK_AUTH||'ip').toLowerCase(); }
function clientIp(req){
  const f = req.headers['x-forwarded-for'];
  return hospitalsConfig.normaliseIp(f || req.ip || (req.socket && req.socket.remoteAddress) || '');
}
function hospitalIdentity(req, res, next){
  const ip = clientIp(req);
  const override = req.query.hospital !== undefined ? req.query.hospital : req.headers['x-hospital-id'];
  const resolved = hospitalsConfig.resolveHospital(ip, override);
  req.clientIp = ip; req.hospital = resolved.hospital; req.hospitalMatchedBy = resolved.matchedBy;
  next();
}
async function hospitalFromToken(req, res, next){
  req.clientIp = clientIp(req);
  const hospitalId = req.user && req.user.hospital_id;
  if (!hospitalId) return res.status(403).json({ success:false, message:'Account not attached to a hospital' });
  const hospital = await lookupHospital(hospitalId);
  if (!hospital) return res.status(404).json({ success:false });
  req.hospital = hospital; req.hospitalMatchedBy = 'token'; next();
}
function deskGuard(req, res, next){
  if (deskAuthMode() !== 'jwt') return hospitalIdentity(req, res, next);
  authenticateToken(req, res, () => {
    authorizeRoles('HOSPITAL_STAFF','ADMIN')(req, res, () => {
      hospitalFromToken(req, res, next).catch(next);
    });
  });
}
module.exports = { hospitalIdentity, hospitalFromToken, deskGuard, deskAuthMode, clientIp };
