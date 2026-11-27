<p align="center">
  <img src="docs/brand/goldenhour-logo.png" alt="GoldenHour logo: an ambulance in front of a golden sun whose face is a clock" width="132">
</p>

<h1 align="center">GoldenHour</h1>
<p align="center"><b>Pre-arrival coordination between ambulance crews and hospital emergency departments.</b><br>
One alert from the ambulance reaches every nearby ER at once. The first to accept takes the patient — and both follow the ambulance, live, until it reaches the door.</p>

<p align="center">
  <a href="https://d1k7k7ahunvfhc.cloudfront.net">Live</a> ·
  <a href="https://d1k7k7ahunvfhc.cloudfront.net/hospital/">ER desk</a> ·
  <a href="https://d1k7k7ahunvfhc.cloudfront.net/admin/">Admin</a> ·
  <a href="https://d1k7k7ahunvfhc.cloudfront.net/ambulance/">Ambulance app (web)</a> ·
  <a href="docs/GOLDENHOUR-GUIDE.md">User guide</a> ·
  <a href="deploy/aws/README.md">Operations</a>
</p>

---

## Why

The *golden hour* is the first hour after a serious injury or a sudden illness such as a stroke or a heart attack — the window in which treatment changes outcomes most. In India an ambulance crew usually phones hospitals one at a time to find one that can take a critical patient, and the hospital that says yes learns almost nothing until the doors open.

GoldenHour turns that into one message:

1. The **ambulance app** sends the case once — what happened, vitals, photos, position.
2. Every **ER desk** on GoldenHour within range sees it instantly, with a map, the patient's triage priority, what the patient will need, and whether the hospital has it.
3. The **first ER to accept** takes the patient. Every other desk is cleared.
4. The crew gets **turn-by-turn directions** to that hospital; the ER watches the ambulance on a **live map** with a live ETA and an *arriving in 3 minutes — get ready* alert.
5. On arrival the ER prints a **one-page handover sheet**.

GoldenHour is decision support, not a certified clinical product: priority is computed from the vitals, never a diagnosis.

## The three parts

### Ambulance app — Android (Capacitor) and web
- **Own login per ambulance.** The administrator registers each vehicle and issues a one-time sign-in code; the crew enters it once on the phone that rides in that ambulance. Every case carries the vehicle.
- **One-screen alert.** Case type, age group, sex, vitals (flagged against clinical bands as you type), consciousness, FAST stroke check, photos (compressed on the phone), radius and a crew note. No hospital to choose: that is the point.
- **Works on a bad signal.** An offline outbox keeps a case until the network is back; a repeat send is recognised and never creates a second case.
- **Navigation after acceptance.** Live map with the road route, the next turn, all directions, distance by road, ETA and arrival time; *Navigate* hands the trip to Google Maps for voice guidance; *Call* rings the ER.
- **Live position for the ER.** GPS goes over a WebSocket, with an HTTP fallback when the socket is down; rough fixes are sent and marked approximate rather than dropped.
- **Crew on shift** and **this phone** (model, Android version, app version, battery, network) in Settings.

### ER desk — every hospital signs in to its own board
- **Incoming cases** with priority, vitals, red flags, what the patient will need against what the hospital has, crew photos and a map of where the case was sent from. Accept or decline; a sound for each new case.
- **En route** cards with a live map (ambulance trail, accuracy ring, dashed line to the desk), a sentence that updates every second — *"1.9 km away · about 4 min (live GPS) · 37 km/h · updated 10 s ago"* — stale/stopped warnings, crew delay reports, and an **arriving** banner and chime.
- **The desk's own screen location** is the hospital end of the map and the ETA (directory address as the fallback, with the reason shown).
- **Capacity** (resus bays, ventilators, CT, theatre, blood, cath lab, diversion) shared with crews and other desks; nearby hospitals; a timeline per case; a printable **handover sheet**.

### Admin console
- **Network at a glance:** hospitals, live logins, ambulances signed in, ambulances en route, cases waiting.
- **Hospital accounts:** activation codes for every hospital at once (CSV downloaded once), re-issue, reset, disable.
- **Ambulances:** register a vehicle and get its code; see **which phone the app is installed on** (model, OS, app version, battery, network, location permission), **the crew on shift**, online/offline and the case it is on; issue a new code (signs the old phone out), switch off/on.
- **Live cases** on a **network map**, the hospital **directory** (all-India list of 29,844 hospitals to add from) and the **audit log**.

