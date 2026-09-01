/* ============================================================================
   Who is hospital #N?

   During the hackathon the answer comes from config/hospitals.config.js — two
   laptops, hardcoded. In production it comes from the `hospitals` table. This
   module hides which, so nothing downstream has to care.
   ========================================================================== */

'use strict';

const hospitalsConfig = require('../config/hospitals');

/** Config first (it is authoritative for the demo), then the database. */
async function lookupHospital(hospitalId) {
  const id = Number(hospitalId);
  if (!Number.isInteger(id)) return null;

  const configured = hospitalsConfig.byId(id);
  if (configured) return configured;

  try {
    const pool = require('../config/db');
    const [rows] = await pool.query(
      'SELECT hospital_id, name, address, latitude, longitude, contact FROM hospitals WHERE hospital_id = ?',
      [id]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      hospital_id: r.hospital_id,
      code: `HOSP-${r.hospital_id}`,
      ip: null,                       // a real hospital is not identified by IP
      name: r.name,
      address: r.address || null,
      lat: r.latitude === null ? null : Number(r.latitude),
      lng: r.longitude === null ? null : Number(r.longitude),
      contact: r.contact || null,
      accent: '#25CED1'
    };
  } catch (err) {
    console.warn('⚠️  hospital lookup failed:', err.message);
    return null;
  }
}

module.exports = { lookupHospital };
