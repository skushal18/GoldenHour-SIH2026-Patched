# GoldenHour — SIH 2026

> **Emergency ambulance-to-hospital pre-arrival coordination**

An ambulance crew broadcasts a case once. Hospitals on GoldenHour see it on their ER desk; the first to accept takes the patient; the crew and that hospital then share updates, GPS and arrival. GoldenHour is a hackathon engineering prototype, not a certified clinical product.

## What's new in v6

- **Central hospital sign-in.** One server, one account database. Each hospital has its own username and password, and signing in opens that hospital's ER desk only — its identity comes from the login, never from the URL, a header or the IP address.
- **Super-admin console** (`/admin`). Pick a hospital from the national directory, create its login (a temporary password shown once), reset passwords, disable or enable logins, browse the directory, watch live cases, read the audit log.
- **All-India hospital directory.** 29,844 hospitals from the Government of India's [National Hospital Directory](https://www.data.gov.in/resource/national-hospital-directory-geo-code-and-additional-parameters-updated-till-last-month) (data.gov.in, GODL-India), plus the curated Bengaluru list. See [`data/hospitals/README.md`](data/hospitals/README.md).
- **Redesigned ER board** — minimal cyan + orange frosted glass, a live street map (Leaflet + OpenStreetMap) for en-route ambulances, delay alerts from the crew, nearby hospitals, capacity strip. Sign-in and admin use a calm clinical light theme.
- **Call ahead.** When no GoldenHour hospital is in range (or nobody accepts), the crew sees the nearest directory hospitals with phone numbers.
- **Crew tokens.** Each broadcast returns a secret token; reading, editing, tracking, delaying, cancelling and closing a case all need it, because case codes are sequential.
- **Fixes** — the app's offline case list now matches the server's (they had drifted: "Eclampsia" arrived as "Heat stroke"); delay reports now reach the desk; `DB_PORT` and Railway's `MYSQL_URL` are honoured; the server creates its own tables and never drops any; capacity and the audit trail persist in MySQL; hospital-scope analytics are really hospital-scoped; capacity updates no longer switch diversion off; rate limits can't be dodged with a forged header.

## Run it

```bash
npm run setup                       # backend + app dependencies
npm run demo                        # in-memory server on :5000
```

Logins in `backend/seed/accounts.json` (bcrypt hashes only; the passwords were given to the project owner) are created at startup: `admin` plus ER desks for St John's, Bowring, Victoria and Manipal (Old Airport Road). Without that file, the demo prints fresh sign-ins once. Then open:

| URL | What |
|---|---|
| `http://localhost:5000/hospital` | ER desk — sign in with a hospital login |
| `http://localhost:5000/admin` | Administration — sign in with the admin login |
| `http://localhost:5000/ambulance` | Ambulance app in a browser |
| `http://localhost:5000/health` | Server status |

Set `DEMO_PASSWORD` to fix the demo passwords for a rehearsed demo.

## Deploy (AWS)

Live: **https://d31kwkffv9iv72.cloudfront.net** — `/hospital` (ER desk), `/admin`, `/ambulance`, `/health`.

| Piece | What |
|---|---|
| Server | EC2 `t4g.small` (Amazon Linux 2023, arm64) in ap-southeast-2, instance `i-04a337bf8a7adf656`, Elastic IP `52.64.219.180` |
| App | Node 22, systemd service `goldenhour`, port 8080, code in `/opt/goldenhour` |
| Database | MariaDB on the same server (database `goldenhour`); tables are created by the app |
| HTTPS | CloudFront distribution `EXTEH411I2R7O` (caching off, WebSockets through) — the only thing allowed to reach port 8080 |
| Config | `/etc/goldenhour.env` on the server; the JWT secret and DB password were generated there |
| Deploys | Automatic: every 3 minutes the server pulls `Patch-2` from GitHub and restarts if it changed (`/var/log/goldenhour-deploys.log`) |
| Access | No SSH; use Systems Manager → Session Manager in the AWS console |

So: **push to `Patch-2` → live within ~3 minutes.** The APK reads `app/www/config.js`, which points at the CloudFront address; rebuild it after that changes.

The server runs with `HACKATHON_MODE=true` (every hospital with a login gets every case, wherever the ambulance is), which production mode refuses — so it runs with `NODE_ENV=development` and every other production setting (signed-in desks, strong secret, MySQL, CORS limited to the APK).

## How it fits together

```text
Ambulance app (web / Android APK)
   │  POST /api/v1/requests  → case code + crew token
   ▼
Express + Socket.IO (one Node process)
   ├─ hospital directory (29,844, in memory, radius index)
   ├─ accounts · cases · capacity · audit  (MySQL, or memory for demos)
   └─ alerts every hospital WITH A LOGIN inside the crew's radius
   ▼
ER desks (each signed in as its own hospital) — first to accept wins
```

API overview — ambulance: `GET /case-types`, `POST /requests`, `GET /requests/:code`, `POST /requests/:code/cancel`, `POST /requests/:code/arrived` (the last three need `X-Crew-Token`). Sign-in: `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password`, `POST /auth/logout`. Desk (signed in): `/desk/me`, `/desk/queue`, `/desk/history`, `/desk/accept/:code`, `/desk/decline/:code`, `/desk/arrived/:code`, `/desk/capacity`, `/desk/nearby`, `/desk/track/:code`, `/desk/handover/:code`, `/desk/timeline/:code`, `/desk/analytics`. Admin: `/admin/accounts…`, `/admin/directory…`, `/admin/live`, `/admin/audit`. All under `/api/v1`.

## Tests

```bash
npm test
```

Runs the colour-contrast check, the ambulance app suites (including a jsdom test of the ER desk) and 14 backend suites (sign-in, directory, broadcast race, crew tokens, patient edits, arrival, tracking, capacity, analytics, idempotency, production config gate).

## Limits

- Directory data is the Government's 2017-era list; 17,125 locations are PIN-code centres and 2,857 district centres (both marked ≈ in the UI) and can be kilometres out. Verify a hospital before onboarding it.
- Not clinically validated. Triage colours are decision support, not diagnosis.
- Tracking needs the app open in the foreground; one backend process (GPS trails are in memory).
- OpenStreetMap's public tiles suit a demo; use a tile provider with an agreement for real use.

> **Give the hospital the right information before the patient arrives.**
