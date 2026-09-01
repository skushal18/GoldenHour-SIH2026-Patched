DROP DATABASE IF EXISTS goldenhour;
CREATE DATABASE goldenhour;
USE goldenhour;

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
  role ENUM('AMBULANCE_CREW', 'HOSPITAL_STAFF', 'ADMIN') NOT NULL,
  hospital_id INT NULL,
  ambulance_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ambulances (
  ambulance_id INT AUTO_INCREMENT PRIMARY KEY,
  registration_number VARCHAR(50) UNIQUE NOT NULL,
  hospital_id INT,
  status ENUM('AVAILABLE', 'ON_CALL', 'OFFLINE') DEFAULT 'AVAILABLE',
  FOREIGN KEY (hospital_id) REFERENCES hospitals(hospital_id)
);

CREATE TABLE cases (
  case_id INT AUTO_INCREMENT PRIMARY KEY,
  case_code VARCHAR(20) UNIQUE NOT NULL,
  ambulance_id INT NOT NULL,
  destination_hospital_id INT NOT NULL,
  priority ENUM('CRITICAL', 'HIGH', 'MEDIUM', 'LOW') NOT NULL,
  status ENUM('DRAFT','SENT','DELIVERED','ACKNOWLEDGED','ARRIVED','CLOSED','QUEUED','DIVERTED','ACK_FAILURE','CANCELLED') DEFAULT 'DRAFT',
  age_band VARCHAR(20),
  sex ENUM('M','F','OTHER'),
  chief_complaint TEXT,
  eta_minutes INT,
  latitude DECIMAL(10,8),
  longitude DECIMAL(11,8),
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (ambulance_id) REFERENCES ambulances(ambulance_id),
  FOREIGN KEY (destination_hospital_id) REFERENCES hospitals(hospital_id),
  FOREIGN KEY (created_by) REFERENCES users(user_id)
);

CREATE TABLE case_clinical_data (
  clinical_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  age VARCHAR(20),
  time_of_incident VARCHAR(50),
  mechanism VARCHAR(255),
  injuries TEXT,
  signs_symptoms TEXT,
  treatment_given TEXT,
  gcs INT,
  spo2 INT,
  bp VARCHAR(20),
  pulse INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES cases(case_id)
);

CREATE TABLE critical_flags (
  flag_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  shock BOOLEAN DEFAULT FALSE,
  hypoxia BOOLEAN DEFAULT FALSE,
  low_gcs BOOLEAN DEFAULT FALSE,
  cardiac_arrest BOOLEAN DEFAULT FALSE,
  airway_compromise BOOLEAN DEFAULT FALSE,
  FOREIGN KEY (case_id) REFERENCES cases(case_id)
);

CREATE TABLE location_updates (
  location_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  latitude DECIMAL(10,8),
  longitude DECIMAL(11,8),
  eta_minutes INT,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES cases(case_id)
);

CREATE TABLE acknowledgements (
  ack_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  acknowledged_by INT NOT NULL,
  acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  FOREIGN KEY (case_id) REFERENCES cases(case_id),
  FOREIGN KEY (acknowledged_by) REFERENCES users(user_id)
);

CREATE TABLE team_readiness (
  readiness_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  trauma_team_activated BOOLEAN DEFAULT FALSE,
  roles_assigned TEXT,
  readiness_notes TEXT,
  recorded_by INT,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES cases(case_id),
  FOREIGN KEY (recorded_by) REFERENCES users(user_id)
);

CREATE TABLE hospital_capacity (
  capacity_id INT AUTO_INCREMENT PRIMARY KEY,
  hospital_id INT NOT NULL,
  resus_bays_available INT DEFAULT 0,
  ct_available BOOLEAN DEFAULT TRUE,
  ot_available BOOLEAN DEFAULT TRUE,
  blood_available BOOLEAN DEFAULT TRUE,
  ventilators_available INT DEFAULT 0,
  diversion_active BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (hospital_id) REFERENCES hospitals(hospital_id)
);

CREATE TABLE resource_requests (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  blood_required BOOLEAN DEFAULT FALSE,
  imaging_required BOOLEAN DEFAULT FALSE,
  trauma_team_required BOOLEAN DEFAULT FALSE,
  ventilator_required BOOLEAN DEFAULT FALSE,
  notes TEXT,
  requested_by INT,
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES cases(case_id),
  FOREIGN KEY (requested_by) REFERENCES users(user_id)
);

CREATE TABLE activity_events (
  event_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  event_data JSON,
  performed_by INT,
  performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES cases(case_id)
);

CREATE TABLE notifications (
  notification_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT,
  recipient_user_id INT,
  message TEXT,
  channel ENUM('IN_APP','SMS','EMAIL') DEFAULT 'IN_APP',
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES cases(case_id),
  FOREIGN KEY (recipient_user_id) REFERENCES users(user_id)
);

