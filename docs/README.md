# Documentation

## Current

| file | what it covers |
|---|---|
| [`../QUICKSTART.md`](../QUICKSTART.md) | the demo-day runbook: two laptops, one Wi-Fi, ten minutes |
| [`../DEPLOYMENT.md`](../DEPLOYMENT.md) | local MySQL setup, and deploying to a real server |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | how the two repos were merged, the broadcast lifecycle, first-accept-wins, the design system |
| [`ambulance-app-api-contract.md`](ambulance-app-api-contract.md) | the exact payload the ambulance app sends, and the rules the backend must honour |
| [`screenshots/`](screenshots/) | captures of the running system |

## Historical

These came from the two original repositories and are kept as project history.
**They describe layouts and instructions that no longer apply** — a `.env` in
the repository root, an `API_BASE` constant on line 15 of `www/app.js`, a
backend-only folder structure, a three-laptop demo with no hospital board.
Where they disagree with the files above, the files above are right.

| file | superseded by |
|---|---|
| `GoldenHour_Deployment_Documentation.pdf` | `../DEPLOYMENT.md` |
| `GoldenHour_Environment_Config.pdf` | `../backend/.env.example` |
| `GoldenHour_API_Documentation.pdf` | `ambulance-app-api-contract.md` + the API table in `../README.md` |
| `GoldenHour_Database_Documentation.pdf` | `../backend/database/schema.sql` (now includes the `broadcasts` and `broadcast_targets` tables) |
| `GoldenHour_API_Screenshots.pdf` | `screenshots/` |
| `GoldenHour-Master-Doc-v3.md` | the original product brief for the ambulance app — still useful for intent, not for structure |
