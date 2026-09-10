# GoldenHour

**Pre-arrival emergency coordination between ambulance crews and hospital emergency departments.**

An ambulance crew enters what they have, taps once, and every emergency
department in range is alerted at the same instant. The first to accept takes
the case; every other board clears. From that moment the accepting ER can see
the patient's vitals change in transit, watch the ambulance's ETA, and know
before the ambulance is late rather than after.

The crew never chooses a hospital, and never grades their own patient. Both of
those are the system's job.

---

## The workflow

```
Crew enters the emergency          →  case type, consciousness, vitals,
                                      FAST check for a stroke, photos
Position is captured               →  GPS, or a recalled fix, or typed —
                                      always labelled with which
Broadcast                          →  every hospital within the radius, at once
First hospital accepts             →  atomically; every other board clears
Ambulance en route                 →  live position, derived ETA, stall detection
Patient details change in transit  →  the accepting ER sees them within a second
Reached hospital                   →  arrival recorded, case closed, handover printed
```

---

## Quick start

```bash
npm run setup     # installs backend/ and app/
npm run build     # builds both front-ends
npm run demo      # starts on :5000 with an in-memory store
```

Then open, on the same machine:

| Surface | URL |
|---|---|
| Ambulance app | <http://localhost:5000/ambulance> |
| ER desk — hospital 1 | <http://localhost:5000/hospital/?hospital=1> |
| ER desk — hospital 2 | <http://localhost:5000/hospital/?hospital=2> |
| Landing page | <http://localhost:5000/> |
| Health | <http://localhost:5000/health> |

Open the two desks side by side, broadcast from the app, and accept on one.
The card leaves the other board in under a second.

A phone on the same Wi-Fi reaches it at `http://<your-laptop-ip>:5000/ambulance`.

### Tests

```bash
npm test          # 412 checks: 76 contrast + 205 app + 131 backend
```

Both front-ends are rebuilt before their suites run, so a test can never pass
against stale output.

---

## Repository layout

```
app/                       Ambulance app — also the APK payload
  src/                     Source of truth
    index.html
    main.js                Entry: DOM wiring only
    styles.css
    modules/
      logic.js             Vital bands, payload shape, resource derivation
      env.js               Live-vs-demo resolution
      geo.js               Location, and honesty about it
      transport.js         Live and demo transports, same interface
      outbox.js            Offline queue
      cases.js             On-device case history
  www/                     BUILD OUTPUT, committed (see below)
    config.js              Hand-written — the one line to edit for the APK
    vendor/socket.io.min.js
  android/                 Capacitor Android project, committed
  tests/                   205 checks, plain Node + jsdom

backend/
  src/
    server.js              API + Socket.IO + both front-ends, one process
    config/security.js     Boot-time configuration audit
    middleware/            Desk identity, rate limiting, headers, errors
    routes/                requestRoutes (crew) · hospitalDeskRoutes (ER)
    services/              broadcast · triage · tracking · capacity · match · audit · validation
    store/                 memoryStore | mysqlStore behind one interface
  desk/                    ER desk board source (Vite)
  public/hospital/         BUILD OUTPUT, committed
  public/landing/
  database/schema.sql
  tests/                   131 checks

shared/design/
  tokens.css               One palette, both front-ends
  primitives.css
  contrast.check.js        76 WCAG pairs, enforced in CI

config/hospitals.config.js Demo hospital map
data/hospitals/            93 curated Bengaluru records
```

**`app/www` and `backend/public/hospital` are committed build artefacts.** A
judge cloning the repo should get a working system without running a build in
three places, the APK workflow rewrites a file inside `app/www`, and `npm
start` on a clean clone has to serve both front-ends. A CI job rebuilds and
fails if the committed output has drifted from source.

---

## How the pieces fit

### Triage is the server's job

The crew sends observations. `services/triage.js` derives the priority
(RED / AMBER / GREEN) and the critical flags — shock, hypoxia, low GCS, cardiac
arrest, airway compromise — from the vitals. `priority` never appears in
anything the app sends, and there is a test that asserts it never will.

### Capacity ranks, it never blocks

Each desk declares what it has free: resus bays, ventilators, CT, theatre,
blood, cath lab, and whether it is on diversion. That produces a `match_score`
per hospital and a needs row on each case card.

It is deliberately a **soft** gate. A hospital with stale capacity, or one that
forgot to update it, still gets every alert. The Accept button changes to
**"Accept anyway"** with the reason underneath — but the decision stays with
the desk. The failure mode of a hard filter is a patient nobody is told about;
the failure mode of a soft gate is one extra line to read.

A hospital that has reported nothing shows `?`, not `✗`. Unknown is not a
refusal.

### Location is labelled, never laundered

