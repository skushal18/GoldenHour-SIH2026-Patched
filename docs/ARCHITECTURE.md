# Architecture

How GoldenHour v7 fits together: how an ER desk knows which hospital it is,
which hospitals a case reaches, how exactly one of them wins it, where the data
lives, and how the two front-ends are built. [`../README.md`](../README.md)
("What's new in v7") is the summary; this is the detail. Paths are relative to
the repository root.

---

## Where the pieces came from

| origin | what it contributed |
|---|---|
| `skushal18/GoldenHour-APP` | the ambulance app (`app/`): HTML/CSS/JS wrapped by Capacitor, its test suite and the APK workflow |
| `Lakshitha08-lks/goldenhour-backend` | the backend (`backend/`): Express, a MySQL schema, auth/case/hospital controllers, Socket.IO scaffolding |
| this repo, up to v5 | the ER desk board, the broadcast subsystem, the in-memory fallback store, the end-to-end race test, crew tracking, capacity and the audit trail |
| v6 | central hospital sign-in (JWT), the super-admin console, the all-India hospital directory, crew tokens, the redesigned desk |
| v7 | the three-tier AWS stack, the network in the MySQL `hospitals` table, logins activated with one-time codes |

Most of the original backend has since been replaced. v6 removed the original
auth, case and hospital controllers, the `/api/v1/cases` and
`/api/v1/hospitals` routes and the original relational case tables, and
rewrote `/api/v1/auth` as the central sign-in. The API now has four routers
under `/api/v1` (`authRoutes`, `adminRoutes`, `hospitalDeskRoutes`,
`requestRoutes` in `backend/src/routes/`); the README lists every endpoint.

---

## The request lifecycle

```
   AMBULANCE APP                  SERVER                             ER DESKS (signed in)
   ─────────────                  ──────                             ────────────────────
   Broadcast Request
        │  POST /api/v1/requests
        ├────────────────────────►  validateBroadcast(body)
        │                           computePriority(vitals)
        │                           resolveTargets(origin, radius)
        │                             hospitals with an ACTIVE login
        │                             (getAccounts().activeHospitalIds())
        │                             HACKATHON_MODE=true → all of them
        │                             otherwise          → Haversine ≤ radius
        │                           callAheadOptions()
        │                             nearest directory hospitals with
        │                             NO login, with phone numbers
        │                           store.insertBroadcast()
        │                             1 broadcast + 1 target row each
        │  201 {id, crew_token, hospitals_notified, call_ahead}
        ◄────────────────────────┤
        │                           io.to('hospital_<id>').emit('broadcast:new')
        │                           ─────────────────────────────────►  card on every
        │                                                               targeted desk
        │  socket 'case:follow' {case_code, crew_token}
        ├────────────────────────►
        │                                                    Accept pressed on ONE
        │                           ◄─────────────────────────────────
        │                           POST /api/v1/desk/accept/:code  (Bearer token)
        │                           store.claim()  ← atomic, one winner
        │                           io.to(each target).emit('broadcast:claimed')
        │                           ─────────────────────────────────►  winner keeps it,
        │                                                               other cards leave
        │  socket 'case:status'
        ◄────────────────────────┤
   ✓ Accepted by …
```

`resolveTargets` and `callAheadOptions` are in
`backend/src/services/broadcastService.js`. The targets are hospitals that can
actually answer: an `ACTIVE` `HOSPITAL_STAFF` login, looked up in the network
directory. The call-ahead list goes to the crew in the 201 and in every status
read until a hospital accepts. It holds up to five emergency hospitals within
the radius (at least 10 km) that are not on GoldenHour and have a phone number.

`HACKATHON_MODE` is on unless it is set to `false`
(`config/hospitals.config.js`), so a local demo reaches every signed-in
hospital wherever the venue is. Production refuses to start with it on, and
the deployed stack sets it to `false`.

Some timings:

