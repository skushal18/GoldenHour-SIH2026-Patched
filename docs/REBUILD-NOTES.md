# Rebuild notes

What was wrong with the v5 tree, what changed, and why. Written against the
original GenSpark ZIP as the source of truth for the existing implementation.

The short version: **the v5 work was a half-finished migration.** A Vite build
step and a redesigned front-end had been started, the old working files had
already been overwritten by the new build, and the new build produced nothing.
The app on disk could not run at all.

---

## 1 · Why nothing worked

### 1.1 Both front-end bundles were empty

`app/www/app.js` and the desk's `dashboard.js` were **36 bytes** each:

```js
(function() {
  "use strict";
})();
```

Vite only bundles a `<script>` tag marked `type="module"`. `app/src/index.html`
loaded `<script src="app.js">` — a plain tag — so the build had no entry point,
emitted an empty IIFE, and wrote it over the real application. The 1856-line
`app.js` that used to work was gone; `app/src/main.js` was the only surviving
source, and it had never run.

The same was true of the desk.

**Fixed by** making `src/index.html` declare a real module entry, having
`main.js` import its stylesheet, and adding a build plugin that converts Vite's
emitted `<script type="module" crossorigin>` back into a classic tag — and
moves it to the end of `<body>`, because Vite hoists module scripts into
`<head>` where it would have run before `config.js` defined `GH_CONFIG` and
before the vendored socket.io defined `io`.

The bundle is an IIFE that publishes its pure functions to `module.exports`
when a CommonJS host is present and to `window.GH` otherwise, so one artefact
serves both the WebView and `node app/tests/test.js`.

### 1.2 The desk build wrote to a directory nothing serves

`backend/desk/vite.config.js` had `outDir: ../../public/hospital` — the
repository root. `backend/src/server.js` serves `backend/public/hospital`. Every
desk build went nowhere, and the board on screen was whatever stale file
happened to be committed.

### 1.3 The app source crashed on its first statement anyway

`app/src/main.js` assigned `state.photos = []` about fifty lines before
`const state = {…}` was declared — a temporal dead zone error that would have
killed the whole IIFE. It also had no `getBandFor`, `buildPayload`,
`toNumberOrNull` or `toTextOrNull`, all of which `app/tests/test.js` requires,
and no Home screen.

**Fixed by** rebuilding the ambulance front-end as testable modules —
`logic.js`, `env.js`, `geo.js`, `transport.js`, `outbox.js`, `cases.js` — with
`main.js` reduced to DOM wiring, and adding the Home screen, navigation, case
history, patient editing and arrival flow the brief asks for.

### 1.4 `$` was never defined on the desk

`backend/desk/src/main.js` called `$('#themeToggle')` on its first line of
setup and defined `$` nowhere in the file. Even with a correct build, the board
threw immediately and showed its static "ER Desk / connecting…" markup for
ever.

### 1.5 There was no Android project

`app/android/` did not exist, and `@capacitor/cli` was not a dependency — so
`npx cap sync android` had nothing to sync and no CLI to do it with, and the
APK workflow's `cd app/android` could never succeed. This is the real cause of
the `npm error could not determine executable to run` in §4 of the brief; it
was never a Node-version problem.

**Fixed by** pinning `@capacitor/{core,cli,android,geolocation,camera}` at v8,
committing the generated Android project, and asserting in CI that `cap`
resolves from the lockfile before the build runs.

---

## 2 · The bug behind most of the failing tests

`config/hospitals.config.js` resolved a desk's identity by checking the client
**IP first** and the explicit `?hospital=<id>` override second:

```js
const fromIp = LAPTOPS.find(h => h.ip === ip);
if (fromIp) return { hospital: fromIp, matchedBy: 'ip' };
if (override !== undefined && …) { … }
```

Both demo hospitals are configured with `ip: '127.0.0.1'` — which is also how
the demo is rehearsed, two browser windows on one machine. So `find` always
returned hospital 1, the override was unreachable, and **hospital 2 did not
exist**.

Everything that makes this system what it is collapsed to a single desk:

- "laptop 2 is a different hospital" — got 1, expected 2
- "the claimed event marks exactly one laptop as the winner" — both won
- "the losing laptop knows which hospital took it" — there was no loser
- `patient:updated` and `case:arrived` reached every desk, because every desk
  was in room `hospital_1`
- `broadcast.smoke.js:75` crashed, because hospital 2's queue was hospital 1's
  queue, and hospital 1's had just been cleared

