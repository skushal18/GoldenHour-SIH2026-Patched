# GoldenHour — Emergency Response Coordination Platform

GoldenHour is a real-time emergency response coordination platform designed to connect paramedics, ambulances, and hospital emergency departments during critical situations.

A paramedic fills out a short emergency form and presses **Broadcast Request**. Eligible hospitals receive the emergency request in real time. The first authorized ER desk to press **Accept** claims the patient, while the other hospital desks are immediately notified that the request has already been claimed.

The project combines the ambulance application, backend, and hospital-side emergency desk into one repository.

---

## Project Overview

GoldenHour provides three main parts:

- **Ambulance Application** — used by paramedics to create and broadcast emergency requests.
- **Hospital Emergency Desk** — receives incoming emergency requests and allows the ER desk to accept or decline them.
- **Backend Server** — manages requests, hospital matching, authentication, real-time communication, and database operations.

The application uses:

```text
Ambulance App
      │
      │ REST API + Socket.IO
      ▼
GoldenHour Backend
      │
      ├── Emergency Request Management
      ├── Hospital Matching
      ├── Authentication
      ├── Real-time Events
      │
      ▼
Production Database
      │
      ▼
Hospital Emergency Desks
```

The same core architecture supports the internal hackathon demonstration and can be extended for a production deployment.

---

## Repository Structure

```text
goldenhour-master/
├── config/
│   └── hospitals.config.js
│
├── backend/
│   ├── src/
│   │   └── Express + Socket.IO backend
│   ├── public/
│   │   ├── hospital/
│   │   │   └── Hospital emergency desk
│   │   └── landing/
│   │       └── Landing page
│   ├── database/
│   │   └── schema.sql
│   └── tests/
│       └── Backend and end-to-end tests
│
├── app/
│   ├── www/
│   │   ├── config.js
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   │
│   ├── android/
│   │   └── Capacitor Android project
│   │
│   └── tests/
│       └── Ambulance application tests
│
├── docs/
│   ├── architecture
│   ├── API contract
│   └── screenshots
│
├── QUICKSTART.md
├── DEPLOYMENT.md
└── README.md
```

---

# Current Deployment

The GoldenHour backend is deployed using **Railway**.

The ambulance APK has been configured with the deployed backend address through:

```text
app/www/config.js
```

The current deployment therefore follows:

```text
Android Ambulance APK
          │
          │ HTTPS / API
          ▼
   Railway Backend
          │
          ├── REST API
          ├── Socket.IO
          ├── Authentication
          └── Database
          │
          ▼
 Hospital Emergency Desks
```

The deployed backend can be used by the ambulance application without requiring the backend to run on the same laptop as the ambulance device.

---

# Main Features

## Ambulance Application

The ambulance application allows paramedics to:

- Select an emergency case type
- Enter patient age
- Enter vital signs
- Select sex
- Select blood group
- Record consciousness level
- Provide ETA
- Add notes
- Capture up to four photos
- Use GPS location
- Use a fallback/manual location when GPS is unavailable
- Set a broadcast radius
- Broadcast an emergency request
- Track the request status
- Cancel an active request
- See which hospital accepted the request
- Call the accepting hospital
- Navigate to the accepting hospital

---

## Emergency Vital Monitoring

The application provides visual status information for vital signs.

Supported vitals include:

- Systolic blood pressure
- Diastolic blood pressure
- Heart rate
- Respiratory rate
- SpO2
- Glucose

Vital readings are classified into appropriate states such as:

```text
GOOD
CAUTION
CRITICAL
```

Invalid or impossible values are detected instead of being silently accepted.

The interface also provides a text-based state indicator so that vital status is not communicated through colour alone.

---

## Stroke Assessment

For stroke-related cases, the ambulance application provides a FAST assessment panel.

The FAST information is included in the request only when the selected case is a stroke case.

The application does not send FAST information for unrelated emergency cases.

---

# Hospital Emergency Desk

The hospital interface provides an emergency desk board where hospital staff can:

