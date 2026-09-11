const pool = require('../config/db');

// Helper: generate case code like GH-2026-0001
const generateCaseCode = async () => {
  const year = new Date().getFullYear();
  const [rows] = await pool.query(
    'SELECT COUNT(*) as count FROM cases WHERE YEAR(created_at) = ?', [year]
  );
  const count = rows[0].count + 1;
  return `GH-${year}-${String(count).padStart(4, '0')}`;
};

// Helper: log activity event
const logEvent = async (case_id, event_type, event_data, performed_by) => {
  await pool.query(
    'INSERT INTO activity_events (case_id, event_type, event_data, performed_by) VALUES (?, ?, ?, ?)',
    [case_id, event_type, JSON.stringify(event_data), performed_by || null]
  );
};

// POST /api/v1/cases — Create case
const createCase = async (req, res) => {
  const {
    ambulance_id, destination_hospital_id, priority,
    age_band, sex, chief_complaint, eta_minutes,
    latitude, longitude
  } = req.body;

  try {
    const case_code = await generateCaseCode();

    const [result] = await pool.query(
      `INSERT INTO cases 
       (case_code, ambulance_id, destination_hospital_id, priority, age_band, sex, 
        chief_complaint, eta_minutes, latitude, longitude, created_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')`,
      [case_code, ambulance_id, destination_hospital_id, priority,
       age_band, sex, chief_complaint, eta_minutes, latitude, longitude,
       req.user.user_id]
    );

    const case_id = result.insertId;
    await logEvent(case_id, 'CASE_CREATED', { case_code, priority }, req.user.user_id);

    res.status(201).json({
      success: true,
      message: 'Emergency pre-alert created successfully',
      data: { case_id, case_code, status: 'DRAFT', priority, eta_minutes }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/cases/:id — Get full case details
const getCase = async (req, res) => {
  const { id } = req.params;

  try {
    const [cases] = await pool.query(
      `SELECT c.*, h.name as hospital_name, a.registration_number
       FROM cases c
       JOIN hospitals h ON c.destination_hospital_id = h.hospital_id
       JOIN ambulances a ON c.ambulance_id = a.ambulance_id
       WHERE c.case_id = ?`, [id]
    );

    if (cases.length === 0) {
      return res.status(404).json({ success: false, message: 'Case not found' });
    }

    const [clinical] = await pool.query('SELECT * FROM case_clinical_data WHERE case_id = ?', [id]);
    const [flags] = await pool.query('SELECT * FROM critical_flags WHERE case_id = ?', [id]);
    const [events] = await pool.query(
      'SELECT * FROM activity_events WHERE case_id = ? ORDER BY performed_at ASC', [id]
    );

    res.json({
      success: true,
      data: {
        ...cases[0],
        clinical_data: clinical[0] || null,
        critical_flags: flags[0] || null,
        timeline: events
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/cases/:id/send — Send pre-alert
const sendCase = async (req, res) => {
  const { id } = req.params;
  const { clinical_data, critical_flags } = req.body;

  try {
    const [cases] = await pool.query('SELECT * FROM cases WHERE case_id = ?', [id]);
    if (cases.length === 0) return res.status(404).json({ success: false, message: 'Case not found' });

    // Save clinical data if provided
    if (clinical_data) {
      const { age, time_of_incident, mechanism, injuries, signs_symptoms,
              treatment_given, gcs, spo2, bp, pulse } = clinical_data;
      await pool.query(
        `INSERT INTO case_clinical_data 
         (case_id, age, time_of_incident, mechanism, injuries, signs_symptoms, treatment_given, gcs, spo2, bp, pulse)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, age, time_of_incident, mechanism, injuries, signs_symptoms, treatment_given, gcs, spo2, bp, pulse]
      );
    }

    // Save critical flags if provided
    if (critical_flags) {
      const { shock, hypoxia, low_gcs, cardiac_arrest, airway_compromise } = critical_flags;
      await pool.query(
        `INSERT INTO critical_flags (case_id, shock, hypoxia, low_gcs, cardiac_arrest, airway_compromise)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, shock || false, hypoxia || false, low_gcs || false, cardiac_arrest || false, airway_compromise || false]
      );
    }

    // Update status
    await pool.query('UPDATE cases SET status = ? WHERE case_id = ?', ['SENT', id]);
    await logEvent(id, 'ALERT_SENT', {}, req.user.user_id);

    // Simulate delivery (in real app, trigger socket to hospital)
    await pool.query('UPDATE cases SET status = ? WHERE case_id = ?', ['DELIVERED', id]);
    await logEvent(id, 'ALERT_DELIVERED', {}, req.user.user_id);

    res.json({
      success: true,
      message: 'Pre-alert sent and delivered',
      data: { case_id: id, status: 'DELIVERED' }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/cases/:id/acknowledge
const acknowledgeCase = async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;

  try {
    const [cases] = await pool.query(
      'SELECT c.*, h.name as hospital_name FROM cases c JOIN hospitals h ON c.destination_hospital_id = h.hospital_id WHERE c.case_id = ?',
      [id]
    );
    if (cases.length === 0) return res.status(404).json({ success: false, message: 'Case not found' });

    await pool.query(
      'INSERT INTO acknowledgements (case_id, acknowledged_by, notes) VALUES (?, ?, ?)',
      [id, req.user.user_id, notes || null]
    );

    await pool.query('UPDATE cases SET status = ? WHERE case_id = ?', ['ACKNOWLEDGED', id]);
    await logEvent(id, 'ALERT_ACKNOWLEDGED', { acknowledged_by: req.user.user_id }, req.user.user_id);

    res.json({
      success: true,
      message: 'Emergency alert acknowledged',
      data: {
        case_code: cases[0].case_code,
        status: 'ACKNOWLEDGED',
        acknowledged_by: req.user.name || 'Emergency Desk',
        facility: cases[0].hospital_name
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/cases/:id/location — Update ETA/location
const updateLocation = async (req, res) => {
  const { id } = req.params;
  const { latitude, longitude, eta_minutes } = req.body;

  try {
    await pool.query(
      'INSERT INTO location_updates (case_id, latitude, longitude, eta_minutes) VALUES (?, ?, ?, ?)',
      [id, latitude, longitude, eta_minutes]
    );

    await pool.query(
      'UPDATE cases SET latitude = ?, longitude = ?, eta_minutes = ? WHERE case_id = ?',
      [latitude, longitude, eta_minutes, id]
    );

    await logEvent(id, 'ETA_UPDATED', { eta_minutes, latitude, longitude }, req.user.user_id);

    res.json({
      success: true,
      message: 'Location and ETA updated',
      data: { case_id: id, eta_minutes, latitude, longitude }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/cases/:id/team-readiness
const updateTeamReadiness = async (req, res) => {
  const { id } = req.params;
  const { trauma_team_activated, roles_assigned, readiness_notes } = req.body;

  try {
    await pool.query(
      `INSERT INTO team_readiness (case_id, trauma_team_activated, roles_assigned, readiness_notes, recorded_by)
       VALUES (?, ?, ?, ?, ?)`,
      [id, trauma_team_activated || false, roles_assigned || null, readiness_notes || null, req.user.user_id]
    );

    await logEvent(id, 'TRAUMA_TEAM_ACTIVATED', { trauma_team_activated }, req.user.user_id);

    res.json({
      success: true,
      message: 'Team readiness recorded',
      data: { case_id: id, trauma_team_activated }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/cases/:id/divert
const divertCase = async (req, res) => {
  const { id } = req.params;
  const { reason, new_hospital_id } = req.body;

  try {
    await pool.query('UPDATE cases SET status = ? WHERE case_id = ?', ['DIVERTED', id]);
    if (new_hospital_id) {
      await pool.query('UPDATE cases SET destination_hospital_id = ? WHERE case_id = ?', [new_hospital_id, id]);
    }
    await logEvent(id, 'CASE_DIVERTED', { reason, new_hospital_id }, req.user.user_id);

    res.json({
      success: true,
      message: 'Case diverted',
      data: { case_id: id, status: 'DIVERTED', reason }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/cases/:id/arrive
const arriveCase = async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('UPDATE cases SET status = ? WHERE case_id = ?', ['ARRIVED', id]);
    await logEvent(id, 'AMBULANCE_ARRIVED', {}, req.user.user_id);

    res.json({
      success: true,
      message: 'Arrival recorded',
      data: { case_id: id, status: 'ARRIVED' }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/cases/:id/close
const closeCase = async (req, res) => {
  const { id } = req.params;
  const { closure_notes } = req.body;

  try {
    await pool.query('UPDATE cases SET status = ? WHERE case_id = ?', ['CLOSED', id]);
    await logEvent(id, 'CASE_CLOSED', { closure_notes }, req.user.user_id);

    res.json({
      success: true,
      message: 'Case closed',
      data: { case_id: id, status: 'CLOSED' }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/v1/cases/:id/events — Timeline
const getCaseEvents = async (req, res) => {
  const { id } = req.params;

  try {
    const [events] = await pool.query(
      'SELECT * FROM activity_events WHERE case_id = ? ORDER BY performed_at ASC', [id]
    );

    res.json({ success: true, data: events });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/cases/:id/resources
const requestResources = async (req, res) => {
  const { id } = req.params;
  const { blood_required, imaging_required, trauma_team_required, ventilator_required, notes } = req.body;

  try {
    await pool.query(
      `INSERT INTO resource_requests 
       (case_id, blood_required, imaging_required, trauma_team_required, ventilator_required, notes, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, blood_required || false, imaging_required || false,
       trauma_team_required || false, ventilator_required || false,
       notes || null, req.user.user_id]
    );

    await logEvent(id, 'RESOURCES_REQUESTED', { blood_required, imaging_required }, req.user.user_id);

    res.json({ success: true, message: 'Resources requested', data: { case_id: id } });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  createCase, getCase, sendCase, acknowledgeCase,
  updateLocation, updateTeamReadiness, divertCase,
  arriveCase, closeCase, getCaseEvents, requestResources
};