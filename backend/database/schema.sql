-- GoldenHour v6 schema (MySQL 8).
--
-- You do not need to run this: the server creates every table it needs at
-- startup (src/store/migrate.js) and never drops anything. This file is the
-- same definitions, generated with `npm --prefix backend run schema`, for
-- reading or for applying by hand. Safe to run more than once.

CREATE TABLE IF NOT EXISTS accounts (
  account_id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('SUPER_ADMIN','HOSPITAL_STAFF') NOT NULL,
  hospital_id INT NULL,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  token_version INT NOT NULL DEFAULT 0,
  last_login_at DATETIME NULL,
  created_by VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_account_username (username),
  INDEX idx_account_hospital (hospital_id)
  );

CREATE TABLE IF NOT EXISTS broadcasts (
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
  );

CREATE TABLE IF NOT EXISTS broadcast_targets (
  target_id INT AUTO_INCREMENT PRIMARY KEY,
  case_code VARCHAR(20) NOT NULL, hospital_id INT NOT NULL, hospital_name VARCHAR(200) NOT NULL,
  hospital_contact VARCHAR(40), hospital_lat DECIMAL(10,7), hospital_lng DECIMAL(10,7),
  distance_km DECIMAL(6,1),
  status ENUM('PENDING','ACCEPTED','CANCELLED','DECLINED','EXPIRED','CLOSED') DEFAULT 'PENDING',
  UNIQUE KEY uniq_case_hospital (case_code, hospital_id),
  INDEX idx_target_hospital (hospital_id)
  );

CREATE TABLE IF NOT EXISTS hospital_capacity (
  hospital_id INT PRIMARY KEY,
  resus_bays_available INT NOT NULL DEFAULT 0,
  ventilators_available INT NOT NULL DEFAULT 0,
  ct_available TINYINT(1) NOT NULL DEFAULT 1,
  ot_available TINYINT(1) NOT NULL DEFAULT 1,
  blood_available TINYINT(1) NOT NULL DEFAULT 1,
  cathlab_available TINYINT(1) NOT NULL DEFAULT 1,
  diversion_active TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL
  );

CREATE TABLE IF NOT EXISTS case_events (
  event_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  case_code VARCHAR(20) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  event_data JSON NULL,
  actor VARCHAR(64) NOT NULL,
  performed_at DATETIME(3) NOT NULL,
  INDEX idx_event_case (case_code, performed_at),
  INDEX idx_event_time (performed_at)
  );