**Fixed by** letting an explicit statement of identity beat a guess made from
the network address, and trusting the IP only when it names exactly one
hospital. The override can be switched off with
`ALLOW_MANUAL_HOSPITAL_OVERRIDE=false`, and under `DESK_AUTH=jwt` this function
is never consulted at all.

One change; five suites went green.

---

## 3 · Other defects fixed

| Where | Defect |
|---|---|
| `broadcastService.declineBroadcast` | Referenced an undeclared `record`, so the "everybody declined" notification threw instead of telling the crew. Now every desk is cleared and the ambulance is told. |
| `trackingService` | `recentSpeedKmh` returned `0` for both "not moving" and "cannot tell", and `NaN` for unparseable timestamps — which flowed into the ETA and made a stationary ambulance report `live`. Now `null` means unknown and `0` means measured-and-stationary, timestamps are validated, and the ETA is clamped to 15–80 km/h so a stopped ambulance is not a four-hour ETA. |
| `socketHandler` | `case:follow` never acknowledged, so a client could not tell "subscribed" from "the server never heard me" — and any caller awaiting the ack hung for ever. |
| `socketHandler` | `case:position` went only to the hospital, so the crew's own live ETA never arrived. The case room now gets the derived ETA and distance but **not** the coordinates — anyone holding a case code can join that room. |
| `shared/design/primitives.css` | `.overlay { display: flex }` beat the `hidden` attribute, so every hidden overlay stayed laid out across the whole screen and swallowed taps. The app looked frozen. `[hidden] { display: none !important }` added. |
| Desk `renderActive` | Emitted fact pills with no row wrapper, so each became a full-width row of the card's flex column. Both renderers now share one helper. |
| Desk capacity | Opened a second socket for capacity updates, and assigned the whole ack envelope — `success: true` included — over the capacity record. |
| Desk needs row | Showed `✗` for a hospital that had simply never reported its capacity, telling a charge nurse she had no ventilator when she might have four. Unknown now shows `?`. |
| Desk | Desks never published their capacity, so the network sidebar was permanently empty and every case scored the "unknown capacity" penalty. They now publish on identity. |
| Desk | `#myDivertBtn` did not exist (`#divertBtn` does); the "new case" alert tone was a truncated WAV that no browser could decode; `cfg.ENABLE_SOLD` typo. |
| App | A status update wrote `undefined` over the crew's own typed ETA via `Object.assign`. |
| App | Arrival hid the entire active card, taking the confirmation with it. An arrived case now stays on Home for five minutes; on the desk it stays for 25 seconds and then clears, and is excluded from the active count immediately. |

---

## 4 · Tests

Per the brief, no assertion was weakened. Three test-harness defects were
repaired, each of which made the suite weaker than it looked:

1. **`broadcast.smoke.js`** — `check()` called `fn()` and caught only
   synchronous throws. An async body returned a floating promise: the check
   printed `ok` before it had run, its failure surfaced later as an unhandled
   rejection that killed the process mid-suite, and its assertions raced
   against whatever the script did next. That *is* the crash at line 75. `check`
   is now awaited everywhere.

2. **`broadcast.smoke.js`** — the last request called `.then()` on a `Response`
   (`(await fetch(…)).then(r => r.json())`), which is a `TypeError`.

3. **`tracking.test.js`** — the stall fixture used `10:00:60Z` and `10:01:80Z`.
   No clock shows 60 or 80 seconds, so `new Date()` returned `Invalid Date` and
   the test could never exercise what it claimed to. Timestamps corrected; the
   assertion is untouched, and the underlying service bugs it was pointing at
   were fixed rather than accommodated.

Three CSS assertions in `app/tests/functional.test.js` describe design-system
values (`--tap: 54px`, a `@supports not` fallback, `max-width: 560px`,
`font-size: 17px`). Rather than edit them, the v5 tokens were made to satisfy
them: `--tap` is 54 px, and the `@supports not` block is a real `100dvh`
fallback rather than the dead `backdrop-filter` one it used to be.

A new suite, `backend/tests/security.test.js` (16 checks), covers the
configuration gate described in §5 — which configurations are fatal in
production, which are only noted in development, and that a correct production
environment is accepted.

**412 checks, all passing.**

---

## 5 · Security work

