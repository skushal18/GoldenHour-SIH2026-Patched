# GoldenHour — SIH 2026

> **Emergency Ambulance-to-Hospital Pre-Arrival Coordination Platform**

GoldenHour is a real-time emergency coordination system that connects ambulance crews with hospital emergency departments before a patient reaches the hospital.

## Final Status

- **Railway cloud deployment:** Complete
- **Cloud backend:** Running
- **Hospital ER dashboard:** Complete
- **Ambulance application:** Complete
- **Android/Capacitor application:** Complete
- **Realtime Socket.IO communication:** Implemented
- **MySQL production persistence:** Supported
- **Patient updates during transit:** Implemented
- **Live tracking / ETA:** Implemented
- **Hospital capacity:** Implemented
- **Reached Hospital / case closure:** Implemented
- **Automated test inventory:** 412 documented checks
- **GitHub Actions APK build:** Implemented

---

## What GoldenHour Does

```text
Ambulance
   ↓
Enter emergency + patient information
   ↓
Capture location and clinical information
   ↓
Broadcast to nearby hospitals
   ↓
Hospitals receive the case
   ↓
First eligible hospital accepts
   ↓
Ambulance receives acceptance
   ↓
Hospital follows the case during transit
   ↓
Patient information can be updated
   ↓
Ambulance reaches hospital
   ↓
Hospital records arrival
   ↓
Case closes
```

---

## Final Cloud Architecture

```text
┌──────────────────────┐
│   Ambulance App      │
│   Web / Android APK  │
└──────────┬───────────┘
           │ HTTPS
           │ Socket.IO
           ▼
┌──────────────────────┐
│   Railway Cloud      │
│ Express + Socket.IO  │
└──────────┬───────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
  MySQL      Hospital
 Database    ER Dashboard
```

The final deployment is cloud-based. The production workflow does **not** depend on a local LAN server or a laptop IP.

---

## Ambulance Application

The completed ambulance interface includes:

- Home
- New Alert
- Cases
- Settings
- Recent Activity
- Active Case
- Patient editing
- Vital signs
- Location handling
- Hospital acceptance
- ETA / transit status
- Delay reporting
- Navigation
- Calling the hospital
- Reached Hospital
- Case closure
- Offline/outbox handling
- Photo attachment

### Patient information

- Baby
- Child
- Adult
- Senior Citizen
- Unknown
- Sex
- Blood group
- Consciousness
- Blood pressure
- Heart rate
- Respiratory rate
- SpO₂
- Glucose
- Notes

---

## Hospital ER Dashboard

The completed dashboard includes:

- Incoming cases
- Active cases
- Hospital capacity
- Resuscitation bays
- Ventilators
- CT
- Operating theatre
- Blood
- Cath lab
- Diversion status
- Network status
- Case priority
- Critical flags
- Patient information
- Vital signs
- Resource requirements
- Ambulance tracking
- ETA state
- Arrival confirmation
- Handover information

---

## Realtime Case Acceptance

The system guarantees that the first valid hospital acceptance wins.

```text
Hospital A ──┐
             ├──→ Atomic acceptance → Winning hospital
Hospital B ──┘
```

The other hospital is cleared/notified so two hospitals do not simultaneously claim the same case.

---

## Clinical Prioritisation

Triage is handled server-side.

The system can surface critical conditions such as:

- Shock
- Hypoxia
- Low GCS
- Cardiac arrest
- Airway compromise

The priority is derived by the backend rather than being supplied as a client-controlled value.

---

## Tracking

After acceptance, the accepting hospital can receive ambulance location updates at controlled intervals.

The system derives:

- Distance
- ETA
- Recent movement
- Stalled state
- Location freshness

The interface explicitly communicates uncertainty such as:

- `LIVE`
- `CREW ESTIMATE`
- `NOT MOVING`
- `LOCATION STALE`
- `ETA UNAVAILABLE`