- Receive incoming emergency requests
- View patient and emergency information
- View vital signs
- View location information
- View the broadcast radius
- View submitted photos
- Accept a request
- Decline a request
- See which hospital accepted a request
- Automatically remove a request when another hospital wins the claim
- View the live status of an accepted ambulance until it reaches the hospital
- Record patient arrival using the Reached Hospital / Arrived action
- Close the emergency case after the patient arrives at the hospital

The hospital board receives updates in real time using Socket.IO.

---

# First Hospital to Accept Wins

A key part of GoldenHour is the race between hospitals.

If two hospital desks attempt to accept the same emergency request at almost the same time, exactly one hospital must win.

The production database implementation uses a conditional update:

```sql
UPDATE broadcasts
   SET status = 'ACCEPTED',
       accepted_hospital_id = ?,
       accepted_at = NOW()
 WHERE case_code = ?
   AND status = 'PENDING';
```

If no rows are affected, another hospital has already accepted the request.

This means the database determines the winner rather than relying only on application-level timing.

The winning hospital receives the accepted case.

The other hospital receives a real-time notification and the request is removed from its active board.

---

# Real-Time Communication

GoldenHour uses **Socket.IO** for real-time communication between the backend and hospital desks.

Important events include:

```text
broadcast:new
broadcast:claimed
broadcast:declined
broadcast:cancelled
broadcast:expired
broadcast:snapshot
hospital:identity
case:status
```

This allows hospital desks to receive emergency updates without repeatedly refreshing the page.

---

# Live Transit Status and Case Closure

After a hospital accepts an emergency request, the web dashboard continues to show the ambulance's live case status while the patient is in transit.

The workflow continues beyond hospital acceptance:

```text
Hospital accepts case
        ↓
Ambulance is in transit
        ↓
Hospital dashboard shows live status
        ↓
Ambulance reaches hospital
        ↓
Paramedic uses Reached Hospital / Arrived
        ↓
Patient arrival is recorded
        ↓
Case is closed
```

The ambulance application therefore supports the complete flow from the initial emergency broadcast through hospital acceptance, patient transport, arrival, and case closure.

---

# Location and Hospital Matching

The ambulance application sends the emergency origin together with the broadcast radius.

The backend can use the ambulance's coordinates and hospital coordinates to perform geographic matching using the Haversine distance calculation.

The request contains:

```text
origin
broadcast_radius_km
```

The ambulance application does not select or submit a specific hospital list.

This allows the backend to determine which hospitals are eligible.

---

# GPS Fallback

If GPS is unavailable or permission is refused, the application does not leave the paramedic stuck on the form.

The application provides fallback options including:

- Last known location
- Configured preset location
- Manually typed coordinates

The origin also records how the location was obtained.

Possible sources include:

```text
gps
manual
recalled
```

A manually entered location does not contain an invented GPS accuracy value.

The hospital interface identifies when a position was set manually so that staff do not mistake it for a measured GPS position.

---

# Internal Hackathon Mode

For the internal hackathon, two laptops can represent two hospitals.

The hospital configuration is stored in:

```text
config/hospitals.config.js
```

Example:

```js
const HOSPITAL_LAPTOPS = [
  {
    hospital_id: 1,
    ip: '192.168.1.101',
    name: 'City Emergency Hospital'
  },
  {
    hospital_id: 2,
    ip: '192.168.1.102',
    name: 'Apollo Hospital'
  }
];

const HACKATHON_MODE = true;
```

When hackathon mode is enabled, every emergency broadcast alerts both configured hospital desks regardless of geographic distance.

This is intended for the controlled internal demonstration environment.

It is not intended to be the authentication mechanism for a production hospital deployment.

---

# Production Architecture

GoldenHour is structured so the hackathon configuration can be replaced with production services and security controls without replacing the core ambulance-to-hospital workflow.

Production deployment should use:

- Cloud-hosted backend
- Persistent relational database
- HTTPS
- JWT authentication
- Secure environment variables
- Restricted CORS configuration
- Real hospital records
- Server-side authorization
- Persistent emergency request records
- Production logging
- Monitoring and health checks
- Database backups
- Secure secrets management

