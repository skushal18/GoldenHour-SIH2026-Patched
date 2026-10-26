#!/usr/bin/env bash
# Builds the two deploy artefacts from a clean checkout:
#   dist/backend.zip   Elastic Beanstalk source bundle (backend + its production
#                      node_modules + hospital data + nginx/Procfile from infra/eb)
#   dist/web/          the static front-ends for the S3 bucket:
#                      /index.html  /hospital/  /admin/  /ambulance/  /vendor/
# Usage: infra/scripts/build.sh   (run from anywhere; needs node 22, npm, zip)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/dist"
rm -rf "$OUT" && mkdir -p "$OUT/bundle" "$OUT/web"

# ── backend bundle ───────────────────────────────────────────────────────────
B="$OUT/bundle"
mkdir -p "$B/backend" "$B/data/hospitals" "$B/config" "$B/app"
cp -R "$ROOT/backend/src" "$ROOT/backend/public" "$ROOT/backend/scripts" "$ROOT/backend/package.json" "$ROOT/backend/package-lock.json" "$B/backend/"
(cd "$B/backend" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
cp "$ROOT/data/hospitals/india_hospitals.csv" "$ROOT/data/hospitals/network_hospitals.csv" "$B/data/hospitals/"
cp "$ROOT/config/hospitals.config.js" "$B/config/"
cp -R "$ROOT/app/www" "$B/app/www"
cp -R "$ROOT/infra/eb/." "$B/"
git -C "$ROOT" rev-parse --short HEAD > "$B/backend/REVISION" 2>/dev/null || echo unknown > "$B/backend/REVISION"
(cd "$B" && zip -qr -X "$OUT/backend.zip" . -x '*.DS_Store')

# ── static front-ends ────────────────────────────────────────────────────────
W="$OUT/web"
cp "$ROOT/backend/public/landing/index.html" "$W/index.html"
cp -R "$ROOT/backend/public/hospital" "$W/hospital"
cp -R "$ROOT/backend/public/hospital" "$W/admin"
cp -R "$ROOT/app/www" "$W/ambulance"
mkdir -p "$W/vendor" && cp -R "$ROOT/app/www/vendor/." "$W/vendor/" && cp -R "$ROOT/backend/public/vendor/." "$W/vendor/"
# The web ambulance app is served from the same origin as the API, so it finds
# the server from the page address. (The APK keeps the address in config.js.)
node -e '
  const fs = require("fs"); const f = process.argv[1];
  const src = fs.readFileSync(f, "utf8"); const re = /^  SERVER_BASE:\s*"[^"]*"/m;
  if (!re.test(src)) { console.error("SERVER_BASE not found in " + f); process.exit(1); }
  fs.writeFileSync(f, src.replace(re, "  SERVER_BASE: \"\""));
' "$W/ambulance/config.js"

echo "backend bundle: $(du -h "$OUT/backend.zip" | cut -f1)   web files: $(find "$W" -type f | wc -l)"