New: `backend/src/config/security.js` audits the environment at boot and, under
`NODE_ENV=production`, refuses to start on an unsafe configuration — weak or
published `JWT_SECRET`, `DESK_AUTH` other than `jwt`, unset or wildcard
`CORS_ORIGIN`, a `DB_DRIVER` that can silently fall back to memory, or
`HACKATHON_MODE` still on. It prints what to change and exits `78`. Outside
production the same findings are startup warnings, so the demo keeps working
and the unsafe configuration becomes impossible to ship by accident. Both
halves are exercised in CI.

Also added: per-client rate limiting, CSP and security headers, `no-store` on
API responses, full validation of every broadcast field (including
inline-data-only images, capped in count and size), error responses that carry
an id instead of a stack trace, graceful shutdown, a real store health probe
behind `/health`, and an Android network-security config that permits cleartext
HTTP only for private-network addresses so a production APK cannot be
downgraded.

The four seeded `admin123` accounts were already absent from `schema.sql`; the
references left in `DEPLOYMENT.md` have been corrected.

`controllers/authController.js` was rewritten because its `register` handler
was an authentication bypass: an unauthenticated caller could POST any role,
including `ADMIN` and including `HOSPITAL_STAFF` for a hospital they had
nothing to do with — which is precisely the token that protects every `/desk`
endpoint. It now requires an administrator, with a first-run bootstrap
exception while the users table is empty, an allowlist for roles, a minimum
password length and a login path that does not reveal which addresses are
registered.

**The auth routes are not mounted.** Neither front-end has a login screen, so
until something calls them a public endpoint that issues ER-desk tokens is
attack surface with no user. The hardened handlers stay in the tree and
`server.js` documents the single line that brings them back.

---

## 6 · Verified end to end

Driven in a real browser (Chromium, via Playwright), two hospital desks and one
ambulance, against the running server:

```
desk A                  City Emergency Hospital
desk B                  Apollo Hospital
broadcast               Sent to 2 nearby hospitals within 15 km
desk A / desk B pending 1 / 1
after A accepts         A active 1 · B pending 0
ambulance status        Accepted by City Emergency Hospital
home active case        visible · Accepted — en route · ETA 12 min
edit patient in transit Saved. The hospital has it.
reached hospital        arrival banner shown · desk A active 0
console / network       no errors
```

---

## 7 · Not done

- **MySQL was never exercised against a real server.** The sandbox has no
  MySQL, so `DB_DRIVER=mysql` was verified only to the point of failing loudly
  when the database is unreachable — which is the behaviour that matters, but
  the schema and the `mysqlStore` write paths have not been run.
- **The APK was not built.** No Android SDK here. The Capacitor project,
  manifest, dependency pinning and workflow are all in place and `cap sync`
  works, but the Gradle build itself is unverified.
- **Railway was not reachable** from this sandbox, so nothing was checked
  against the live deployment.
- **No map tiles.** The desk shows a coordinate readout and a distance/ETA
  panel rather than a Leaflet map. Everything the map would show is present as
  text; adding Leaflet is a contained next step.


---

# GUI transformation

A second pass, after the rebuild: the acrylic redesign and the interaction
changes. Nothing below touched the backend, the API contracts, the case
lifecycle, triage, matching, Socket.IO or persistence.

## 8 · The palette

`shared/design/tokens.css` moved from cyan/coral to the five-colour
GoldenHour palette — `#FFFFFF` surfaces, `#EDF6FF` page wash, `#B7D7F0`
hairlines, `#5A9BD5` interactive blue, `#1F3F66` headings — with red / amber /
green kept for, and only for, clinical severity.

The old system used hue to separate "chosen" from "act". In an all-blue
palette that distinction had to move to depth: selection is a light wash with
a blue edge, the single primary action per screen is a deep saturated blue
with white text. All 76 contrast pairs still pass in light and dark, verified
before a line of CSS was written.

One contrast bug was found doing it: the wordmark tile drew a white glyph on
`#5A9BD5`, which is **2.96:1** — under the 3:1 floor a graphical element
needs. It now uses the dark ink, at 5.5:1.

## 9 · Acrylic

One `.acrylic` treatment, defined once and shared: a translucent white over
the wash, blurred, with a hairline edge and a single 1px inset highlight along
the top — that highlight is what reads as glass rather than as a faded card.

Every acrylic surface declares its opaque form first and layers the
translucency inside `@supports (backdrop-filter…)`. An Android WebView without
backdrop-filter gets a solid white card — the same design minus the depth,
never a smear of unreadable grey over clinical text.

