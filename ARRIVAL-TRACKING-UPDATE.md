# Hospital arrival and live ambulance tracking

Based on GoldenHour-SIH2026-Patched, branch Patch-2, commit
5b3f4e9e2e6d2851d2e66e958af6a1bde9c03609. All 173 original files were
checked against the GitHub tree's blob hashes before editing.

## Hospital dashboard

Each accepted case now has an **Arrived at hospital** switch. A staff member
confirms arrival; the switch changes to arrived only after server success.
Arrival is a one-way case completion, not an on/off setting. It updates the
crew app, stops tracking, removes the case from the incoming count, and retains
the confirmation briefly. Repeat requests are idempotent. Failed requests,
404s and timeouts do not show a false success. A late queue response cannot
resurrect an arrived case.

The new POST /api/v1/desk/arrived/:caseCode endpoint uses the existing deskGuard
identity rather than trusting hospital_id in the request body. Only the
accepting hospital can finish that case. JWT mode enforces the signed identity;
the existing IP/hackathon mode still has its original demo identity rules.
No authentication mode, Railway environment or credentials were changed.

The dashboard now shows a local GPS trail with ambulance and hospital markers,
remaining straight-line distance, last update time and a GPS-based ETA.
No third-party map service receives these coordinates. This is a position plot,
not a street map or a traffic-aware navigation route.

## App and Android APK source

Native Android uses the existing @capacitor/geolocation plugin for the first
fix and ongoing tracking. The browser uses its geolocation API. Location
permission failures are visible; a Retry GPS button lets the crew try again.
GPS is shared after acceptance and stopped after arrival or another terminal
case status. Disconnected sockets do not buffer obsolete positions. Server
acknowledgements distinguish delivery from merely acquiring a GPS fix.

Crew arrival no longer succeeds locally after an HTTP failure or a missing
socket acknowledgement. A missing socket acknowledgement triggers a bounded,
idempotent HTTP retry. Failure leaves the case active and tracking available.

## ETA and data behavior

- At least three usable GPS fixes are required for a GPS ETA.
- ETA estimates use recent GPS speed, distance and the existing road factor;
  they do not use traffic or road routing. Low-speed/stalled estimates are
  withheld, with the original crew estimate shown as a labelled fallback.
- No fix for over 30 seconds makes the location stale and removes the live ETA.
  Dashboard queue polling every 10 seconds updates freshness after socket loss.
- Invalid, old, out-of-order and very inaccurate fixes are rejected.
- Distance is recalculated from each GPS fix instead of staying at pickup distance.
- Track snapshots are read from the shared tracking service, including when
  MySQL returns a new case object. Raw GPS trails remain in server memory and
  are cleared at arrival. A server restart clears that trail; new fixes rebuild it.
  Use one backend process for this implementation; multiple replicas would need
  a shared tracking store.
- MySQL hydration now gives persisted lifecycle columns precedence over old
  JSON snapshot fields, so ACCEPTED/ARRIVED do not revert to PENDING on reads.
- Arrival auditing identifies a hospital-originated update as that hospital.
  Repeated arrival does not create another arrival audit event. The old
  speed-as-ETA-error metric has been removed because it was not an ETA error.

## Build and use

1. Install Node.js 20 or 22 and extract this project.
2. From the project folder run:

```sh
npm run setup
npm run build
npm test
```

3. Deploy the updated backend and its built hospital dashboard together.
   Keep your existing database/environment configuration.
4. Rebuild the APK to install the new native GPS and crew-side behavior:

```sh
npm --prefix app run apk
```

The existing app/www/config.js Railway URL is preserved. Native Android assets
and plugin registrations have been synced. Java and the Android SDK are still
required to compile the APK. This archive contains source and built web assets,
not a compiled APK, and has not been pushed or deployed to GitHub/Railway.

## Check on two devices

1. Open the accepting hospital dashboard and the updated app.
2. Enable GPS and precise location permission; keep the app open in foreground.
3. Send a test case, then accept it at the hospital.
4. Move with the device: after several fresh fixes, verify the GPS trail,
   distance and labelled ETA. Use test data, not a real emergency.
5. Disconnect the phone's internet: after 30–40 seconds the desk should show
   stale location rather than a live ETA. Reconnect and check fresh fixes resume.
6. At the hospital, use its arrival switch. Verify the app receives ARRIVED,
   stops location sharing, and the dashboard active count decreases.
7. Refresh the dashboard: the case must not reappear as en route.

## Verification and limits

The complete project test suite passed. Focused tests also passed for dashboard
switch behavior, offline/404 handling, duplicate clicks, delayed queue races,
crew arrival rejection and acknowledgement timeout, native/browser watch
cancellation, GPS distance/ETA, stale detection, hospital authorization,
tracking shutdown, and MySQL hydration using a mock database response.
Both Vite builds and Capacitor Android synchronization passed.

Tests ran with Node.js 24 in this environment; the project continues to specify
Node.js 20/22. A real MySQL server, live Railway deployment, physical GPS journey,
Android compilation and visual device inspection were not available/verified.
Tracking requires internet to transmit. The plugin does not provide guaranteed
background/screen-locked tracking; keep the app open. See the official plugin
API: https://capacitorjs.com/docs/apis/geolocation
