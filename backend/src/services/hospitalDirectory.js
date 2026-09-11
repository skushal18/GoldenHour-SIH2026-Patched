'use strict';
const config = require('../config/hospitals');
async function lookupHospital(hospitalId){
  const id = Number(hospitalId); if (!Number.isInteger(id)) return null;
  const configured = config.byId(id); if (configured) return configured;
  try{
    const pool = require('../config/db');
    const [rows] = await pool.query('SELECT hospital_id, name, address, latitude, longitude, contact FROM hospitals WHERE hospital_id=?', [id]);
    if (!rows.length) return null;
    const r = rows[0];
    return { hospital_id: r.hospital_id, code:`HOSP-${r.hospital_id}`, ip:null, name:r.name,
      address:r.address||null, lat: r.latitude==null?null:Number(r.latitude),
      lng: r.longitude==null?null:Number(r.longitude), contact:r.contact||null, accent:'#25CED1' };
  }catch(e){ return null; }
}
module.exports = { lookupHospital };