Motion was re-scaled to 110/190/280ms on two non-overshooting curves. Presses
scale to 0.98 rather than bouncing: a control that jumps under a gloved thumb
on a moving stretcher is a control that gets mis-tapped. `prefers-reduced-
motion` still suppresses everything except the pending-broadcast signal.

## 10 · Age becomes a band

The numeric age field and its 2/10/30/50/70 chips are gone. Age is now one of
**Baby · Child · Adult · Senior citizen · Unknown**.

The data contract is untouched: `age` is still the single number the backend,
the validator, triage and the ER board already expect. Each band carries a
representative value that travels on the wire, and `describeAgeBand()` maps
any number back to its band — so both front-ends *display the band*. That
distinction is the point. Showing a selected "Adult" to a doctor as the bare
number 35 would present a precision nobody measured.

The mapping lives in `shared/age-bands.js` and is imported by the ambulance
app and the ER board, because two copies of a clinical banding is how they end
up disagreeing about what "Child" means.

Age and sex are both marked **Required** and both default to Unknown, which is
a real answer and one tap away. They are deliberately *not* a hard gate: an
amber hairline asks for an answer, and a broadcast is never held up by a
demographic field while somebody is doing compressions.

## 11 · The other requested changes

| Change | Notes |
|---|---|
| **Blood pressure** | One control, systolic and diastolic side by side. `systolic_bp` and `diastolic_bp` remain entirely separate values — layout only. One summary chip beside the label; the per-field chips appear only when a half needs attention, and each names itself ("Systolic critical"), because two unlabelled chips under a pair of inputs is a puzzle rather than a warning. |
| **Settings** | A real view. It used to map to `formScroll`, so the Settings tab opened the emergency form and expanded a card inside it. It now holds only what this build actually has: unit ID, connection state and why, the queued-case count, and local storage — no invented switches. |
| **Colour theme** | Removed as a user-facing control from both front-ends. The stylesheet still answers the device's own light/dark preference, so a night shift gets dark surfaces with nothing to configure. |
| **Photos** | Add photo now asks: **Capture a picture** or **Choose from gallery**. Two file inputs, because Android gives the camera only when `capture` is present and the gallery only when it is absent — the choice has to be made before the picker opens. Existing compression, the four-photo cap and removal are unchanged. |
| **X on every popup** | One `data-close` handler, one Escape handler, focus moved into each sheet on open and returned to the opener on close. Existing Cancel / Back buttons stay, because they say what closing will do. |
| **Case types** | Clearer placeholder ("Choose the emergency…"), full-size scrolling quick-picks, the same 33 case types from the same source of truth. |
| **Reached hospital (dashboard)** | A primary action on every active card, using the **existing** `POST /requests/:code/arrived` endpoint — the same one the crew's phone falls back to when its socket is gone. Confirms once, then shows the existing ARRIVED presentation and removes the actions that no longer apply. No second arrival system. |

## 12 · Bugs found and fixed during the redesign

| Where | Defect |
|---|---|
| Desk case cards | **Crew photographs were never rendered.** The data arrived on every card, the CSS existed, and the lightbox handler had always listened for `.shots-row img` — but no renderer ever emitted the markup. Four photographs a crew stopped to take were being dropped at the one place they matter. Thumbnails are now `<button>`-wrapped so they open from the keyboard too. |
| Desk arrived card | The article was given the ribbon's `outcome-arrived` class, so an arrived case turned entirely `--good-wash` with green text — flattening the acrylic and leaving the case title pale green on pale green. It has its own state class now: a green spine, not a wash. |
| Desk print | `@media print` hid three elements and left the acrylic board, the blurred surfaces and the fixed ambient gradient to print. A backdrop-filter in a print job comes out as a grey box over the text. The handover sheet now prints as black on white, alone. |
| Ambulance quick-picks | The horizontally scrolling case row let flexbox shrink its children, squeezing the chips into overlapping circles with clipped labels — the first row a crew reads. |
| Ambulance active card | **Edit patient** and **Report delay** were offered while a case was still PENDING. The server correctly refuses both before a hospital accepts, so a crew could fill in the whole update form and only then be told. Both are now disabled, with a reason, until acceptance. |
| Desk arrival | `paintArrived` could run twice — once from the button's own response and once from the socket — starting a second dwell timer that cleared the card early. It is idempotent now. |
