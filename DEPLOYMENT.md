# Deployment

Three ways to run GoldenHour, in the order you will need them.

| | what it is | guide |
|---|---|---|
| **1** | The hackathon: one laptop serving two ER boards on a closed Wi-Fi | [QUICKSTART.md](QUICKSTART.md) |
| **2** | A developer machine with the real MySQL schema | [§2 below](#2--local-development-with-mysql) |
| **3** | A real server other people depend on | [§3 below](#3--production) |

> The PDFs in `docs/` came from the original backend repository and describe
> its old layout — `.env` in the repo root, `API_BASE` on line 15 of
> `www/app.js`, a three-laptop demo with no hospital board. None of that is
> true any more. **This file is the current one.** The PDFs are kept as
> project history, not as instructions.

---

## What changes between a demo and a deployment

Worth reading before you start, because most of it is one line each:

| | hackathon | production |
|---|---|---|
| `HACKATHON_MODE` (`config/hospitals.config.js`) | `true` — every broadcast alerts both laptops | `false` — Haversine radius matching |
| Hospitals | two hardcoded laptop IPs | rows in the `hospitals` table |
| ER desk identity | the laptop's IP address | a signed JWT (`DESK_AUTH=jwt`) |
| `DB_DRIVER` | `auto` (falls back to memory) | `mysql` (refuse to start without it) |
| `CORS_ORIGIN` | empty — any origin | your exact front-end origins |
| `JWT_SECRET` | the committed default | 48 random bytes |
| Seeded accounts | password `admin123` | deleted or rotated |
| Transport | plain http on a LAN | HTTPS behind a reverse proxy |
| Process | a terminal window | systemd or pm2 |

The server prints its own posture on startup, so you can always see which one
you are running:

```
  Hackathon mode          :  ON — every broadcast alerts BOTH laptops
  ER desk auth            :  by laptop IP — LAN only, no login
  CORS                    :  any origin (*)
```

---

## 1 · Prerequisites

| software | version | notes |
|---|---|---|
| Node.js | 20 LTS or newer | the CI builds on 22 |
| npm | ships with Node | |
| MySQL | 8.0+ | only for §2 and §3 — `npm run demo` needs no database |
| Git | any | |

---

## 2 · Local development with MySQL

### Step 1 — Get the code

```bash
git clone <your-repo-url> goldenhour-master
cd goldenhour-master
```

### Step 2 — Install both workspaces

```bash
npm run setup
```

That runs `npm install` in `backend/` and in `app/`. It does not touch the
Android project.

### Step 3 — Create the database

Open `backend/database/schema.sql` in MySQL Workbench (or pipe it to the
client) and run the whole file:

```bash
mysql -u root -p < backend/database/schema.sql
```

It drops and recreates the `goldenhour` database, creates all 15 tables, and
seeds four hospitals, two ambulances and four user accounts.

> **The seeded accounts all have the password `admin123`.** Convenient on a
> laptop, unacceptable anywhere else — see [§3 step 7](#step-7--close-the-doors).

### Step 4 — Configure the backend

```bash
cd backend
cp .env.example .env
```

Edit `.env`: set `DB_PASSWORD`, and change `DB_DRIVER` to `mysql` so a
connection failure is loud rather than silently falling back to the in-memory
store.

### Step 5 — Start it

```bash
npm run dev          # from backend/, with auto-restart
# or
npm start            # from the repo root
```

Expected output:

```
🗃️  Store: MySQL
──────────────────────────────────────────────────────────────────
  🚑  GoldenHour  ·  master server
──────────────────────────────────────────────────────────────────
  Listening on            :  0.0.0.0:5000
  ...
```

If you see `⚠️ MySQL is not reachable` and it carries on anyway, `DB_DRIVER`
is still `auto`.

### Step 6 — Verify

```bash
curl http://localhost:5000/health
```

```json
{ "success": true, "message": "GoldenHour backend running", "hackathon_mode": true, ... }
```

Then open `http://localhost:5000/` — the landing page links to the ER board
and the ambulance app.

### Step 7 — Run the tests

```bash
npm test             # from the repo root: 262 checks
```

---

## 3 · Production

This section assumes a small Linux VM (any provider) with a domain pointing at
it. If you would rather use a platform-as-a-service, skip to
[§4](#4--platform-as-a-service).

### Step 1 — Server and user

```bash
sudo adduser --system --group --home /opt/goldenhour goldenhour
sudo apt update && sudo apt install -y nodejs npm mysql-server nginx
```

Check `node --version` is 20 or newer; if your distro ships something older,
install from NodeSource rather than fighting it.

### Step 2 — Database

```bash
sudo mysql_secure_installation

sudo mysql -e "CREATE DATABASE goldenhour CHARACTER SET utf8mb4;"
sudo mysql -e "CREATE USER 'goldenhour'@'localhost' IDENTIFIED BY 'a-long-random-password';"
sudo mysql -e "GRANT SELECT, INSERT, UPDATE, DELETE ON goldenhour.* TO 'goldenhour'@'localhost';"
sudo mysql -e "FLUSH PRIVILEGES;"
```

The application never needs DDL at runtime, so do not grant it. Load the
schema as an administrator instead:

```bash
sudo mysql goldenhour < backend/database/schema.sql
```

> `schema.sql` begins with `DROP DATABASE IF EXISTS goldenhour`. It is written
> for first-time setup. **Never run it against a database with real cases in
> it** — it will delete them. For changes after go-live, write migrations.

### Step 3 — Deploy the code

```bash
sudo -u goldenhour git clone <your-repo-url> /opt/goldenhour/app
cd /opt/goldenhour/app
sudo -u goldenhour npm --prefix backend ci --omit=dev
```

The ambulance app is plain static files served by the backend, so `app/` needs
no install unless you are running its tests or building the APK.

### Step 4 — Configure

```bash
sudo -u goldenhour cp backend/.env.example backend/.env
sudo -u goldenhour chmod 600 backend/.env
```

```ini
PORT=5000
DB_DRIVER=mysql
DB_HOST=localhost
DB_USER=goldenhour
DB_PASSWORD=a-long-random-password
DB_NAME=goldenhour
DB_PORT=3306

JWT_SECRET=<48 random bytes — see below>
DESK_AUTH=jwt
CORS_ORIGIN=https://goldenhour.example.org
```

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then turn off the hackathon wiring in `config/hospitals.config.js`:

```js
const HACKATHON_MODE = false;              // radius matching goes live
const ALLOW_MANUAL_HOSPITAL_OVERRIDE = false;   // ?hospital=1 stops working
```

and register the real hospitals:

```sql
INSERT INTO hospitals (name, address, latitude, longitude, contact) VALUES
  ('Real Hospital A', '...', 12.9716, 77.5946, '+91...'),
  ('Real Hospital B', '...', 12.9121, 77.5956, '+91...');
```

Coordinates matter — they are what the Haversine radius match runs on. A
hospital with `NULL` latitude is silently never alerted.

### Step 5 — Run it as a service

`/etc/systemd/system/goldenhour.service`:

```ini
[Unit]
Description=GoldenHour pre-arrival alert server
After=network.target mysql.service

[Service]
Type=simple
User=goldenhour
WorkingDirectory=/opt/goldenhour/app/backend
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# The process needs no write access to anything
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now goldenhour
sudo systemctl status goldenhour
journalctl -u goldenhour -f
```

### Step 6 — HTTPS, and the WebSocket trap

Socket.IO needs the connection upgrade headers proxied. Leave them out and
everything still *works* — it silently falls back to HTTP long-polling, and
your instant board becomes a laggy one. This is the single most common way to
deploy this app badly.

`/etc/nginx/sites-available/goldenhour`:

```nginx
server {
    listen 80;
    server_name goldenhour.example.org;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name goldenhour.example.org;

    # certbot fills these in
    ssl_certificate     /etc/letsencrypt/live/goldenhour.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/goldenhour.example.org/privkey.pem;

    # photos: four compressed JPEGs as data-URLs
    client_max_body_size 15M;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;

        # ── these four lines are what keep Socket.IO on a real socket ──
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/goldenhour /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d goldenhour.example.org
```

HTTPS is not optional here for a second reason: **Chrome only grants
geolocation on secure origins**, so the ambulance app served over plain http
cannot get a GPS fix at all. See [§6](#6--the-ambulance-app-and-the-apk).

The app already sets `trust proxy`, so `X-Forwarded-For` is what the server
reads as the client address.

### Step 7 — Close the doors

Nothing below is optional, and none of it is done for you.

**Delete or rotate the seeded accounts.** `schema.sql` seeds four users whose
password is `admin123`, published in this repository.

```sql
DELETE FROM users WHERE email LIKE '%@goldenhour.com';
```

Then create real ones through `POST /api/v1/auth/register` (it hashes with
bcrypt), or insert rows with a hash you generate:

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1],12))" 'the-real-password'
```

**Confirm `DESK_AUTH=jwt` took effect.** The startup banner must say
`ER desk auth : JWT (production)`. Verify from outside:

```bash
curl -i https://goldenhour.example.org/api/v1/desk/queue     # expect 401
```

If that returns a case list, the ER board is world-readable and so is every
patient on it.

**Firewall.** Only 80, 443 and SSH. Port 5000 should not be reachable from
outside the machine:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

**Back up the database.** `mysqldump` on a schedule, restored somewhere at
least once so you know the restore works.

### Step 8 — Give the ER boards their tokens

With `DESK_AUTH=jwt` a board authenticates with a token rather than by being
on the right IP. There is no login screen — this is a wall display, not an
app — so hand it the token once:

```bash
curl -s -X POST https://goldenhour.example.org/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"desk-a@yourhospital.org","password":"..."}'
```

Open the board with the token in the URL:

```
https://goldenhour.example.org/hospital?token=eyJhbGciOi...
```

The page stores it in `localStorage`, strips it from the address bar, and
sends it on every call and on the socket handshake from then on. The account's
`hospital_id` decides which board it is — a hospital-1 token opening
`?hospital=2` still gets hospital 1.

Tokens expire after 24 hours by default (`authController.js`). For a display
that should stay up for weeks, either issue a long-lived token for a dedicated
desk account or put a small refresh in front of it.

### Step 9 — Verify the whole path

```bash
curl https://goldenhour.example.org/health
curl -i https://goldenhour.example.org/api/v1/desk/queue          # 401
curl -i -H "Authorization: Bearer $TOKEN" \
     https://goldenhour.example.org/api/v1/desk/queue             # 200
```

Then do it for real: open the board on two machines with two different desk
tokens, broadcast from the ambulance app, and confirm the case lands on both
and clears from one when the other accepts. That end-to-end check is the only
one that proves the WebSocket upgrade is working.

---

## 4 · Platform-as-a-service

Railway, Render, Fly and similar work, with three things to get right.

1. **Root directory / start command.** The service lives in `backend/`, but it
   reads `config/hospitals.config.js` from the repository root and serves
   `app/www` as static files. Deploy the **whole repository**, and set the
   start command to `npm --prefix backend start` (or root directory `/` with
   `npm run setup && npm start`). Pointing the platform at `backend/` alone
   will fail at startup.
2. **WebSockets.** Confirm your platform proxies them. Most do; a few need it
   enabled. Without it the boards degrade to 5-second polling.
3. **Environment variables.** Set every variable from `.env.example` in the
   platform's own settings — do not commit `.env`. Managed MySQL add-ons
   usually inject their own host/user/password names, so map them across.

Load the schema by connecting to the managed database with a client and
running `backend/database/schema.sql` once.

---

## 5 · Upgrading a running deployment

```bash
cd /opt/goldenhour/app
sudo -u goldenhour git pull
sudo -u goldenhour npm --prefix backend ci --omit=dev
sudo systemctl restart goldenhour
```

There is no migration runner. `schema.sql` is create-from-scratch only, so
schema changes after go-live need hand-written `ALTER TABLE` statements
applied before the restart.

An in-flight broadcast does not survive a restart if you are on the in-memory
store; with MySQL it does, and the boards reconnect and re-sync themselves
from `broadcast:snapshot`.

---

## 6 · The ambulance app and the APK

The app finds the backend in one of two ways:

- **Served by the backend** (`https://your-server/ambulance`) — it uses the
  page's own origin. Nothing to configure.
- **Inside the APK** — there is no page origin to infer, so set it explicitly:

```js
// app/www/config.js
SERVER_BASE: "https://goldenhour.example.org"
```

or pass it to the **Build GoldenHour APK** workflow, which writes that line
for you before building. See the README for the full APK story.

Two things that bite:

**HTTPS is required for GPS in a browser.** Chrome grants geolocation only on
secure origins, so `http://a.b.c.d:5000/ambulance` cannot get a fix. The app
detects this, explains it, and offers a manual starting point — but on a real
deployment just use HTTPS. The APK is unaffected either way.

**Update `FALLBACK_ORIGIN`** in `app/www/config.js` to your own city, so the
one-tap fallback puts the ambulance somewhere plausible rather than in
Bengaluru.

---

## 7 · Troubleshooting

**`❌ MySQL required (DB_DRIVER=mysql) but unreachable`** — credentials or the
database name are wrong, or MySQL is not running. `journalctl -u mysql`.

**Server starts but warns it fell back to memory** — `DB_DRIVER` is `auto`.
Set it to `mysql` in production so this is a hard failure.

**Boards say "Polling only" or reconnect in a loop** — the reverse proxy is
not passing the WebSocket upgrade. Re-check the four `proxy_set_header` lines
in [step 6](#step-6--https-and-the-websocket-trap).

**Boards say "Not signed in"** — `DESK_AUTH=jwt` and the browser has no token.
Open `/hospital?token=…` once.

**A broadcast reaches nobody** — with `HACKATHON_MODE=false`, no hospital was
inside the radius. Check the `hospitals` table has real latitude/longitude,
and widen the radius. The server logs the target list for every broadcast:

```
📡 GH-2026-0001 RED "Stroke …" → #1 Real Hospital A + #2 Real Hospital B
```

An empty right-hand side is the symptom.

**413 on broadcast** — `client_max_body_size` in nginx is smaller than the
photo payload. It needs at least 15M.

**Both boards think they are the same hospital** — you are still in IP mode
with an unrecognised IP. In production this should be `DESK_AUTH=jwt`, where
it cannot happen.
