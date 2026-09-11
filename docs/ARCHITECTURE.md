# Architecture

How the two repositories were merged, what was added, and where the seams are.

---

## Where the pieces came from

| origin | what it contributed |
|---|---|
| `skushal18/GoldenHour-APP` | the ambulance app (`app/`) — plain HTML/CSS/JS wrapped by Capacitor, plus its 170-check test suite and the APK workflow |
| `Lakshitha08-lks/goldenhour-backend` | the backend (`backend/`) — Express, MySQL schema, auth/case/hospital controllers, Socket.IO scaffolding |
| new in this repo | the hospital desk board, the broadcast subsystem, the hardcoded two-laptop identity layer, the in-memory fallback store, the end-to-end race test, the Coral & Cyan restyle |

Nothing from either original repository was deleted. The authenticated
`/api/v1/auth`, `/api/v1/cases` and `/api/v1/hospitals` routes still exist and
behave exactly as they did.

---

## The request lifecycle

```
   AMBULANCE APP                    SERVER                     TWO LAPTOPS
   ─────────────                    ──────                     ───────────
   Broadcast Request
        │  POST /api/v1/requests
        ├──────────────────────────►  computePriority(vitals)
        │                             resolveTargets(origin, radius)
        │                                  HACKATHON_MODE → both laptops
        │                                  otherwise      → Haversine + radius
        │                             store.insertBroadcast()
        │                                  1 broadcast + 1 target row each
        │  201 {id, hospitals_notified}
        ◄──────────────────────────┤
        │                             io.to('hospital_1').emit('broadcast:new')
        │                             io.to('hospital_2').emit('broadcast:new')
        │                             ──────────────────────────────►  card appears
        │                                                              on BOTH boards
        │  socket 'case:follow'
        ├──────────────────────────►
        │                                                    Accept pressed on ONE
        │                             ◄──────────────────────────────
        │                             POST /api/v1/desk/accept/:code
        │                             store.claim()  ← atomic, one winner
        │                             io.to(each hospital).emit('broadcast:claimed')
        │                             ──────────────────────────────►  winner locks in,
        │                                                              loser's card leaves
        │  socket 'case:status'
        ◄──────────────────────────┤
   ✓ Accepted by …
```

Polling runs underneath the whole picture: the app polls
`GET /requests/:caseCode` and each board polls `GET /desk/queue`. If Socket.IO
never connects, the demo still works — it just moves at poll speed instead of
instantly.

---

## Identity by IP

`config/hospitals.config.js` is the only place the two laptops are named.

```js
resolveHospital(ip, override)
  1. override (?hospital=1)  — if ALLOW_MANUAL_HOSPITAL_OVERRIDE
  2. exact match on the normalised IP
  3. FALLBACK_HOSPITAL_ID, flagged as a guess
```

`normaliseIp` handles the three shapes Node actually hands you:
`::ffff:192.168.1.101` (IPv4-mapped IPv6), `::1` (loopback), and a
comma-separated `x-forwarded-for` list.

Two places consume it:

* `middleware/hospitalIdentity.js` — for HTTP requests to `/api/v1/desk/*`
* `sockets/socketHandler.js` — for the socket handshake, which is what puts a
  laptop into its `hospital_<id>` room

The board always shows which of the three branches decided, because "the demo
silently thinks both laptops are hospital 1" is the failure mode worth being
loud about.

---

## First-accept-wins

This is the only piece of concurrency in the system, so it is worth being
precise about.

**MySQL** (`store/mysqlStore.js`):

```sql
BEGIN;
SELECT * FROM broadcast_targets
 WHERE case_code = ? AND hospital_id = ? FOR UPDATE;

UPDATE broadcasts
   SET status = 'ACCEPTED', accepted_hospital_id = ?, accepted_at = NOW()
 WHERE case_code = ? AND status = 'PENDING';       -- ← the race is decided here

-- affectedRows = 0 → someone else won, roll the answer back to the caller
UPDATE broadcast_targets
   SET status = CASE WHEN hospital_id = ? THEN 'ACCEPTED' ELSE 'CANCELLED' END
 WHERE case_code = ?;
COMMIT;
```