## How it works

```text
 Ambulance app (Android / web)                 ER desks (one per hospital)
   │ sign in with a one-time code                ▲  new case, live position,
   │ POST /requests  ── case + vehicle ──┐       │  arriving alert (Socket.IO)
   │ GPS: socket · HTTP fallback         ▼       │
   │                         ┌─────────────────────────────┐
   │ GET /requests/:c/route ◀│ Express + Socket.IO (Node 22)│──▶ OSRM (road route)
   └────────────────────────▶│ triage · matching · tracking │
                             │ accounts · audit · capacity  │
                             └──────────────┬──────────────┘
                                            ▼
                            MySQL 8.4 (RDS) — hospitals, accounts, ambulances,
                            cases, capacity, case events
```

* **Matching:** a case goes to every hospital *with an active login* within the crew's radius (15 km default), ranked by distance, capacity and the patient's needs. Nobody in range → the crew gets the nearest directory hospitals with phone numbers.
* **First accept wins:** decided by a single conditional `UPDATE … WHERE status='PENDING'` — two desks pressing *Accept* together get exactly one winner and one "already taken by …".
* **ETA:** a city-speed estimate until three precise GPS fixes give a measured speed, then live; the crew's road route comes from OSRM.

## Security and privacy

| | |
|---|---|
| Hospitals | Each hospital chooses its own username and password with a one-time activation code. Passwords are bcrypt; 5 wrong attempts lock for 15 minutes; disabling or resetting voids every token at once. |
| Sessions | Leaving GoldenHour for more than 5 minutes asks for the password again; an open ER screen stays signed in; the admin console signs out after 30 idle minutes. |
| Ambulances | One-time codes stored as SHA-256; a new code or a switch-off signs the old phone out on its next request; production refuses an unsigned case. |
| Cases | Sequential case codes are not secrets: every crew action needs the case's random crew token (stored as a hash). |
| Production gate | With `NODE_ENV=production` the server refuses to start on a weak JWT secret, open CORS, the in-memory store or demo mode. |
| Data | Patient details stay with the accepting hospital; the network map and the admin see positions and case codes, not patients. GPS trails are dropped when a case closes. |

## Run it locally

```bash
npm run setup            # backend + app dependencies
npm run demo             # in-memory server on http://localhost:5000
```

The demo prints sign-ins for an administrator and two Bengaluru ER desks (`DEMO_PASSWORD` fixes them). Open `/admin` → **Ambulances** → register a vehicle, then open `/ambulance` and sign in with its code. `/hospital` is the ER desk.

```bash
npm test                 # design contrast · app (6 suites) · backend (18 suites)
```

Set `TEST_MYSQL_URL=mysql://user:pass@host/<db named *test*>` to run the MySQL suite too (CI runs MySQL 8.4).

**Android APK:** GitHub → Actions → **Build GoldenHour APK** (also runs on pushes to `Patch-2` that touch `app/`). The APK talks to the server in `app/www/config.js`.

## Deploy (AWS, ap-southeast-2)

Three tiers in one CloudFormation template — [`infra/goldenhour.yaml`](infra/goldenhour.yaml):

| Tier | What |
|---|---|
| Presentation | S3 (private) + CloudFront with Origin Access Control; `/api/*`, `/socket.io/*` and `/health` go to the app tier uncached, WebSockets included |
| Application | Elastic Beanstalk, Node.js 22 on Amazon Linux 2023, health on `/health`, logs in CloudWatch |
| Data | RDS for MySQL 8.4 in private subnets, encrypted, reachable only from the app |
| Secrets | Secrets Manager (DB password, JWT secret, first administrator), read at boot by the instance role |
| Cost | Sleeps after 2 idle hours (instance and database stopped), wakes on the next visit in ~8–10 min; monthly budget alarm |

```bash
infra/scripts/deploy.sh          # build, new Beanstalk version, S3 sync, CloudFront invalidation
```

Run it with the AWS CLI signed in to the project (`aws login` / SSO). Resource IDs, the sleep/wake runbook and first sign-in: [`deploy/aws/README.md`](deploy/aws/README.md).

## Configuration (selected)