-- SEED DATA
INSERT INTO hospitals (name, address, latitude, longitude, contact) VALUES
('City Emergency Hospital', 'MG Road, Bangalore', 12.9716, 77.5946, '080-12345678'),
('Apollo Hospital', 'Bannerghatta Road, Bangalore', 12.9121, 77.5956, '080-87654321'),
('Manipal Hospital', 'Old Airport Road, Bangalore', 12.9591, 77.6488, '+918025023700'),
('Victoria Hospital', 'Bowring Road, Bangalore', 12.9634, 77.5855, '080-22206439');

INSERT INTO ambulances (registration_number, hospital_id, status) VALUES
('KA01AB1234', 1, 'AVAILABLE'),
('KA02CD5678', 1, 'AVAILABLE');

-- Password for all three seeded accounts is:  admin123
INSERT INTO users (name, email, password_hash, role, hospital_id, ambulance_id) VALUES
('Admin User',      'admin@goldenhour.com',  '$2a$10$E8xKrbr/e7dL2OffrH4y6OhSwHUJvE8/NDZPESz1JNPFaXVWofEH.', 'ADMIN',          1,    NULL),
('City ER Desk',    'desk1@goldenhour.com',  '$2a$10$E8xKrbr/e7dL2OffrH4y6OhSwHUJvE8/NDZPESz1JNPFaXVWofEH.', 'HOSPITAL_STAFF', 1,    NULL),
('Apollo ER Desk',  'desk2@goldenhour.com',  '$2a$10$E8xKrbr/e7dL2OffrH4y6OhSwHUJvE8/NDZPESz1JNPFaXVWofEH.', 'HOSPITAL_STAFF', 2,    NULL),
('Ambulance Crew',  'crew@goldenhour.com',   '$2a$10$E8xKrbr/e7dL2OffrH4y6OhSwHUJvE8/NDZPESz1JNPFaXVWofEH.', 'AMBULANCE_CREW', NULL, 1);
/* ==========================================================================
   HACKATHON ADDITION — broadcast fan-out with first-accept-wins
   --------------------------------------------------------------------------
   One `broadcasts` row per Broadcast Request, one `broadcast_targets` row per
   hospital that was alerted. Accepting is a single conditional UPDATE on
   `broadcasts`, so two laptops pressing Accept at the same instant can never
   both win — MySQL picks the winner, not the application.
   ========================================================================== */

CREATE TABLE broadcasts (
  case_code            VARCHAR(20) PRIMARY KEY,
  status               ENUM('PENDING','ACCEPTED','REJECTED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  priority             ENUM('RED','AMBER','GREEN') NOT NULL DEFAULT 'AMBER',
  payload              JSON NOT NULL,          -- the full case snapshot the ER board renders
  accepted_hospital_id INT NULL,
  accepted_at          TIMESTAMP NULL,
  expires_at           TIMESTAMP NULL,
  legacy_case_id       INT NULL,               -- mirror row in `cases`, for the rest of the API
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_broadcast_status (status),
  INDEX idx_broadcast_created (created_at)
);

CREATE TABLE broadcast_targets (
  target_id        INT AUTO_INCREMENT PRIMARY KEY,
  case_code        VARCHAR(20) NOT NULL,
  hospital_id      INT NOT NULL,
  hospital_name    VARCHAR(150) NOT NULL,
  hospital_contact VARCHAR(30) NULL,
  hospital_lat     DECIMAL(10,8) NULL,
  hospital_lng     DECIMAL(11,8) NULL,
  distance_km      DECIMAL(6,1) NULL,
  status           ENUM('PENDING','ACCEPTED','CANCELLED','DECLINED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_case_hospital (case_code, hospital_id),
  INDEX idx_target_hospital (hospital_id, status),
  FOREIGN KEY (case_code) REFERENCES broadcasts(case_code) ON DELETE CASCADE
);

/* Spec §13: lifecycle PENDING -> ACCEPTED -> ARRIVED.
   This is an additive migration: the new ARRIVED enum value and an
   arrived_at timestamp. Do not drop the existing rows. */
ALTER TABLE broadcasts
  MODIFY status ENUM('PENDING','ACCEPTED','ARRIVED','REJECTED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN arrived_at TIMESTAMP NULL AFTER accepted_at,
  ADD INDEX idx_broadcast_arrived (arrived_at);

ALTER TABLE broadcast_targets
  MODIFY status ENUM('PENDING','ACCEPTED','CANCELLED','DECLINED','EXPIRED','CLOSED') NOT NULL DEFAULT 'PENDING';

/* The two hackathon laptops are hospital_id 1 and 2, seeded above.
   Keep their ids in step with config/hospitals.config.js. */