The `WHERE status = 'PENDING'` clause is the lock. Whichever transaction
reaches it second sees zero affected rows and is told `ALREADY_ACCEPTED`, with
the winner's name attached so the losing board can say something useful.

**In-memory** (`store/memoryStore.js`): the same check-and-set, written
synchronously. Node does not interleave it, so the guarantee holds without a
mutex. The e2e test fires both accepts with `Promise.all` and asserts exactly
one 200 and one 409 — under both drivers.

---

## The store abstraction

`store/index.js` picks a driver at boot:

| `DB_DRIVER` | behaviour |
|---|---|
| `auto` (default) | try MySQL; on failure warn loudly and use memory |
| `mysql` | require MySQL, exit if unreachable |
| `memory` | never touch MySQL (`npm run demo`, `--memory`) |

Both drivers implement the same nine methods, so nothing above the store knows
which one is running.

The MySQL driver additionally mirrors each broadcast into the original
relational tables (`cases`, `case_clinical_data`, `critical_flags`,
`activity_events`) so the rest of the pre-existing API keeps returning real
data. That mirror is **best-effort**: it runs in its own transaction, and a
failure is logged and swallowed. A schema drift in a legacy table must never
take down a live broadcast.

### New tables

```sql
broadcasts          case_code PK, status, priority, payload JSON,
                    accepted_hospital_id, accepted_at, expires_at, legacy_case_id
broadcast_targets   case_code + hospital_id UNIQUE, hospital snapshot,
                    distance_km, status
```

The full case is stored as JSON rather than shredded across ten tables. The ER
board wants the whole snapshot at once, and the relational mirror already
exists for the reporting side.

---

## Front-ends

Both are plain HTML/CSS/JS, no build step, no bundler, no framework.

**Ambulance app** (`app/www/`) — unchanged in structure. Three things were
added:

* `config.js`, so the server URL is one line in one file instead of a constant
  buried in `app.js`
* server auto-detection: served from the backend it finds it, opened from
  `file://` with nothing configured it drops into demo mode
* a Socket.IO channel that pushes the acceptance instead of waiting for the
  next poll — with the poll left in place as the fallback

**ER desk board** (`backend/public/hospital/`) — new. Identifies itself from
`/desk/me`, joins its room over the socket, renders a card per incoming case,
and removes the card on `broadcast:claimed`. It re-renders the whole board on
every change; at hackathon volumes that is simpler and less fragile than
diffing, and the leaving card is animated out before the re-render.

---

## Getting a position at all

The ambulance app needs coordinates or no hospital can be matched. Three
sources, in descending order of trust, and the payload always says which one
it was:

| `origin.source` | where it came from | `accuracy_m` |
|---|---|---|
| `gps` | the device measured it | the real figure |
| `last-known` | the device measured it earlier this shift (≤6 h, from `localStorage`) | the figure from then |
| `manual` | a preset tap or typed coordinates | `null` — nothing was measured |

This exists because of one specific trap. Chrome grants geolocation only on
secure origins, and `http://192.168.1.100:5000` is not one — `localhost` gets
an exemption that a private IP does not. So the app opened in a phone browser
from the laptop's LAN address has GPS refused outright:

```
http://127.0.0.1:5301   isSecureContext: true   → "Location locked"
http://192.0.2.2:5301   isSecureContext: false  → "Only secure origins are allowed"
```

The APK is unaffected — Capacitor's WebView is a secure context and the native
Geolocation plugin does not go through the browser API — and so is any HTTPS
tunnel. But the browser route is the one people reach for five minutes before
a demo, and a form that silently will not send is the worst possible failure
there. So the app explains the cause, offers the three fallbacks, and lets the
broadcast go.

`accuracy_m` is never invented for a hand-set position, and the ER board
renders a **"Position set by hand"** chip on the card, because a distance
computed from a typed point should not be read the same way as a measured one.