---

## Patient Updates

Patient details can be edited during transit.

The case code does not change when patient information is updated.

This allows the receiving hospital to react to deterioration or newly available information before arrival.

---

## Arrival Lifecycle

```text
PENDING
  ↓
ACCEPTED
  ↓
EN ROUTE
  ↓
ARRIVED
  ↓
CLOSED
```

The ambulance application provides **Reached hospital**.

The hospital dashboard provides an arrival confirmation and closes the case after confirmation.

---

## Cloud Deployment

GoldenHour is deployed on **Railway**.

Production communication:

```text
Android / Web
     ↓
Internet
     ↓
Railway
     ↓
Backend
     ↓
MySQL
     ↓
Hospital dashboard
```

No local LAN server is required for the final cloud deployment.

---

## Android APK

The ambulance client is packaged using Capacitor.

APK builds are handled through GitHub Actions.

The workflow can inject the production backend base URL during the build, allowing the generated APK to communicate with the Railway deployment.

---

## Security

The project includes:

- Input validation
- Security headers
- Content Security Policy
- Rate limiting
- No-store API responses
- CORS restrictions
- Secure production configuration
- Authentication infrastructure
- Error IDs
- Production safety checks

Production mode is designed to reject unsafe configuration defaults.

---

## Accessibility

The shared design system includes:

- 76 documented contrast checks
- 4.5:1 minimum target for normal text
- 3:1 target for borders/graphics
- 44 px minimum interactive targets
- Larger primary actions
- Safe-area support
- Reduced-motion support
- Acrylic fallback
- Non-colour-only state communication

---

## Testing

The final project documentation records **412 checks**:

| Area | Checks |
|---|---:|
| Design contrast | 76 |
| Ambulance app | 205 |
| Backend | 131 |
| **Total** | **412** |

The test coverage includes configuration, location, functional behaviour, security, realtime broadcast, patient editing, arrival lifecycle, tracking, capacity, matching, audit, analytics and idempotency.

---

## Repository Structure

```text
GoldenHour-SIH2026-Patched/
├── app/
│   ├── src/
│   ├── www/
│   ├── android/
│   └── tests/
├── backend/
│   ├── src/
│   ├── desk/
│   ├── public/
│   │   ├── hospital/
│   │   └── landing/
│   ├── database/
│   └── tests/
├── shared/
├── config/
├── data/
├── docs/
├── package.json
└── README.md
```

---

## API Overview

### Ambulance

- `GET /api/v1/case-types`
- `POST /api/v1/requests`
- `GET /api/v1/requests/:caseCode`
- `POST /api/v1/requests/:caseCode/cancel`
- `POST /api/v1/requests/:caseCode/arrived`

### Hospital desk

- `GET /api/v1/desk/me`
- `GET /api/v1/desk/queue`
- `GET /api/v1/desk/history`
- `POST /api/v1/desk/accept/:caseCode`
- `POST /api/v1/desk/decline/:caseCode`
- `GET /api/v1/desk/capacity`
- `PUT /api/v1/desk/capacity`
- `GET /api/v1/desk/track/:caseCode`
- `GET /api/v1/desk/handover/:caseCode`
- `GET /api/v1/desk/timeline/:caseCode`
- `GET /api/v1/desk/analytics`

### System

- `GET /health`

---

## Important Limitations

The project should be presented as a serious SIH/hackathon engineering prototype, not as a clinically certified hospital product.

Future production work may include:

- Hospital HIS/EMR integration
- Formal clinical validation
- External road-routing
- Background location
- Large-scale hospital onboarding
- Long-term analytics
- High-availability/disaster recovery
- Regulatory and clinical safety review

---

## Project Principle

> **Give the hospital the right information before the patient arrives.**

GoldenHour focuses on reducing the communication gap between ambulance crews and emergency departments so that the receiving hospital can prepare earlier and respond with better information.