The current Railway deployment provides the hosted backend required for the deployed ambulance APK.

---

# Authentication

The internal hackathon configuration can identify hospital desks using configured laptop IP addresses.

For production, the ER desk should use JWT-based authentication.

Production configuration:

```text
DESK_AUTH=jwt
```

With JWT authentication enabled, the hospital identity is taken from the authenticated token rather than trusting the laptop's IP address.

This prevents a user from simply changing the URL parameter or network identity to impersonate another hospital.

The production JWT secret must be stored securely as an environment variable.

---

# Database

GoldenHour supports both a persistent database and an in-memory store.

The database schema is available at:

```text
backend/database/schema.sql
```

The supported database modes are:

| Mode | Behaviour |
|---|---|
| `auto` | Attempts MySQL and falls back to the in-memory store |
| `mysql` | Requires MySQL and refuses to start without it |
| `memory` | Uses the in-memory store |

For production, use a persistent database.

The in-memory store is intended for development and demonstrations because data is lost when the backend restarts.

---

# Quick Start

Install the project dependencies:

```bash
npm run setup
```

Start the application in demo mode:

```bash
npm run demo
```

The backend provides:

```text
/hospital
/ambulance
/
```

The server prints the appropriate addresses when it starts.

---

# Running the Backend

For normal startup:

```bash
npm start
```

The backend starts the GoldenHour master server.

When MySQL is unavailable in automatic mode, the backend can fall back to the in-memory store and display a warning.

For production, use:

```text
DB_DRIVER=mysql
```

so the application does not silently fall back to temporary storage.

---

# Running Tests

Run the complete test suite:

```bash
npm test
```

The test suite covers the ambulance application, configuration, location handling, functional behaviour, and backend behaviour.

Current test coverage includes:

```text
Ambulance application:
92 unit checks
12 configuration checks
21 location checks
80 functional checks

Backend:
40 end-to-end checks
17 JWT desk-authentication checks

Total:
262 checks
```

The tests cover areas including:

- Vital sign validation
- Payload construction
- Location handling
- GPS fallback
- Case types
- Stroke FAST assessment
- Photo handling
- Form validation
- Broadcast behaviour
- Hospital acceptance
- First-hospital-wins behaviour
- Cancellation
- Expiry
- Network failure and retry
- JWT authentication
- Layout and accessibility
- Mobile behaviour
- Configuration handling

---

# Building the Android APK

The Android application uses Capacitor.

The APK is built through GitHub Actions.

Go to:

```text
GitHub Repository
    ↓
Actions
    ↓
Build GoldenHour APK
    ↓
Run workflow
```

The ambulance application's backend address is configured through:

```text
app/www/config.js
```

The current version is configured with the deployed Railway backend URL.

For a different deployment, update `SERVER_BASE` to the required backend address before building the APK.

The APK can then be generated through the GitHub Actions workflow without requiring Android Studio on the development machine.

---

# GitHub Actions

The project uses separate workflows for application builds and testing.

```text
.github/
└── workflows/
    ├── build-apk.yml
    └── tests.yml
```

### Build GoldenHour APK

The APK workflow can be triggered manually and can also run when relevant application files change.

It:

1. Installs dependencies
2. Configures the backend address
3. Synchronizes Capacitor
4. Builds the Android debug APK
5. Publishes the APK as a GitHub Actions artifact

### Automated Tests

The test workflow runs automatically for pushes and pull requests.

The application and backend test suites are executed independently.

---

# APK Deployment

After the GitHub Actions APK build completes:

```text
Actions
   ↓
Build GoldenHour APK
   ↓
Completed workflow
   ↓
Artifacts
   ↓
goldenhour-apk
   ↓
app-debug.apk
```

The generated debug APK can be transferred to an Android device and installed for testing or demonstration.

---

# Browser Access

The ambulance interface can also be opened in a browser when the backend is available on the same network or through the deployed backend.