`app/tests/location.test.js` covers all of it, including that a fix older than
six hours is *not* offered — a day-old position would put the ambulance in the
wrong city.

---

## Two security postures

`DESK_AUTH` picks which, and the startup banner says which is live.

| | `ip` (default) | `jwt` |
|---|---|---|
| Who is this board? | its IP, matched against `config/hospitals.config.js` | `hospital_id` inside a signed token |
| `?hospital=2` | changes identity (that is the point) | ignored |
| HTTP | open | `authenticateToken` + role `HOSPITAL_STAFF`/`ADMIN` |
| Socket | joins its room on connect | no valid token → `hospital:rejected` and disconnected |
| Correct for | a closed hackathon LAN | anything reachable from elsewhere |

The socket half matters as much as the HTTP half. A board that could not read
`/desk/queue` but could still join `hospital_2` over Socket.IO would receive
every incoming case anyway — the same patient data, through a side door. So
`resolveDeskIdentity` refuses the socket outright in jwt mode, and the legacy
`join_hospital` event (a free pass into any room, written for the LAN-trust
world) is disabled there too.

Identity resolution is shared: `services/hospitalDirectory.js` answers "who is
hospital #N?" from the config during the demo and from the `hospitals` table
afterwards, so nothing downstream has to know which world it is in.

---

## Design system

Four colours, from the brief:

| token | hex | job |
|---|---|---|
| cyan | `#25CED1` | brand, selection, focus, "this desk", "we claimed it" |
| coral | `#FF8A5B` | one job only: the button that acts — Broadcast Request, Accept patient |
| neutral | `#F4F4F4` | the page under everything |
| white | `#FFFFFF` | cards and controls |

Vital-sign red, amber and green are deliberately *not* coral. A warning that
looks like a button is a bad warning, so `--critical` is a deeper, more
saturated red (`#D92D3F`) than the coral accent, and `--caution` is amber
(`#B07A12`) rather than orange.

Both front-ends define the same tokens and both carry a dark-mode block driven
by `prefers-color-scheme`, so a laptop or phone on a night theme keeps the same
"cyan means chosen, coral means act" logic.

---

## Test coverage

| suite | what it protects |
|---|---|
| `app/tests/test.js` (92) | payload rules — a blank vital is `null` and never `0`, `stroke_assessment` only on STROKE cases, `priority` never sent, vital band boundaries |
| `app/tests/functional.test.js` (80) | the real page in jsdom — dropdown, chips, photos, submit, polling, the accepted/failed overlays, tap-target sizes, dark theme, no web fonts, labelled controls |
| `app/tests/location.test.js` (21) | GPS refused → the panel appears with the right shortcuts, one tap unblocks the broadcast, typed coordinates are validated, a stale fix is not offered, and `origin.source` reaches the payload honestly |
| `backend/tests/broadcast.e2e.test.js` (40) | the real server — both laptops alerted, the simultaneous-accept race, the 409 with the winner's name, the ambulance status flip, decline, cancel, expiry, a hand-set position reaching the board flagged, and junk coordinates refused (including `null`, which `Number()` would have turned into a valid 0°,0°) |
| `app/tests/config.test.js` (12) | server resolution in all four contexts — the APK must fall back to demo rather than guessing its own `https://localhost` origin — plus the APK plumbing: vendored Socket.IO client, cleartext traffic in the manifest, `config.js` loaded before `app.js` |
| `backend/tests/desk-auth.test.js` (17) | `DESK_AUTH=jwt` — anonymous, forged, expired and wrong-role tokens all refused; identity taken from the token so `?hospital=2` cannot forge it; the race still resolves to one winner; and an unauthenticated desk *socket* is disconnected rather than quietly streaming patient data over a channel HTTP would have blocked |
| `backend/tests/ui.check.js` | a Playwright walk-through of the actual two-board demo. Not part of `npm test` — it needs `npm i -D playwright` — but it is what proves the browser story end to end |
