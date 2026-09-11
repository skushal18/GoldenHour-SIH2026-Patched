# Cyan + Orange glass update

Updated the ambulance app and hospital dashboard with cyan selection/navigation,
orange primary actions, frosted acrylic surfaces, liquid-glass highlights,
rounded cards, and coordinated light/dark themes. Native Android background
also uses the new palette. Solid-surface and reduced-transparency fallbacks
preserve readability; existing reduced-motion support remains.

## Age selector

- BABY: 0 – 3
- CHILD: 3 – 17
- ADULT: 18 – 60
- SENIOR CITIZEN: 60+
- Unknown remains available when the patient's age cannot be determined.

The requested labels overlap at 3 and 60. Numeric mapping assigns 3 to Child
and 60 to Senior Citizen. Fractional ages below 3 are Baby; from 3 to below 18
are Child; from 18 to below 60 are Adult. Invalid ages display as Unknown.
This is a demographic selector, not a change to medical triage thresholds.
The existing API still carries representative numeric ages for group selections;
it does not gain a separate exact-age or age-group field in this patch.
Both frontends use the same shared mapping. Old numeric records are displayed
using the new ranges; no database migration is performed.

## Bug fixes

- Out-of-range, nonnumeric, boolean and blank ages no longer display as Adult/Baby.
- Saving unrelated patient edits preserves an existing exact age.
- Age radio controls now support arrow keys, Home/End and one tab stop.
- Configuration tests now isolate their backend settings, so a configured APK
  is tested correctly. The existing Railway URL is preserved.
- Orange and dark-theme borders meet the existing contrast checks.

## Run and build

Use Node.js 20 or 22, as specified by the project.
From this project folder:

```sh
npm run setup
npm run build
npm test
npm run demo
```

For Android, with the project's required Java/Android SDK installed:

```sh
npm run apk
```

The archive includes rebuilt app/www and backend/public/hospital assets,
the complete source, tests and existing Android project. Dependencies are
excluded; npm run setup installs them. This is a project ZIP, not an APK.
No repository push or deployment was performed.

## Verification

- Full project test command passed (frontend and backend suites).
- Final frontend rerun: 214 tests passed, including four new regression checks.
- Shared color checks: all 76 pairs passed.
- Both Vite builds completed successfully.
- Runtime here was Node.js 24; the project's declared runtime remains 20/22.
- Browser visual inspection could not run: Chromium download timed out.
- Native Android compilation, device appearance and live Railway connectivity
  were not verified in this environment.
