/* ============================================================================
   Schema, applied by the server itself at boot.

   Previously the schema lived only in database/schema.sql, which began by
   dropping every table — run it twice and production was empty — and had to
   be loaded by hand into the managed database. Now the server creates what is
   missing and adds missing columns, and never drops or rewrites anything.
   Safe to run on every start, on an empty database or a v5 one.

   database/schema.sql is generated from the same definitions for anyone who
   wants to read or apply the schema by hand.
   ========================================================================== */
'use strict';

const TABLES = {
  accounts: `CREATE TABLE IF NOT EXISTS accounts (
    account_id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NULL,
    password_hash VARCHAR(100) NULL,
    role ENUM('SUPER_ADMIN','HOSPITAL_STAFF') NOT NULL,
    hospital_id INT NULL,
    status ENUM('PENDING','ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
    must_change_password TINYINT(1) NOT NULL DEFAULT 1,
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until DATETIME NULL,
    token_version INT NOT NULL DEFAULT 0,
    last_login_at DATETIME NULL,
    activation_code_hash CHAR(64) NULL,
    activation_expires_at DATETIME NULL,
    activated_at DATETIME NULL,
    created_by VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_account_username (username),
    UNIQUE KEY uniq_account_activation (activation_code_hash),
    INDEX idx_account_hospital (hospital_id)
  )`,
  /* The GoldenHour network: the hospitals ambulances are matched to. id is the
     directory id from data/hospitals/india_hospitals.csv. */
  hospitals: `CREATE TABLE IF NOT EXISTS hospitals (
    id INT PRIMARY KEY,
    source_id VARCHAR(40) NULL,
    name VARCHAR(255) NOT NULL,
    state VARCHAR(80) NOT NULL DEFAULT '',
    district VARCHAR(120) NOT NULL DEFAULT '',
    pincode VARCHAR(10) NULL,
    address VARCHAR(500) NULL,
    phone VARCHAR(120) NULL,
    ownership VARCHAR(60) NULL,
    care_type VARCHAR(80) NULL,
    specialties VARCHAR(255) NULL,
    beds INT NULL,
    emergency_likely TINYINT(1) NOT NULL DEFAULT 1,
    lat DECIMAL(10,7) NULL,
    lng DECIMAL(10,7) NULL,
    coord_source VARCHAR(10) NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_hospital_state (state),
    INDEX idx_hospital_active (active)
  )`,
  broadcasts: `CREATE TABLE IF NOT EXISTS broadcasts (
    case_code VARCHAR(20) PRIMARY KEY,
    status ENUM('PENDING','ACCEPTED','ARRIVED','REJECTED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    priority ENUM('RED','AMBER','GREEN') NOT NULL DEFAULT 'AMBER',
    payload JSON NOT NULL,
    accepted_hospital_id INT NULL, accepted_at TIMESTAMP NULL,
    arrived_at TIMESTAMP NULL, expires_at TIMESTAMP NULL,
    legacy_case_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_broadcast_status (status),
    INDEX idx_broadcast_created (created_at)
  )`,
  broadcast_targets: `CREATE TABLE IF NOT EXISTS broadcast_targets (
    target_id INT AUTO_INCREMENT PRIMARY KEY,
    case_code VARCHAR(20) NOT NULL, hospital_id INT NOT NULL, hospital_name VARCHAR(200) NOT NULL,
    hospital_contact VARCHAR(40), hospital_lat DECIMAL(10,7), hospital_lng DECIMAL(10,7),
    distance_km DECIMAL(6,1),
    status ENUM('PENDING','ACCEPTED','CANCELLED','DECLINED','EXPIRED','CLOSED') DEFAULT 'PENDING',
    UNIQUE KEY uniq_case_hospital (case_code, hospital_id),
    INDEX idx_target_hospital (hospital_id)
  )`,
  hospital_capacity: `CREATE TABLE IF NOT EXISTS hospital_capacity (
    hospital_id INT PRIMARY KEY,
    resus_bays_available INT NOT NULL DEFAULT 0,
    ventilators_available INT NOT NULL DEFAULT 0,
    ct_available TINYINT(1) NOT NULL DEFAULT 1,
    ot_available TINYINT(1) NOT NULL DEFAULT 1,
    blood_available TINYINT(1) NOT NULL DEFAULT 1,
    cathlab_available TINYINT(1) NOT NULL DEFAULT 1,
    diversion_active TINYINT(1) NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL
  )`,
  case_events: `CREATE TABLE IF NOT EXISTS case_events (
    event_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    case_code VARCHAR(20) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    event_data JSON NULL,
    actor VARCHAR(64) NOT NULL,
    performed_at DATETIME(3) NOT NULL,
    INDEX idx_event_case (case_code, performed_at),
    INDEX idx_event_time (performed_at)
  )`,
};

/* Columns added after a table first shipped. [table, column, definition] */
const ADDED_COLUMNS = [
  ['broadcast_targets', 'hospital_contact', 'VARCHAR(40) NULL'],
  ['accounts', 'activation_code_hash', 'CHAR(64) NULL'],
  ['accounts', 'activation_expires_at', 'DATETIME NULL'],
  ['accounts', 'activated_at', 'DATETIME NULL'],
];

/* Columns whose definition changed after they first shipped, widened in place
   (never narrowed, never dropped). [table, column, definition, isCurrent(col)]
   v7: a hospital login can wait for activation — no username or password yet. */
const CHANGED_COLUMNS = [
  ['accounts', 'username', 'VARCHAR(64) NULL', c => c.IS_NULLABLE === 'YES'],
  ['accounts', 'password_hash', 'VARCHAR(100) NULL', c => c.IS_NULLABLE === 'YES'],
  ['accounts', 'status', "ENUM('PENDING','ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE'", c => /'PENDING'/.test(c.COLUMN_TYPE)],
];

/* Indexes added after a table first shipped. [table, index, definition] */
const ADDED_INDEXES = [
  ['accounts', 'uniq_account_activation', 'UNIQUE KEY uniq_account_activation (activation_code_hash)'],
];

async function ensureSchema(pool, log) {
  const logger = log || console;
  for (const sql of Object.values(TABLES)) await pool.query(sql);
  for (const [table, column, def] of ADDED_COLUMNS) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column]);
    if (!Number(rows[0].n)) {
      await pool.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + def);
      logger.log('🗃️  added column ' + table + '.' + column);
    }
  }
  for (const [table, column, def, isCurrent] of CHANGED_COLUMNS) {
    const [rows] = await pool.query(
      'SELECT IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column]);
    if (rows.length && !isCurrent(rows[0])) {
      await pool.query('ALTER TABLE `' + table + '` MODIFY COLUMN `' + column + '` ' + def);
      logger.log('🗃️  changed column ' + table + '.' + column);
    }
  }
  for (const [table, name, def] of ADDED_INDEXES) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
      [table, name]);
    if (!Number(rows[0].n)) {
      await pool.query('ALTER TABLE `' + table + '` ADD ' + def);
      logger.log('🗃️  added index ' + table + '.' + name);
    }
  }
}

function schemaSql() {
  return Object.values(TABLES).map(s => s.replace(/\n {4}/g, '\n  ') + ';').join('\n\n') + '\n';
}

module.exports = { ensureSchema, schemaSql, TABLES };
