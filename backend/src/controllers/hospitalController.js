const pool = require('../config/db');

// GET /api/v1/hospitals/:id/incoming
const getIncomingCases = async (req, res) => {
  const { id } = req.params;

  try {
    const [cases] = await pool.query(
      `SELECT c.*, a.registration_number,
              cf.shock, cf.hypoxia, cf.low_gcs, cf.cardiac_arrest, cf.airway_compromise,
              cd.gcs, cd.spo2
       FROM cases c
       JOIN ambulances a ON c.ambulance_id = a.ambulance_id
       LEFT JOIN critical_flags cf ON c.case_id = cf.case_id
       LEFT JOIN case_clinical_data cd ON c.case_id = cd.case_id
       WHERE c.destination_hospital_id = ?
         AND c.status NOT IN ('CLOSED', 'CANCELLED', 'DIVERTED')
       ORDER BY FIELD(c.priority, 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'), c.eta_minutes ASC`,
      [id]
    );

    res.json({ success: true, data: cases });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PUT /api/v1/hospitals/:id/capacity
const updateCapacity = async (req, res) => {
  const { id } = req.params;
  const {
    resus_bays_available, ct_available, ot_available,
    blood_available, ventilators_available, diversion_active
  } = req.body;

  try {
    // Upsert capacity
    const [existing] = await pool.query(
      'SELECT capacity_id FROM hospital_capacity WHERE hospital_id = ?', [id]
    );

    if (existing.length > 0) {
      await pool.query(
        `UPDATE hospital_capacity SET
         resus_bays_available = ?, ct_available = ?, ot_available = ?,
         blood_available = ?, ventilators_available = ?, diversion_active = ?
         WHERE hospital_id = ?`,
        [resus_bays_available, ct_available, ot_available,
         blood_available, ventilators_available, diversion_active, id]
      );
    } else {
      await pool.query(
        `INSERT INTO hospital_capacity 
         (hospital_id, resus_bays_available, ct_available, ot_available, blood_available, ventilators_available, diversion_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, resus_bays_available, ct_available, ot_available,
         blood_available, ventilators_available, diversion_active]
      );
    }

    res.json({ success: true, message: 'Capacity updated', data: { hospital_id: id } });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { getIncomingCases, updateCapacity };