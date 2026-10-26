#!/bin/bash
# =============================================================================
# GoldenHour — EC2 first-boot setup (Amazon Linux 2023, arm64, e.g. t4g.small).
# Pass this file as the instance's user data. It installs Node 22 and MariaDB,
# clones Patch-2, generates its own secrets (they never leave the machine),
# starts the app on port 8080 and turns on auto-deploy from GitHub.
# Log: /var/log/goldenhour-setup.log   Deploys: /var/log/goldenhour-deploys.log
# =============================================================================
set -euxo pipefail
exec > >(tee -a /var/log/goldenhour-setup.log) 2>&1

BRANCH=Patch-2
REPO=https://github.com/skushal18/GoldenHour-SIH2026-Patched.git

dnf install -y git mariadb105-server tar gzip

# Node.js 22 LTS (official build)
cd /tmp
curl -fsSLO https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-arm64.tar.gz
tar -xzf node-v22.11.0-linux-arm64.tar.gz -C /usr/local --strip-components=1
/usr/local/bin/node -v

# 1 GB swap so npm installs never run out of memory
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi

# MySQL (MariaDB) on this machine, reachable only locally
systemctl enable --now mariadb
DBPASS=$(openssl rand -hex 24)
mysql -e "CREATE DATABASE IF NOT EXISTS goldenhour CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'goldenhour'@'localhost' IDENTIFIED BY '${DBPASS}';
CREATE USER IF NOT EXISTS 'goldenhour'@'127.0.0.1' IDENTIFIED BY '${DBPASS}';
GRANT ALL ON goldenhour.* TO 'goldenhour'@'localhost';
GRANT ALL ON goldenhour.* TO 'goldenhour'@'127.0.0.1';
FLUSH PRIVILEGES;"

# App user and code
id goldenhour || useradd --system --create-home --home-dir /var/lib/goldenhour --shell /sbin/nologin goldenhour
git clone --branch "$BRANCH" --depth 1 "$REPO" /opt/goldenhour
chown -R goldenhour:goldenhour /opt/goldenhour
cd /opt/goldenhour
sudo -u goldenhour -H env PATH=/usr/local/bin:/usr/bin npm --prefix backend ci --omit=dev

# Configuration. HACKATHON_MODE=true (every hospital with a login gets every
# case) is refused by NODE_ENV=production, so this runs as development with
# every other production setting.
JWT=$(openssl rand -base64 48 | tr -d '\n=+/')
cat > /etc/goldenhour.env <<EOF
PORT=8080
NODE_ENV=development
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=goldenhour
DB_PASSWORD=${DBPASS}
DB_NAME=goldenhour
DESK_AUTH=jwt
ALLOW_MANUAL_HOSPITAL_OVERRIDE=false
JWT_SECRET=${JWT}
JWT_TTL=12h
CORS_ORIGIN=https://localhost
HACKATHON_MODE=true
DEMO_SEED=false
EOF
chmod 600 /etc/goldenhour.env

cat > /etc/systemd/system/goldenhour.service <<'EOF'
[Unit]
Description=GoldenHour backend
After=network-online.target mariadb.service
Wants=network-online.target mariadb.service

[Service]
User=goldenhour
WorkingDirectory=/opt/goldenhour
EnvironmentFile=/etc/goldenhour.env
ExecStart=/usr/local/bin/node backend/src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# Auto-deploy: pull the branch every 3 minutes, reinstall and restart on change
cat > /usr/local/bin/goldenhour-update <<EOF
#!/bin/bash
set -eu
cd /opt/goldenhour
G="sudo -u goldenhour -H env PATH=/usr/local/bin:/usr/bin"
\$G git fetch -q --depth 1 origin $BRANCH
LOCAL=\$(\$G git rev-parse HEAD); REMOTE=\$(\$G git rev-parse FETCH_HEAD)
[ "\$LOCAL" = "\$REMOTE" ] && exit 0
\$G git reset -q --hard FETCH_HEAD
\$G npm --prefix backend ci --omit=dev
systemctl restart goldenhour
echo "\$(date -Is) deployed \$REMOTE" >> /var/log/goldenhour-deploys.log
EOF
chmod 755 /usr/local/bin/goldenhour-update

cat > /etc/systemd/system/goldenhour-update.service <<'EOF'
[Unit]
Description=Deploy the latest GoldenHour commit
[Service]
Type=oneshot
ExecStart=/usr/local/bin/goldenhour-update
EOF
cat > /etc/systemd/system/goldenhour-update.timer <<'EOF'
[Unit]
Description=Check GitHub for GoldenHour updates every 3 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=3min
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now goldenhour goldenhour-update.timer
echo "$(date -Is) first deploy $(sudo -u goldenhour git -C /opt/goldenhour rev-parse HEAD)" >> /var/log/goldenhour-deploys.log
echo SETUP-DONE