* A case stays open for `ACCEPT_WINDOW_SECONDS` (default 180). The expiry
  loop runs every 10 s.
* A case with no target expires immediately, so the crew sees the call-ahead
  list within one expiry tick instead of waiting three minutes on a case no
  desk can see.
* If every target declines, the case ends as `REJECTED` and the crew is told
  at once.

Polling runs underneath the whole picture. The app polls
`GET /requests/:code` with its `X-Crew-Token`, and each desk polls
`GET /desk/queue` every 10 s. If Socket.IO never connects, everything still
works at poll speed.

---

## Desk identity: every hospital signs in

Since v6 a desk is whichever hospital its login belongs to. Nothing the browser
can change (URL, header, IP address) can change that.
`deskAuthMode()` in `backend/src/config/security.js` returns `jwt` unless
`DESK_AUTH=ip` is set by name. Any other value, or none, means `jwt`.

**Tokens** (`backend/src/services/authService.js`). `POST /auth/login` checks a
bcrypt hash and issues an HS256 JWT naming the account (`sub`), its `role`,
its `hospital_id` and its `token_version` (`tv`), valid for `JWT_TTL`
(default `12h`). `verify()` runs on **every** request, not just at sign-in. It
checks the signature, loads the account, and compares `token_version` and
`status`. Disabling a login, resetting its password, changing the password or
signing out everywhere bumps the version, so old tokens fail on their next
request instead of when they expire. Five wrong passwords lock a login for
15 minutes. "No such user" and "wrong password" get the same answer and take
the same time.

**HTTP** (`backend/src/middleware/auth.js`, `backend/src/middleware/hospitalIdentity.js`).
`requireAuth(roles)` verifies the bearer token and refuses an account that
still has to change a temporary password. `deskGuard`, mounted on every
`/api/v1/desk/*` route, is `requireAuth(['HOSPITAL_STAFF'])` followed by
`auth.hospitalFor(account)`. That puts the hospital on `req.hospital` with
`matched_by: 'account'`. A `SUPER_ADMIN` login is not an ER desk, and the
admin API (`/api/v1/admin/*`) takes `SUPER_ADMIN` only.

**Socket** (`backend/src/sockets/socketHandler.js`). A desk connects with
`query.role = 'hospital'` and its token in `auth.token`. `resolveDeskIdentity`
runs the same checks: token, `HOSPITAL_STAFF`, password changed, linked to a
hospital. Only then does it join `hospital_<id>` and the shared `desks` room.
Otherwise the server sends `hospital:rejected` and disconnects. A desk that
could not read `/desk/queue` but could still join a room would receive every
incoming case anyway, through a side door. That is why the v4
`join_hospital`, `join_case` and `location_update` events are gone. Crew
events (`case:follow`, `ambulance:position`, `ambulance:delayed`,
`patient:update`, `ambulance:arrived`) each need the case's crew token,
because case codes are sequential.

