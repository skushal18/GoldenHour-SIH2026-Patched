-- GoldenHour v5 schema. Adds v5 columns to the location_updates / capacity / activity_events
-- tables that were already declared but unused.

CREATE DATABASE IF NOT EXISTS goldenhour;
USE goldenhour;

DROP TABLE IF EXISTS broadcast_targets;
DROP TABLE IF EXISTS broadcasts;
DROP TABLE IF EXISTS activity_events;
DROP TABLE IF EXISTS resource_requests;
DROP TABLE IF EXISTS hospital_capacity;
DROP TABLE IF EXISTS team_readiness;
DROP TABLE IF EXISTS acknowledgements;
DROP TABLE IF EXISTS location_updates;
DROP TABLE IF EXISTS critical_flags;
DROP TABLE IF EXISTS case_clinical_data;
DROP TABLE IF EXISTS cases;
DROP TABLE IF EXISTS ambulances;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS hospitals;
DROP TABLE IF EXISTS notifications;

CREATE TABLE hospitals (
  hospital_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  address TEXT,
  latitude DECIMAL(10,8) NULL,
  longitude DECIMAL(11,8) NULL,
  contact VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('AMBULANCE_CREW','HOSPITAL_STAFF','ADMIN') NOT NULL,
  hospital_id INT NULL, ambulance_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ambulances (
  ambulance_id INT AUTO_INCREMENT PRIMARY KEY,
  registration_number VARCHAR(50) UNIQUE NOT NULL,
  hospital_id INT, status ENUM('AVAILABLE','ON_CALL','OFFLINE') DEFAULT 'AVAILABLE'
);

CREATE TABLE cases (
  case_id INT AUTO_INCREMENT PRIMARY KEY,
  case_code VARCHAR(20) UNIQUE NOT NULL,
  ambulance_id INT NOT NULL, destination_hospital_id INT NOT NULL,
  priority ENUM('CRITICAL','HIGH','MEDIUM','LOW') NOT NULL,
  status ENUM('DRAFT','SENT','DELIVERED','ACKNOWLEDGED','ARRIVED','CLOSED','QUEUED','DIVERTED','ACK_FAILURE','CANCELLED') DEFAULT 'DRAFT',
  age_band VARCHAR(20), sex ENUM('M','F','OTHER'), chief_complaint TEXT, eta_minutes INT,
  latitude DECIMAL(10,8), longitude DECIMAL(11,8),
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE case_clinical_data (
  clinical_id INT AUTO_INCREMENT PRIMARY KEY, case_id INT NOT NULL,
  age VARCHAR(20), time_of_incident VARCHAR(50), mechanism VARCHAR(255),
  injuries TEXT, signs_symptoms TEXT, treatment_given TEXT,
  gcs INT, spo2 INT, bp VARCHAR(20), pulse INT
);

CREATE TABLE critical_flags (
  flag_id INT AUTO_INCREMENT PRIMARY KEY, case_id INT NOT NULL,
  shock BOOLEAN, hypoxia BOOLEAN, low_gcs BOOLEAN,
  cardiac_arrest BOOLEAN, airway_compromise BOOLEAN
);

CREATE TABLE location_updates (
  location_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NULL, case_code VARCHAR(20) NULL,
  latitude DECIMAL(10,8), longitude DECIMAL(11,8),
  eta_minutes INT, accuracy_m INT NULL,
  speed_kmh DECIMAL(5,1) NULL,
  source ENUM('gps','manual','last-known') DEFAULT 'gps',
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_loc_case_code (case_code, recorded_at)
);

CREATE TABLE acknowledgements ( ack_id INT AUTO_INCREMENT PRIMARY KEY, case_id INT NOT NULL, acknowledged_by INT NOT NULL, acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, notes TEXT );
CREATE TABLE team_readiness ( readiness_id INT AUTO_INCREMENT PRIMARY KEY, case_id INT NOT NULL, trauma_team_activated BOOLEAN, roles_assigned TEXT, readiness_notes TEXT, recorded_by INT, recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP );

CREATE TABLE hospital_capacity (
  capacity_id INT AUTO_INCREMENT PRIMARY KEY,
  hospital_id INT NOT NULL,
  resus_bays_available INT DEFAULT 0,
  ct_available BOOLEAN DEFAULT TRUE,
  ot_available BOOLEAN DEFAULT TRUE,
  blood_available BOOLEAN DEFAULT TRUE,
  ventilators_available INT DEFAULT 0,
  cathlab_available BOOLEAN DEFAULT TRUE,
  diversion_active BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE resource_requests (
  request_id INT AUTO_INCREMENT PRIMARY KEY, case_id INT NOT NULL,
  blood_required BOOLEAN, imaging_required BOOLEAN, trauma_team_required BOOLEAN,
  ventilator_required BOOLEAN, notes TEXT, requested_by INT, requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE activity_events (
  event_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NULL, case_code VARCHAR(20) NULL,
  event_type VARCHAR(100) NOT NULL, event_data JSON,
  performed_by INT NULL, performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_evt_case_code (case_code, performed_at)
);

CREATE TABLE notifications (
  notification_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT, recipient_user_id INT, message TEXT,
  channel ENUM('IN_APP','SMS','EMAIL') DEFAULT 'IN_APP',
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE broadcasts (
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

CREATE TABLE broadcast_targets (
  target_id INT AUTO_INCREMENT PRIMARY KEY,
  case_code VARCHAR(20) NOT NULL, hospital_id INT NOT NULL, hospital_name VARCHAR(150) NOT NULL,
  hospital_contact VARCHAR(30), hospital_lat DECIMAL(10,8), hospital_lng DECIMAL(11,8),
  distance_km DECIMAL(6,1), status ENUM('PENDING','ACCEPTED','CANCELLED','DECLINED','EXPIRED','CLOSED') DEFAULT 'PENDING',
  UNIQUE KEY uniq_case_hospital (case_code, hospital_id)
);

-- seed
INSERT INTO hospitals (name, address, latitude, longitude, contact) VALUES
('City Emergency Hospital','MG Road, Bangalore', 12.9716, 77.5946, '080-12345678'),
('Apollo Hospital','Bannerghatta Road, Bangalore', 12.9121, 77.5956, '080-87654321'),
('Manipal Hospital','Old Airport Road, Bangalore', 12.9591, 77.6488, '+918025023700'),
('Victoria Hospital','Bowring Road, Bangalore', 12.9634, 77.5855, '080-22206439');

INSERT INTO ambulances (registration_number, hospital_id, status) VALUES
('KA01AB1234', 1, 'AVAILABLE'),('KA02CD5678', 1, 'AVAILABLE');

-- (demo seed passwords only — production seeds removed at Phase 11)