A phone browser on a plain-http LAN address is refused geolocation by Chrome,
because a private-IP http origin is not a secure context. So the app offers
GPS, then the last fix from this shift, then a one-tap preset, then typed
coordinates — and tags every one with how it was obtained. A hand-typed origin
carries **no accuracy figure**, and the ER board marks the distance as
computed from a typed position. An ER reads "1.8 km away" very differently
when the 1.8 km was measured.

### Tracking, and what it is actually for

Between acceptance and arrival the app shares its position with the accepting
hospital only, at most once every 10 seconds. The server derives a live ETA
from the median of recent point-to-point speeds — median, so one GPS jump does
not double the estimate — clamped to 15–80 km/h and multiplied by 1.25 because
roads are not straight.

Below 5 km/h for 90 seconds the ETA source becomes `stalled` and the board
reads **"not moving"**. That is the clinically useful part: a stuck ambulance
is otherwise invisible until it fails to arrive.

The crew's own screen receives the derived ETA and distance but **not** the
coordinates it just sent — anyone holding a case code can join a case room, and
echoing positions back would turn a case code into a way to track a vehicle.

### Realtime events

```
broadcast:new        broadcast:claimed     broadcast:declined
broadcast:cancelled  broadcast:expired     broadcast:snapshot
hospital:identity    hospital:rejected     capacity:changed
case:status          case:position         case:arrived        patient:updated
```

Crew → server: `case:follow`, `case:unfollow`, `patient:update`,
`ambulance:position`, `ambulance:delayed`, `ambulance:arrived`. All of them
acknowledge, so a client can tell "subscribed" from "the server never heard me".

### API

```
GET   /api/v1/case-types
POST  /api/v1/requests                      idempotent via X-Client-Request-Id
GET   /api/v1/requests/:caseCode
POST  /api/v1/requests/:caseCode/cancel
POST  /api/v1/requests/:caseCode/arrived    REST fallback when the socket is gone

GET   /api/v1/desk/me                       every /desk route is behind deskGuard
GET   /api/v1/desk/queue
GET   /api/v1/desk/history
POST  /api/v1/desk/accept/:caseCode
POST  /api/v1/desk/decline/:caseCode
GET   /api/v1/desk/capacity                 PUT to update · /all for the network
GET   /api/v1/desk/track/:caseCode          403 unless this desk owns the case
GET   /api/v1/desk/handover/:caseCode
GET   /api/v1/desk/timeline/:caseCode
GET   /api/v1/desk/analytics
GET   /health
```

Sign-in (`/api/v1/auth/login` and `/register`) is **not mounted**. Neither
front-end has a login screen, and the demo does not need one: desks identify by
`?hospital=<id>` under `DESK_AUTH=ip`, and under `DESK_AUTH=jwt` the backend
verifies a token but does not issue it. The handlers exist and are hardened —
registration behind an admin token with a first-run bootstrap exception, roles
from an allowlist, constant-shape login failures, tight rate limits — and
`backend/src/server.js` says which single line brings them back.

### Idempotency is not optional

The offline outbox retries, and "flush when the browser goes online" and
"flush when the socket connects" can fire together. Without
`X-Client-Request-Id`, that pair puts the same patient on two ER boards. A
repeat returns `200` and the original case code; a first send returns `201`.

---

## Configuration and safety

Everything is in `backend/.env` — see `backend/.env.example`, which documents
each value and why it is there.

**With `NODE_ENV=production` the server audits its own configuration at boot
and refuses to start if anything would be unsafe.** It prints exactly what to
change and exits `78`. The gate covers:

| Refuses to start when | Because |
|---|---|
| `DESK_AUTH` is not `jwt` | `?hospital=2` lets anyone claim to be any hospital |
| `JWT_SECRET` is missing, short, or a value published in this repo | tokens signed with a known secret are not tokens |
| `CORS_ORIGIN` is unset or `*` | every origin on the internet could call the API |
| `DB_DRIVER` is not `mysql` | `auto` falls back to memory and loses cases silently |
| `HACKATHON_MODE` is on | broadcasts would go to two hardcoded demo hospitals |

Outside production these are warnings printed at startup, so the demo keeps its
conveniences and they become impossible to ship by accident. A CI job proves
both halves: an unsafe production boot fails, a correct one gets past the gate.

Also in place: per-client rate limiting on the crew endpoints (generous — a
refused emergency broadcast is far worse than the flood it prevents), CSP and
the usual security headers, `no-store` on API responses, full validation of
every broadcast field, inline-data-only images, and errors that carry an id for
the log instead of a stack trace for the caller.

### Two modes