**Who is hospital #N?** `hospitalFor()` asks
`backend/src/services/directoryService.js`, which reads the MySQL `hospitals`
table into an in-memory index at boot (see [the store](#the-store-abstraction)).
The desk page (`backend/public/hospital/main.js`) asks `GET /auth/me` and
opens whatever the server names: a hospital login gets that hospital's board,
an administrator gets the console.

### Getting a login

There are no built-in logins. The administrator gives each hospital its own,
in one of two ways:

* **Activation code** (v7, the normal path). "Create logins for all
  hospitals" (`POST /admin/accounts/activation-codes`) makes a `PENDING`
  login for every active network hospital that has none. Each gets a
  16-symbol Crockford base32 code (80 random bits), shown once and downloaded
  as a CSV. Only the code's SHA-256 is stored (`accounts.activation_code_hash`,
  unique), and it expires after `ACTIVATION_DAYS` (default 7). The hospital
  opens `/hospital/#activate`, sees which hospital the code is for
  (`POST /auth/activate/lookup`), and chooses its own username and password
  (`POST /auth/activate`). The activation is an `UPDATE … WHERE
  status='PENDING' AND activation_code_hash=?`, so a code works once even
  when two people race it. `POST /admin/accounts/:id/activation` issues a
  fresh code and puts the login back to `PENDING`.
* **Temporary password** (`POST /admin/accounts`). It is shown once and must
  be changed at first sign-in. Until then the desk API answers
  `PASSWORD_CHANGE_REQUIRED`.

On first boot, `SUPER_ADMIN_USERNAME` and `SUPER_ADMIN_PASSWORD` create the
administrator. Outside production, an empty store also gets demo sign-ins:
`admin` plus desks for St John's (directory id 12179) and Bowring (12815).
Their random passwords are printed once. `DEMO_PASSWORD` fixes them and
`DEMO_SEED=false` skips them. Any login left over from the pre-v7 seed file
is retired at boot: disabled, password replaced, tokens voided.

### LAN rehearsal mode (`DESK_AUTH=ip`)

This is the pre-v6 identity, kept for closed-LAN rehearsals and for the race
tests. Production refuses it. `config/hospitals.config.js` (re-exported by
`backend/src/config/hospitals.js`) names two fictional demo desks, City
Emergency Hospital (#1) and Apollo Hospital (#2):

```js
resolveHospital(ip, override)
  1. override — ?hospital=<id> or X-Hospital-Id (HTTP), query.hospital or
     'hospital:identify' (socket) — if ALLOW_MANUAL_HOSPITAL_OVERRIDE (default on)
  2. the IP, but only if exactly one desk has it
  3. otherwise desk #1, flagged 'fallback' (or 'ambiguous-ip')
```

`normaliseIp` strips the `::ffff:` IPv4-mapped prefix. Both demo desks ship
with `127.0.0.1` (two browser windows on one laptop is how rehearsals run),
so by default the IP is ambiguous and the override decides. In this mode
`resolveTargets` alerts those two desks instead of signed-in hospitals.
`/desk/laptops` answers only in this mode, and with `HACKATHON_MODE` on,
`/health` lists the desks. The v6 desk page always opens on the sign-in form,
so the mode is reached through the API and the socket. That is how
`backend/tests/broadcast.e2e.test.js` and `broadcast.smoke.js` use it.

---

## Two security postures

`DESK_AUTH` picks which. The startup banner and `/health` (`desk_auth`) say
which one is live.

| | `jwt` (default) | `ip` (asked for by name) |
|---|---|---|
| Who is this desk? | `hospital_id` of the signed-in account, from the `hospitals` table | `?hospital=` / `X-Hospital-Id`, else the IP, matched against `config/hospitals.config.js` |
| `?hospital=2` | ignored | changes identity (that is the point) |
| HTTP | `requireAuth(['HOSPITAL_STAFF'])` on every `/desk/*` route | open |
| Socket | no valid desk token → `hospital:rejected` and disconnected | joins its room on connect |
| Who gets a case | hospitals with an active login (in the radius, or all with `HACKATHON_MODE`) | the two demo desks |
| Production | required | refused at boot |
| Correct for | anything reachable from elsewhere, including the deployed stack | a closed rehearsal LAN, and the race tests |

With `NODE_ENV=production`, `security.enforce()` refuses to start (exit 78)
unless all of these hold:

* `DESK_AUTH` is not `ip`.
* `JWT_SECRET` is set, at least 32 characters and not a value published in
  the repo.
* `CORS_ORIGIN` names explicit origins: not unset, not `*`.
* `DB_DRIVER=mysql`.
* `HACKATHON_MODE=false`.

Leaving `ALLOW_MANUAL_HOSPITAL_OVERRIDE` on is only a warning: it is ignored
under `jwt`, but should be `false` so a later change to `DESK_AUTH` cannot
reopen `?hospital=`. The CI job `production-config` proves both directions.
`infra/goldenhour.yaml` deploys with `DESK_AUTH=jwt`, `HACKATHON_MODE=false`
and `ALLOW_MANUAL_HOSPITAL_OVERRIDE=false`.

---

## First-accept-wins

This is the only piece of concurrency in the system, so it is worth being
precise about.

**MySQL** (`backend/src/store/mysqlStore.js`, `claim()`):

```sql
BEGIN;
SELECT * FROM broadcast_targets
 WHERE case_code = ? AND hospital_id = ? FOR UPDATE;
-- no row → NOT_TARGETED (case exists) or NOT_FOUND; commit and return

UPDATE broadcasts
   SET status = 'ACCEPTED', accepted_hospital_id = ?, accepted_at = NOW()
 WHERE case_code = ? AND status = 'PENDING';       -- ← the race is decided here

-- affectedRows = 0 → re-read the status: ALREADY_ACCEPTED (or CANCELLED,
-- EXPIRED, REJECTED); commit and return it
UPDATE broadcast_targets
   SET status = CASE WHEN hospital_id = ? THEN 'ACCEPTED' ELSE 'CANCELLED' END
 WHERE case_code = ?;
COMMIT;
```

The `WHERE status = 'PENDING'` clause is the lock. Whichever transaction
reaches it second sees zero affected rows and gets `ALREADY_ACCEPTED`. The
desk route answers 409 with the winner's name and id, so the losing board can
say something useful. A hospital the case was never offered to also gets a
409 (`NOT_TARGETED`).

**In-memory** (`backend/src/store/memoryStore.js`): the same check-and-set,
written synchronously. Node does not interleave it, so the guarantee holds
without a mutex.

`backend/tests/broadcast.e2e.test.js` fires both accepts with `Promise.all`
and asserts exactly one 200 and one 409. It runs against the memory driver;
no suite yet races `claim()` on MySQL. `backend/tests/directory.mysql.test.js`
does race the same kind of guarded `UPDATE`, two activations of one code, on
a real MySQL 8.4.

---

## The store abstraction

`backend/src/store/index.js` picks a driver once at boot and hands out two
stores: the case store (`getStore()`) and the account store (`getAccounts()`,
`backend/src/store/accountStore.js`). Both always use the same driver, so a
deployment is either wholly persistent or wholly in memory, never half and
half.

| `DB_DRIVER` | behaviour |
|---|---|
| `auto` (default) | try MySQL; on failure warn loudly and use memory |
| `mysql` | require MySQL, exit if unreachable (`DB_WAIT_SECONDS` keeps retrying first) |
| `memory` | never touch MySQL (`npm run demo`, `--memory`) |

Production refuses anything but `mysql`.

Both case-store drivers implement the same fourteen methods, so nothing above
the store knows which one is running:

* `init`, `ping`
* `nextCaseCode`, `insertBroadcast`, `getBroadcast`, `listForHospital`, `listAll`
* `claim`, `decline`, `cancel`, `expireOverdue`
* `updatePatientFields`, `appendHistory`, `markArrived`

The memory driver adds `reset()` for tests.

Around the case store:

* **Hospital network.** `directoryService` is the source of truth for "who is
  hospital #N" and "who is near here". Under MySQL it reads the `hospitals`
  table into `hospitalIndex`, an id map plus a ~11 km grid for radius queries.
  Every change goes to the table first and the index second, so matching a
  broadcast never needs a database round trip. Under memory it loads the same
  100 hospitals from `data/hospitals/network_hospitals.csv`. The 29,844-row
  all-India catalogue (`catalogueService`, `data/hospitals/india_hospitals.csv`)
  is what the administrator imports more hospitals from. Ambulances are never
  matched against it directly.
* **Seeding the network.** `npm --prefix backend run seed:hospitals` (or
  `HOSPITAL_SEED_ON_BOOT=true`) loads the 100 hospitals with `INSERT IGNORE`.
  Re-running it changes nothing, including a hospital the administrator has
  switched off.
* **Write-through to MySQL.** Capacity (`capacityService` →
  `hospital_capacity`) and the audit trail (`auditService` → `case_events`)
  are written through and restored at boot.
* **Per process, even on MySQL.** GPS trails (`trackingService`), the
  `client_request_id` idempotency map and rate-limit counters are not stored.
  This is one of the reasons the deployment is a single process.

### Tables

`backend/src/store/migrate.js` is the schema. `ensureSchema()` runs at every
boot. It creates missing tables, adds missing columns and indexes, and widens
changed columns in place (v7 made `accounts.username` and `password_hash`
nullable and added `PENDING`). It never drops or rewrites anything.

```sql
accounts            account_id PK, username UNIQUE NULL, password_hash NULL,
                    role (SUPER_ADMIN | HOSPITAL_STAFF), hospital_id,
                    status (PENDING | ACTIVE | DISABLED), must_change_password,
                    failed_attempts, locked_until, token_version, last_login_at,
                    activation_code_hash UNIQUE, activation_expires_at, activated_at
hospitals           id PK (directory id), name, state, district, pincode, address,
                    phone, ownership, care_type, specialties, beds,
                    emergency_likely, lat, lng, coord_source, active
broadcasts          case_code PK, status, priority, payload JSON,
                    accepted_hospital_id, accepted_at, arrived_at, expires_at,
                    legacy_case_id (unused since v6)
broadcast_targets   case_code + hospital_id UNIQUE, hospital snapshot
                    (name, contact, lat, lng), distance_km, status
hospital_capacity   hospital_id PK, resus bays, ventilators, CT / OT / blood /
                    cath lab availability, diversion_active, updated_at
case_events         event_id PK, case_code, event_type, event_data JSON,
                    actor, performed_at   (append-only audit trail)
```

The full case is stored as JSON rather than spread across a dozen tables. The
ER board wants the whole snapshot at once, and the queries that need columns
(status, who accepted, when it expires, who it was offered to) have them.

`npm --prefix backend run schema` prints the same definitions as SQL.
`backend/database/schema.sql` is a copy of that output, last generated for v6
(no `hospitals` table, no activation columns). Regenerate it rather than
trusting the committed copy.

---

## Front-ends

The backend serves both front-ends from the same origin
(`backend/src/server.js`):

* `/ambulance` → `app/www`
* `/hospital` and `/admin` → `backend/public/hospital`, one page that shows
  whichever screen the signed-in account may use
* `/` → `backend/public/landing`
* `/vendor` → the vendored Socket.IO client and Leaflet

On AWS the same files sit in S3 behind CloudFront. `infra/scripts/build.sh`
stages them, and `infra/scripts/deploy.sh` syncs them to the bucket.

**Ambulance app.** Source in `app/src`, built with Vite (`app/vite.config.js`)
into `app/www`, which is committed. The source is `app/src/index.html`,
`app/src/main.js` (the wiring), `app/src/modules/*.js` (the logic) and
`app/src/styles.css`. The build writes `app/www/index.html`, `app/www/app.js`
and `app/www/style.css`. Build with `npm --prefix app run build` (or
`npm run build` at the root).

* The bundle is a classic IIFE, not minified, with
  `preserveEntrySignatures: 'strict'`. That way it runs as a plain `<script>`
  in the Android WebView, and `app/tests/test.js` can `require()` it to test
  the pure logic without a DOM.
* These files in `app/www` are maintained by hand, not generated:
  * `config.js` holds the server URL and mode, and the APK workflow rewrites
    it. Opened from the backend, the app finds its server by itself.
  * `ui.js` is the presentation layer: tab lens, theme choice, "Lighter
    visuals".
  * `theme-boot.js` sets the theme and visual tier before first paint.
  * `fonts/` holds Inter.
  * `app/www/vendor/socket.io.min.js`, which the server also serves to the
    desk at `/vendor`.

  `emptyOutDir: false` keeps them.
* `npm --prefix app test` builds first (`pretest`). The CI job `built-output`
  rebuilds and fails if the committed `app/www` differs, because committed
  output goes stale silently. `npm run apk` builds, runs `cap sync` and runs
  Gradle.
* Over Socket.IO the app follows its case with the crew token
  (`case:follow`), so acceptance is pushed rather than waiting for the next
  poll. The poll stays as the fallback. Broadcasts go through an offline
  outbox (`app/src/modules/outbox.js`) with a `client_request_id`, so a
  retried POST never puts the same patient on two boards.

**ER desk and admin console** (`backend/public/hospital/`). Hand-written, no
build step:

* `index.html` and `config.js`.
* `common.js`: the API and session helpers.
* `main.js`: sign-in, activation, password change, and routing by role.
* `board.js`: the ER board.
* `admin.js`: the console.
* `desk.css`.

Nothing shows before `/auth/me` confirms who is signed in. The board connects
its socket with the token, then:

* **Rendering is keyed.** Each case card is created once and updated in place,
  so an en-route card's Leaflet map survives every repaint instead of being
  rebuilt on each vital or GPS fix.
* **A case another hospital claims** is animated out before the board
  repaints.

---

## Getting a position at all

The ambulance app needs coordinates or no hospital can be matched. There are
four sources, in descending order of trust. The payload always says which one
it was, and the server accepts exactly these four (`ORIGIN_SOURCES` in
`backend/src/services/validation.js`):

| `origin.source` | where it came from | `accuracy_m` |
|---|---|---|
| `gps` | the device measured it | the real figure |
| `last-known` | the device measured it earlier this shift (≤ 20 min, from `localStorage` key `gh_last_fix`) | `null` (the recall chip does not carry the old figure forward) |
| `manual` | a preset tap or typed coordinates | `null`: nothing was measured |
| `demo` | demo mode's fixed Bengaluru point; demo mode never asks for a location | `null` |

This exists because of one specific trap. Chrome grants geolocation only on
secure origins, and `http://192.168.1.100:5000` is not one: `localhost` gets
an exemption that a private IP does not. So the app opened in a phone browser
from the laptop's LAN address has GPS refused outright:

```
http://127.0.0.1:5301   isSecureContext: true   → "Location locked"
http://192.0.2.2:5301   isSecureContext: false  → "Only secure origins are allowed"
```

The APK is unaffected. Capacitor's WebView is a secure context, and the
native Geolocation plugin does not go through the browser API. Any HTTPS
origin, including the CloudFront deployment, is unaffected too. But the plain-http LAN
route is the one people reach for five minutes before a demo, and a form that
silently will not send is the worst possible failure there. So the app
explains the cause, offers the fallbacks (the last fix, a preset, typed
coordinates), and lets the broadcast go.

`accuracy_m` is never invented for a position that was not measured just
now. The server rejects `0,0` and null coordinates. For any source but `gps`,
the ER board shows a chip on the card: **"Position set by hand — distance is
an estimate"** for `manual`, and the source's name otherwise. A distance
computed from a typed point should not be read the same way as a measured one.

`app/tests/location.test.js` covers the fallback. That includes not offering
a fix from the day before: `LAST_FIX_MAX_AGE_MS` in `app/src/modules/geo.js`
is 20 minutes, because a recalled fix older than that could be in a different
part of the city.

---

## Design system

The palette lives in `shared/design/tokens.css`: cyan for navigation and
selection, orange for action, light and dark sets.
`shared/design/contrast.check.js` verifies its text and border pairs against
WCAG 2.1 (76 pairs, light and dark) and is the first step of `npm test`.

| token | light | job |
|---|---|---|
| `--brand-fill` (cyan) | `#22C6DE` | brand, selection, focus, "this desk", "we claimed it" |
| `--accent-fill` (orange) | `#F58A28` | one job only: the button that acts, such as Broadcast Request or Accept patient |
| `--page` | `#ECFAFC` | the page under everything |
| `--surface` | `#FFFFFF` | cards and controls |

Vital-sign red, amber and green are deliberately *not* the orange. A warning
that looks like a button is a bad warning, so `--critical-fill` is a deep red
(`#D92D3F`, ink `#BE1226`) and `--caution-fill` an amber (`#E0A22E`, ink
`#7E5400`) kept well away from the accent.

The two front-ends apply it differently:

* **Ambulance app.** `app/src/styles.css` carries the same colour values as
  `tokens.css`. Its spacing, radius, glass and motion tokens are its own (the
  "liquid glass" look).
  * It follows the device's `prefers-color-scheme`.
  * Settings offers System / Light / Dark (`data-theme`, saved by `ui.js`
    and applied before first paint by `theme-boot.js`), plus "Lighter
    visuals". Lighter visuals (`html.fx-lite`) drops every blur and is
    switched on by itself on phones with ≤ 3 GB RAM or ≤ 4 cores.
* **ER desk** (`backend/public/hospital/desk.css`). Its own token set, in two
  looks:
  * `.look-glass` is the board: cyan `#22C6DE` and orange `#F58A28` frosted
    glass. Its severity colours (`--crit` `#B42318`, `--warn` `#B45309`,
    `--good` `#1E6B34`) are the only reds, ambers and greens on the board.
    It has a `prefers-color-scheme` dark block.
  * `.look-clinical` is sign-in, password change and the admin console: calm
    white with a clinical blue (`#1A56C4`). It stays light.

  `desk.css` is outside the contrast checker, which reads only `tokens.css`.

The rule is the same in both: cyan means chosen, orange means act, and red,
amber and green are reserved for clinical severity.

---

## Test coverage

`npm test` at the root runs three things:

1. the contrast check;
2. `npm --prefix app test`, which builds the app, then runs six suites;
3. `npm --prefix backend test`, which runs sixteen suites.

The counts below are from a run on this commit. The "—" suites are
single-script checks that print one PASS line.

**Ambulance app and ER desk** (`app/package.json`)

| suite | checks | what it protects |
|---|---|---|
| `app/tests/test.js` | 94 | pure logic from the built `app.js`: vital bands and their edges, number/text coercion, the exact payload shape and its invariants (a blank vital is `null`, never `0`; no `priority`; `stroke_assessment` only on stroke cases), defaults, images, reference data |
| `app/tests/config.test.js` | 12 | where the app thinks its server is, in every context. The APK must fall back to demo rather than guess its own `https://localhost` origin. Also the shipped config defaults, and the APK plumbing: vendored Socket.IO, cleartext traffic in the manifest, script order |
| `app/tests/location.test.js` | 21 | GPS refused → the fallback panel with the right shortcuts; one tap unblocks the broadcast; typed coordinates are validated; a stale fix is not offered; the secure-origin refusal is explained; `origin.source` reaches the payload honestly |
| `app/tests/functional.test.js` | 89 | the real `app/www/index.html` in jsdom: case types, FAST panel, live vital colours, location, photos, validation, broadcast, live acceptance, start new request, network failure and retry, layout and accessibility guards |
| `app/tests/arrival-tracking.test.js` | — | arrival failure and timeout handling, the crew token on both the socket event and the HTTP fallback, native and browser GPS-watch cancellation |
| `app/tests/desk-controls.test.js` | 10 | the ER desk (`backend/public/hospital`) in jsdom. Nothing before sign-in; a temporary password leads to the change screen; an admin opens the console. The board is the hospital the server named, with the token on every call. Escaping, critical vitals, delay alerts, arrival; an expired session returns to sign-in |

**Backend** (`backend/package.json`)

| suite | checks | what it protects |
|---|---|---|
| `backend/tests/security.test.js` | 16 | the boot gate: desks sign in by default and IP identity only when named; every unsafe production setting is refused (IP identity, weak/missing secret, open CORS, `auto`/`memory` driver, `HACKATHON_MODE`); a correct one is accepted |
| `backend/tests/directory.test.js` | 17 | the national CSV and its location grades, radius and word search, no personal contact fields, the 100-hospital network, imports and on/off switches |
| `backend/tests/auth.test.js` | 33 | signed-in desks end to end (`DESK_AUTH=jwt`, `HACKATHON_MODE=false`). The temporary password must change. Identity comes from the login, so `?hospital=`, `X-Hospital-Id` and the IP cannot forge it. Tampered tokens and the wrong role are refused; an untokened desk socket is disconnected. A case reaches only hospitals with a login inside the radius, the crew gets call-ahead hospitals, and an un-offered hospital cannot accept. Lockout, disable and reset sign a login out; all of it is audited |
| `backend/tests/activation.test.js` | 41 | bulk `PENDING` logins with one-time codes: hashed, expiring, single-use. Username and password rules; after activation the hospital opens its own desk only. The administrator's pending/active/disabled/locked view, re-issuing a code, and the old built-in logins retired |
| `backend/tests/directory.mysql.test.js` | skipped without `TEST_MYSQL_URL` | against a real MySQL (8.4 in CI): a v6 database migrated in place, the seed loads exactly 100 and is idempotent, the server reads the network from the table, imports and switches persist, two activations of one code race to one winner |
| `backend/tests/broadcast.smoke.js` | 14 | the whole flow in one script (`DESK_AUTH=ip`, memory): capacity, idempotent POST, broadcast, accept, crew-token checks, GPS to the desk, live ETA, track, timeline, analytics, second accept refused |
| `backend/tests/broadcast.e2e.test.js` | 44 | the real server with two socket desks (`DESK_AUTH=ip`, memory). Both alerted; the simultaneous-accept race has one winner and a 409 carrying the winner's name; `broadcast:claimed` clears the loser; the ambulance status flips. Late accept, decline-all → `REJECTED`, cancel, a hand-set position flagged on the board, junk case types and coordinates refused (including `null`, which `Number()` would have turned into 0°,0°) |
| `backend/tests/patient-edit.test.js` | 13 | crew edits need the token and reach only the accepting desk; `GET /requests` and the desk queue reflect them; edits after arrival and unknown cases are refused |
| `backend/tests/arrival-lifecycle.test.js` | 16 | accepted → active → arrived on the server's lifecycle, idempotent arrival, and the token required on the socket and the HTTP fallback |
| `backend/tests/desk-arrival-tracking.test.js` | — | desk identity, arrival idempotency, GPS validation, live distance and ETA, stale detection, the MySQL row projection (against a fake pool) and tracking shutdown |
| `backend/tests/tracking.test.js` | 5 | track append, throttling, ETA once three points are in, stall detection, drop keeps the aggregate |
| `backend/tests/capacity.test.js` | 6 | upsert, age, sticky diversion, patch semantics (left-out fields keep their value), nonsense refused |
| `backend/tests/matching.test.js` | 5 | match score: distance, missing ventilator, diversion, unknown capacity, readable reasons |
| `backend/tests/audit.test.js` | 2 | events listed per case; the trail is append-only |
| `backend/tests/analytics.test.js` | 6 | hospital scope counts only cases offered to that hospital and its own accepts; network scope counts everything; the store is reported |
| `backend/tests/idempotency.test.js` | 6 | a repeated `client_request_id` creates nothing and hands back the same case and crew token |

Outside `npm test`:

* `backend/scripts/e2e-aws.js` checks a deployed stack end to end.
* `backend/tests/ui.check.js` is a Playwright walk-through written for the v5
  two-laptop desk. It opens `/hospital?hospital=1` without signing in, so
  against the v6+ desk it times out waiting for `#hospitalName`. It needs
  updating before it proves anything again.
