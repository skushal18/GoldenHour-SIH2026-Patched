# GoldenHour — SIH 2026

> **Emergency ambulance-to-hospital pre-arrival coordination**

An ambulance crew broadcasts a case once. Hospitals on GoldenHour see it on their ER desk; the first to accept takes the patient; the crew and that hospital then share updates, GPS and arrival. GoldenHour is a hackathon engineering prototype, not a certified clinical product.

## What's new in v7

- **Three tiers on AWS.** Front-ends in a private S3 bucket behind CloudFront; the API and Socket.IO on Elastic Beanstalk (Node.js 22); data in RDS for MySQL 8.4 in private subnets. Secrets in Secrets Manager, logs and alarms in CloudWatch, a monthly budget. All of it is one CloudFormation template, [`infra/goldenhour.yaml`](infra/goldenhour.yaml) — see [`deploy/aws/README.md`](deploy/aws/README.md).
- **Hospitals live in the database.** The `hospitals` table is the GoldenHour network that ambulances are matched against; it starts with 100 emergency hospitals in six cities ([`data/hospitals/network_hospitals.csv`](data/hospitals/network_hospitals.csv), loaded by an idempotent seed). The 29,844-row national CSV stays as the list the administrator adds hospitals from.
- **Each hospital chooses its own login.** The built-in logins are gone (and retired wherever they still existed). The administrator creates logins for every hospital at once with one-time activation codes (hashed, single use, 7-day expiry, downloaded once as a CSV); each hospital activates at `/hospital/#activate` and picks its own username and password.

## What was new in v6

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

The demo server prints fresh sign-ins once at startup: an administrator and ER desks for St John's and Bowring (random passwords; set `DEMO_PASSWORD` to fix them, `DEMO_SEED=false` to skip). There are no built-in logins anywhere else. Then open:

| URL | What |
|---|---|
| `http://localhost:5000/hospital` | ER desk — sign in with a hospital login |
| `http://localhost:5000/hospital/#activate` | First-time activation with a code from the administrator |
| `http://localhost:5000/admin` | Administration — sign in with the admin login |
| `http://localhost:5000/ambulance` | Ambulance app in a browser |
| `http://localhost:5000/health` | Server status |

Set `DEMO_PASSWORD` to fix the demo passwords for a rehearsed demo.

## Deploy (AWS)

Live: **https://d1k7k7ahunvfhc.cloudfront.net** — `/hospital` (ER desk), `/admin`, `/ambulance`, `/health`.

| Tier | What |
|---|---|
| Presentation | S3 `goldenhour-web-109933871250` (private) + CloudFront `ESD4D0YHVEK9M` with Origin Access Control; `/api/*`, `/socket.io/*` and `/health` go to the application tier uncached, WebSockets included |
| Application | Elastic Beanstalk `goldenhour-prod`, Node.js 22 on Amazon Linux 2023, single t4g.micro, managed platform updates, health on `/health`, logs to CloudWatch |
| Data | RDS for MySQL 8.4 `goldenhour-db`, db.t4g.micro, 20 GB gp3, encrypted, private subnets, reachable only from the app |
| Secrets | RDS-managed master password and `goldenhour/app` (JWT secret, first administrator) in Secrets Manager, read at boot with the instance role |
| Watch | `/health` probe every 5 minutes, RDS CPU and storage alarms (email), US$20 monthly budget |

Region ap-southeast-2, account 109933871250, everything tagged `Project=GoldenHour`. Rebuild: `aws cloudformation deploy … infra/goldenhour.yaml` then `infra/scripts/deploy.sh` ([`infra/README.md`](infra/README.md)). Deploys: GitHub Actions on pushes to `Patch-2` (OIDC — waiting on the organisation to allow the OIDC provider) or `infra/scripts/deploy.sh`. Sleep/wake by hand: `infra/scripts/power.sh stop|start`. Resource IDs, costs and operations: [`deploy/aws/README.md`](deploy/aws/README.md).

It **sleeps after 2 idle hours** (instance and database stopped) and wakes on the next request in ~8–10 minutes — the pages say so and reconnect by themselves. Links and the admin / hospital how-to: [`docs/GOLDENHOUR-GUIDE.md`](docs/GOLDENHOUR-GUIDE.md).

The server runs with `NODE_ENV=production`: signed-in desks, strong secret, MySQL only, CORS limited to the APK (`https://localhost`), and `HACKATHON_MODE=false` — a case goes to hospitals with an active login inside the crew's radius.

## How it fits together

```text
Ambulance app (web / Android APK)
   │  POST /api/v1/requests  → case code + crew token
   ▼
Express + Socket.IO (one Node process, Elastic Beanstalk)
   ├─ hospital network (RDS `hospitals` table, cached with a radius index)
   ├─ accounts · cases · capacity · audit  (RDS MySQL, or memory for demos)
   └─ alerts every hospital WITH A LOGIN inside the crew's radius
   ▼
ER desks (each signed in as its own hospital) — first to accept wins
```

API overview — ambulance: `GET /case-types`, `POST /requests`, `GET /requests/:code`, `POST /requests/:code/cancel`, `POST /requests/:code/arrived` (the last three need `X-Crew-Token`). Sign-in: `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password`, `POST /auth/logout`, `POST /auth/activate/lookup`, `POST /auth/activate`. Desk (signed in): `/desk/me`, `/desk/queue`, `/desk/history`, `/desk/accept/:code`, `/desk/decline/:code`, `/desk/arrived/:code`, `/desk/capacity`, `/desk/nearby`, `/desk/track/:code`, `/desk/handover/:code`, `/desk/timeline/:code`, `/desk/analytics`. Admin: `/admin/accounts…` (incl. `activation-codes`, `:id/activation`), `/admin/directory…` (incl. `import`, `:id/enable|disable`), `/admin/catalogue…`, `/admin/live`, `/admin/audit`. All under `/api/v1`.

## Tests

```bash
npm test
```

Runs the colour-contrast check, the ambulance app suites (including a jsdom test of the ER desk) and 16 backend suites (sign-in, activation and bulk logins, hospital directory, broadcast race, crew tokens, patient edits, arrival, tracking, capacity, analytics, idempotency, production config gate). With `TEST_MYSQL_URL=mysql://user:pass@host/<db named *test*>` the directory, seed, migration and activation suite also runs against a real MySQL (CI uses MySQL 8.4). `backend/scripts/e2e-aws.js` checks a deployed stack end to end.

## Limits

- Directory data is the Government's 2017-era list; 17,125 locations are PIN-code centres and 2,857 district centres (both marked ≈ in the UI) and can be kilometres out. Verify a hospital before onboarding it.
- Not clinically validated. Triage colours are decision support, not diagnosis.
- Tracking needs the app open in the foreground; one backend process (GPS trails are in memory).
- OpenStreetMap's public tiles suit a demo; use a tile provider with an agreement for real use.

> **Give the hospital the right information before the patient arrives.**