| | Demo / LAN | Production |
|---|---|---|
| `NODE_ENV` | unset | `production` |
| `DESK_AUTH` | `ip` — `?hospital=<id>` | `jwt` |
| `DB_DRIVER` | `auto` or `memory` | `mysql` |
| `HACKATHON_MODE` | `true` | `false` |
| `CORS_ORIGIN` | blank | explicit origins |

---

## The Android APK

Built entirely in GitHub Actions — no Android Studio, no local SDK, no Java,
nothing installed globally.

**Actions → "Build GoldenHour APK" → Run workflow.** Put the backend address in
the `server_base` box (for example a Railway URL); leave it blank and the APK
ships in demo mode. Download the `goldenhour-apk` artifact, unzip, install.

`@capacitor/cli` is a project devDependency, so `npx cap` in CI resolves to the
pinned version from the lockfile. The workflow asserts this before it builds,
because "could not determine executable to run" was the old failure and it came
from expecting a global install.

Locally, with an Android SDK:

```bash
npm --prefix app run apk
```

### `SERVER_BASE`, and why it ships empty

`app/www/config.js` is hand-written and excluded from the bundle. It ships with
`SERVER_BASE: ""`.

That is not an oversight. Capacitor serves the APK's own assets from
`https://localhost`, so "use the page origin" would resolve to
`https://localhost/api/v1` — a server that does not exist — and the crew would
see a form that submits into nothing and never says why. An APK with no
`SERVER_BASE` configured therefore falls into **demo mode**, loudly. There are
twelve tests on that one rule.

Set it through the workflow input, or edit the one line before building.

---

## Accessibility

Not aspirations — each of these is checked.

- Every text/background pair in the design system is ≥ 4.5:1, every border and
  graphical boundary ≥ 3:1. 76 pairs, verified in CI by
  `shared/design/contrast.check.js`, in light and dark.
- **No state is signalled by colour alone.** Vital bands carry the word
  (`Normal` / `Caution` / `Critical` / `Check value`); priority badges carry
  `RED · CRITICAL`; connection pills carry `Live` / `Demo` / `Offline`; capacity
  needs carry `✓` / `✗` / `?`. Roughly one man in twelve has a red-green
  deficiency, and this is the ER's traffic light.
- Every interactive target is at least 44 px; primary actions 60 px.
- Inputs are 17 px, so a mobile browser never zooms the form on focus.
- Safe-area insets top and bottom; works at 360 px and up.
- `prefers-reduced-motion` is honoured, with one exception: the pending-broadcast
  pulse becomes a static outline rather than vanishing, because "is this still
  waiting for an answer?" is information, not decoration.
- Light and dark themes, with a three-state Auto / Light / Dark control, read
  before the stylesheet so the wrong theme never flashes on a night shift.

---

## Test inventory

| Suite | Checks |
|---|---|
| `shared/design/contrast.check.js` | 76 |
| `app/tests/test.js` — pure logic, no DOM | 92 |
| `app/tests/config.test.js` — where the backend is | 12 |
| `app/tests/location.test.js` — GPS fallbacks | 21 |
| `app/tests/functional.test.js` — the app driven in jsdom | 80 |
| `backend/tests/security.test.js` — the production config gate | 16 |
| `backend/tests/broadcast.smoke.js` — the whole flow | 12 |
| `backend/tests/broadcast.e2e.test.js` | 40 |
| `backend/tests/desk-auth.test.js` — `DESK_AUTH=jwt` | 17 |
| `backend/tests/patient-edit.test.js` | 12 |
| `backend/tests/arrival-lifecycle.test.js` | 15 |
| `backend/tests/tracking.test.js` | 5 |
| `backend/tests/capacity.test.js` | 4 |
| `backend/tests/matching.test.js` | 5 |
| `backend/tests/audit.test.js` | 2 |
| `backend/tests/analytics.test.js` | 2 |
| `backend/tests/idempotency.test.js` | 1 |
| **Total** | **412** |

---

## What is deliberately not here

Worth naming, because a judge will ask.

- **No routing API for the ETA.** It needs internet, a key and a per-request
  budget, and the venue may have none of them. The straight-line-times-1.25
  estimate is honest about being an estimate and the UI says so.
- **No background location.** Android 14+ would need
  `FOREGROUND_SERVICE_LOCATION` and a persistent notification. Foreground only,
  between acceptance and arrival.
- **Capacity is self-reported.** A hospital HIS integration is the real answer
  and is well outside this scope.
- **Analytics over the in-memory store** are labelled as resetting on restart,
  on the page, not in a footnote.

## Further reading

- `docs/REBUILD-NOTES.md` — what was broken, what changed, and why
- `DEPLOYMENT.md` — Railway, MySQL, going to production
- `docs/ARCHITECTURE.md` — module map and merge history
- `backend/.env.example` — every setting, annotated