| Variable | Default | |
|---|---|---|
| `CREW_AUTH` | `required` in production | a case needs a signed-in ambulance |
| `AMBULANCE_TOKEN_TTL` | `30d` | how long a phone stays signed in |
| `ROUTING_URL` | public OSRM | road routes for the crew; run your own OSRM for real traffic |
| `DESK_MAX_ACCURACY_M` / `DESK_MAX_DRIFT_KM` | 1000 / 50 | when a desk's own location is not trusted |
| `TRACK_MAX_ACCURACY_M` | 2000 | rougher crew fixes are refused |
| `ACCEPT_WINDOW_SECONDS` | 180 | how long a case waits for an ER |
| `HACKATHON_MODE` | `false` in production | `true` alerts every hospital regardless of distance (demos) |

Front-end settings (map tiles, timeouts, arriving thresholds) are in [`backend/public/hospital/config.js`](backend/public/hospital/config.js). Everything else: [`backend/.env.example`](backend/.env.example).

## API (all under `/api/v1`)

* **Ambulance:** `POST /auth/ambulance/pair` · `GET /ambulance/me` · `POST /ambulance/heartbeat` · `PUT /ambulance/crew` · `POST /ambulance/sign-out` · `GET /case-types` · `POST /requests` · `GET /requests/:code` · `POST /requests/:code/position` · `GET /requests/:code/route` · `POST /requests/:code/cancel` · `POST /requests/:code/arrived` (case routes need `X-Crew-Token`)
* **Sign-in:** `POST /auth/login` · `GET /auth/me` · `POST /auth/change-password` · `POST /auth/logout` · `POST /auth/activate/lookup` · `POST /auth/activate`
* **ER desk:** `/desk/me` · `PUT /desk/location` · `/desk/queue` · `/desk/history` · `/desk/accept/:code` · `/desk/decline/:code` · `/desk/arrived/:code` · `/desk/capacity` · `/desk/nearby` · `/desk/track/:code` · `/desk/handover/:code` · `/desk/timeline/:code` · `/desk/analytics`
* **Admin:** `/admin/accounts…` · `/admin/ambulances…` · `/admin/directory…` · `/admin/catalogue…` · `/admin/live` · `/admin/audit`

Realtime (Socket.IO): `broadcast:new`, `broadcast:claimed`, `case:position`, `case:delay`, `case:arrived`, `patient:updated`, `capacity:changed`; crew events `case:follow`, `ambulance:position`, `ambulance:delayed`, `ambulance:arrived`, `patient:update` (each with its crew token).

## Repository

```text
app/            ambulance app — src/ (Vite) → www/ (committed, served and bundled into the APK), android/
backend/        Express + Socket.IO server, ER desk + admin (public/hospital), landing page, tests
data/hospitals/ the 100-hospital network and the all-India directory (data.gov.in, GODL-India)
infra/          CloudFormation, Beanstalk platform hooks, build/deploy/power scripts
docs/           user guide, architecture, API contract, screenshots
shared/         design tokens and the contrast checker
```

## Limits — read before relying on it

* **Not clinically validated.** Triage colours are decision support.
* **Maps:** OpenStreetMap's public tiles and the public OSRM demo router suit a pilot. For real traffic use a tile provider and an OSRM (or routing) service you run or contract.
* **Locations:** 40 of the 100 network hospitals have only a pincode or district location — the desk's own location fixes that on the map, but verify a hospital before onboarding it.
* **One app server:** GPS trails, desk locations and route caches live in memory; a restart forgets them (desks and phones report again within seconds). Scaling out needs Redis or the database for those.
* **Foreground tracking:** the phone shares GPS while the app is open.

## Sources

Golden hour concept (R. Adams Cowley, University of Maryland Shock Trauma) · [National Hospital Directory, Government of India](https://www.data.gov.in/resource/national-hospital-directory-geo-code-and-additional-parameters-updated-till-last-month) (GODL-India) · [OpenStreetMap](https://www.openstreetmap.org/copyright) and its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) · [OSRM HTTP API](https://project-osrm.org/docs/v5.24.0/api/) · [Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started) · [Leaflet](https://leafletjs.com/) · [Capacitor](https://capacitorjs.com/) · [Socket.IO](https://socket.io/) · [AWS Elastic Beanstalk](https://docs.aws.amazon.com/elasticbeanstalk/) · [Inter](https://rsms.me/inter/) (OFL).

---

Built for Smart India Hackathon 2026. MIT licence.