Example:

```text
http://<server-ip>:5000/ambulance
```

The hospital interface is available at:

```text
http://<server-ip>:5000/hospital
```

The landing page is available at:

```text
http://<server-ip>:5000/
```

For the deployed environment, use the hosted Railway backend address.

---

# API

The ambulance API contract is documented in:

```text
docs/ambulance-app-api-contract.md
```

Important endpoints include:

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/case-types` | Retrieve available emergency case types |
| `POST /api/v1/requests` | Broadcast an emergency case |
| `GET /api/v1/requests/:caseCode` | Retrieve request status |
| `POST /api/v1/requests/:caseCode/cancel` | Cancel an active request |
| `GET /api/v1/desk/me` | Identify the current hospital desk |
| `GET /api/v1/desk/queue` | Retrieve cases waiting for the desk |
| `POST /api/v1/desk/accept/:caseCode` | Accept and claim a case |
| `POST /api/v1/desk/decline/:caseCode` | Decline a case |

The original authenticated APIs remain available:

```text
/api/v1/auth/*
/api/v1/cases/*
/api/v1/hospitals/*
```

The ambulance application does not send a `priority` field and does not directly select a hospital.

---

# Emergency Request Flow

The complete emergency flow is:

```text
1. Paramedic opens ambulance application
                ↓
2. Emergency details are entered
                ↓
3. Vital signs / FAST / photos / location are added
                ↓
4. Paramedic presses Broadcast Request
                ↓
5. Backend creates the emergency request
                ↓
6. Eligible hospitals are determined
                ↓
7. Hospital desks receive the request in real time
                ↓
8. First hospital accepts
                ↓
9. Backend atomically confirms the winner
                ↓
10. Other hospital desks receive broadcast:claimed
                ↓
11. Ambulance receives the accepted hospital
                ↓
12. Paramedic can edit patient details during transit if needed
                ↓
13. Web dashboard shows the live transit status
                ↓
14. Paramedic marks Reached Hospital / Arrived
                ↓
15. Patient arrival is recorded and the case is closed
```

---

# Cancellation and Expiry

An emergency request can be cancelled by the ambulance crew when the emergency response is no longer required.

Requests can also expire when they remain pending beyond the configured validity period.

The corresponding real-time events are:

```text
broadcast:cancelled
broadcast:expired
```

Hospital desks are updated immediately.

---

# Photos

The ambulance application supports emergency photographs.

Images are:

- Added through the camera or browser file input
- Displayed as tiles
- Removable before broadcasting
- Limited to a maximum of four images
- Sent as part of the `images[]` payload

---

# Accessibility and Mobile Design

The ambulance application is designed for mobile use.

The implementation includes:

- Phone-correct viewport configuration
- Safe-area support
- Touch targets of at least 44px
- Mobile-friendly input sizing
- Reduced-motion support
- Dark theme support
- Offline-compatible design
- No external web font dependency
- Accessible labels for form controls
- Proper dialog overlays
- Text-based vital status indicators

---

# Development Configuration

The ambulance configuration is located at:

```text
app/www/config.js
```

Important configuration values include:

```text
SERVER_BASE
FALLBACK_ORIGIN
```

Production secrets should never be committed to GitHub.

Use environment files locally and secure environment-variable storage in the deployment platform.

---

# Production Deployment Checklist

Before using GoldenHour with real hospitals, complete the following:

- [ ] Use HTTPS for the backend
- [ ] Use a persistent production database
- [ ] Set `DB_DRIVER=mysql` or the selected production database driver
- [ ] Enable `DESK_AUTH=jwt`
- [ ] Configure a strong production `JWT_SECRET`
- [ ] Configure `CORS_ORIGIN`
- [ ] Replace demo hospital records with real hospital information
- [ ] Remove seeded demo accounts and passwords
- [ ] Use secure environment variables
- [ ] Disable hackathon-only IP authentication
- [ ] Set `HACKATHON_MODE=false`
- [ ] Set `ALLOW_MANUAL_HOSPITAL_OVERRIDE=false`
- [ ] Configure production hospital coordinates
- [ ] Configure database backups
- [ ] Configure application logging
- [ ] Configure server monitoring
- [ ] Configure health checks
- [ ] Test network failure and recovery
- [ ] Test simultaneous hospital acceptance
- [ ] Test cancellation and expiry
- [ ] Test GPS failure and fallback behaviour
- [ ] Perform security testing
- [ ] Build and verify the production APK
- [ ] Verify the APK communicates with the HTTPS backend

---

# After the Hackathon

The hackathon configuration can be replaced with a production hospital configuration.

Set:

```text
HACKATHON_MODE=false
ALLOW_MANUAL_HOSPITAL_OVERRIDE=false
DESK_AUTH=jwt
```

Then configure real hospitals in the database with:

```text
Hospital name
Latitude
Longitude
Contact information
Hospital status
```

The backend can then perform real geographic hospital matching using the ambulance location and configured broadcast radius.

The ambulance application continues to use the same core emergency request workflow.

---

# Security Considerations

The internal hackathon environment intentionally uses simplified authentication and hospital identification to make the demonstration easy to operate.

A real deployment must not rely on those mechanisms.

Production deployment should include:

- HTTPS/TLS
- JWT authentication
- Strong secrets
- Secure password storage
- Role-based authorization where required
- Restricted CORS
- Secure database credentials
- Input validation
- Server-side authorization
- Rate limiting
- Request logging
- Audit logging
- Database backups
- Secret rotation
- Monitoring and alerting

Demo credentials must never be used in production.

---

# Documentation

Additional project documentation is available in:

```text
docs/
```

Important documents include:

```text
docs/ARCHITECTURE.md
docs/ambulance-app-api-contract.md
QUICKSTART.md
DEPLOYMENT.md
```

The screenshots in:

```text
docs/screenshots/
```

document the running application and demonstration flow.

---

# Technology Stack

## Frontend

- HTML
- CSS
- JavaScript
- Capacitor
- Android

## Backend

- Node.js
- Express
- Socket.IO

## Database

- MySQL
- In-memory store for development/demo fallback

## Deployment

- Railway
- GitHub
- GitHub Actions

## Testing

- Node.js test environment
- jsdom
- Automated application tests
- Backend end-to-end tests

---

# Project Status

## Implemented

- Ambulance emergency request interface
- Hospital emergency desk
- Real-time hospital notifications
- First-hospital-to-accept-wins logic
- REST API
- Socket.IO communication
- Location-based hospital matching
- GPS fallback handling
- Vital sign validation and status
- Stroke FAST assessment
- Emergency photo support
- Request cancellation
- Request expiry
- Network retry handling
- In-transit patient detail editing
- Live ambulance transit status on the web dashboard
- Reached Hospital / Arrived action for recording patient arrival
- Case closure after hospital arrival
- Android APK build pipeline
- Railway backend deployment
- Railway-connected ambulance APK
- Automated application testing
- Backend end-to-end testing
- JWT authentication test coverage

## Next Production Security Step

JWT authentication is the next major production-security step for the hospital emergency desk.

The current hackathon IP-based identity mechanism should be replaced by authenticated hospital users before real-world deployment.

---

# Project Goal

GoldenHour is built around one simple objective:

> **Reduce the time between an emergency occurring and a hospital being ready to receive the patient.**

Instead of relying on phone calls and manual coordination between an ambulance and multiple hospitals, GoldenHour provides a shared real-time communication layer.

The ambulance broadcasts once.

Hospitals receive the request simultaneously.

The first hospital to accept wins.

Everyone else is updated immediately.

---

# Important Notes

The internal hackathon configuration is designed for demonstration and controlled testing.

The production deployment must use proper authentication, secure communication, persistent storage, real hospital data, and appropriate security controls.

GoldenHour's core emergency communication and hospital-acceptance workflow is designed to remain the same as the system moves from the hackathon environment toward production.
