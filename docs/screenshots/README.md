# Screenshots

Captured by `backend/tests/ui.check.js` driving the real server in a headless
browser — not mock-ups.

| file | what it shows |
|---|---|
| `0-landing.png` | the start-here page with the LAN links and the two hardcoded laptops |
| `1-desk-empty.png` | an ER desk waiting, identified by its IP |
| `2-desk-incoming.png` | laptop 1 · a RED stroke case arrives |
| `3-desk-b-incoming.png` | laptop 2 · **the same case, same moment** |
| `4-desk-a-accepted.png` | laptop 1 accepted — "Accepted here, patient is ours" |
| `5-desk-b-cleared.png` | laptop 2 · the card is gone, "Taken by City Emergency Hospital" |
| `6-app-form.png` | the ambulance app, live against the backend |
| `7-app-filled.png` | a stroke case with vitals entered |
| `8-app-waiting.png` | broadcast sent, waiting for a hospital |
| `9-app-accepted.png` | "✓ Accepted by Apollo Hospital", with Call ER and Navigate |
| `a-app-no-gps.png` | GPS refused on a plain-http LAN address — the app explains why and offers a way through |
| `c-desk-manual-origin.png` | the same case on the ER board, flagged **Position set by hand** |
