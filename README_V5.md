# GoldenHour v5

Rebuilt from `skushal18/GoldenHour-SIH2026-Patched` per the spec in
`GoldenHour-v5-Redesign-and-Features.md` (Parts I–V of v5 design system,
live tracking, capacity, audit/analytics, offline outbox, asset map).

## Run

```bash
# from repo root
npm install                                # root: vite
npm --prefix backend install               # express / socket.io / mysql2
npm --prefix app install                   # capacitor + jsdom (tests)
npm run build                              # vite app + vite desk + WCAG check
DB_DRIVER=memory npm --prefix backend start
# → http://<lan-ip>:5000/ambulance (phone / APK)
# → http://<lan-ip>:5000/hospital   (each ER laptop)
# → http://<lan-ip>:5000/analytics  (Part V dashboard)
```

## Tree (committed build output)

```
shared/design/      tokens.css · primitives.css · contrast.check.js
app/src/            index.html · main.js · modules/* · styles/*
app/www/            BUILT (committed) · config.js (hand-written)
backend/src/        services/{audit,capacity,match,tracking,broadcast}…
backend/desk/src/   index.html · main.js · modules/*   (Vite IIFE bundle)
backend/public/hospital/   BUILT · dashboard.{js,css} · index.html
```

## Notable v5 changes vs the patched baseline

- Single design token file, dark theme re-applied via `@media` + `[data-theme]`
- All text pairs ≥ 4.5:1; all borders ≥ 3:1 (76 pairs, CI-enforced)
- `--tap-*` guaranteed ≥ 44 px on every interactive target
- Tracking ring buffer (120 pts/case), 5 s throttle, ≥3-pt median-speed live ETA
- `match_score` soft gate; capacity strip; `Accept anyway` with named alternative
- `client_request_id` idempotency for /requests (30-min TTL)
- 14-event `activity_events` audit + 8-metric analytics page
- Outbox (3-case cap, photo-dropping ladder, 15-min staleness guard)
