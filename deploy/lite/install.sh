#!/usr/bin/env bash
# Runs ON the VPS as root after deploy.sh uploads a release to /opt/forge/release-new.
# Idempotent: keeps /opt/forge/data (database) and /opt/forge/.env (secrets) across deploys.
set -euo pipefail
cd /opt/forge

id forge >/dev/null 2>&1 || useradd --system --home /opt/forge --shell /usr/sbin/nologin forge

# Secrets: generated once on this server, never printed.
if [ ! -f .env ]; then
  umask 077
  cat > .env <<EOF
NODE_ENV=production
LOG_LEVEL=info
CHAIN_ID=4663
CHAIN_NAME=Robinhood Chain
RPC_URLS=https://rpc.mainnet.chain.robinhood.com
EXPLORER_URL=https://robinhoodchain.blockscout.com
STABLE_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
STABLE_DECIMALS=6
# Pre-launch: no contracts yet.
ESCROW_ADDRESS=0x0000000000000000000000000000000000000000
VAULT_ADDRESS=0x0000000000000000000000000000000000000000
PLATFORM_TOKEN_ADDRESS=0x0000000000000000000000000000000000000000
DATABASE_URL=file:///opt/forge/data
REDIS_URL=memory://local
DATA_DIR=/opt/forge/data
MIGRATIONS_DIR=/opt/forge/api/migrations
SDK_BUNDLE_PATH=/opt/forge/api/forge.mjs
MCP_BUNDLE_PATH=/opt/forge/api/forge-mcp.mjs
API_HOST=127.0.0.1
API_PORT=5341
API_PUBLIC_URL=https://api.forgetrade.sbs
CORS_ORIGINS=https://forgetrade.sbs,https://www.forgetrade.sbs
NOTIFY_CHANNELS=webhook
NOTIFY_ENCRYPTION_KEY=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 24)
EOF
fi
chmod 600 .env

# Swap in the new release.
if [ -d release-new ]; then
  rm -rf api.old web.old
  [ -d api ] && mv api api.old
  [ -d web ] && mv web web.old
  mv release-new/api api
  mv release-new/web web
  rmdir release-new
fi
mkdir -p data
chown -R forge:forge /opt/forge
chmod 700 /opt/forge/data

cat > /etc/systemd/system/forge-api.service <<'EOF'
# Forge API + jobs (lite: PGlite in /opt/forge/data) on 127.0.0.1:5341, behind nginx (api.forgetrade.sbs).
[Unit]
Description=Forge API (api.forgetrade.sbs) on 127.0.0.1:5341
After=network-online.target
Wants=network-online.target

[Service]
User=forge
Group=forge
WorkingDirectory=/opt/forge/api
Environment="NODE_OPTIONS=--max-old-space-size=160 --dns-result-order=ipv4first"
# --liftoff-only: V8's optimizing wasm compiler runs out of memory on PGlite's wasm on <1 GB boxes.
ExecStart=/usr/bin/node --liftoff-only --env-file=/opt/forge/.env server.mjs
Restart=always
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/forge/data

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/forge-web.service <<'EOF'
# Forge site (Next.js standalone) on 127.0.0.1:5340, behind nginx (forgetrade.sbs).
[Unit]
Description=Forge site (forgetrade.sbs) on 127.0.0.1:5340
After=network-online.target forge-api.service
Wants=network-online.target

[Service]
User=forge
Group=forge
WorkingDirectory=/opt/forge/web/apps/web
Environment=NODE_ENV=production
Environment=HOSTNAME=127.0.0.1
Environment=PORT=5340
Environment=NEXT_TELEMETRY_DISABLED=1
Environment="NODE_OPTIONS=--max-old-space-size=160"
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable forge-api forge-web >/dev/null 2>&1
systemctl restart forge-api forge-web

for i in $(seq 1 60); do curl -fsS 127.0.0.1:5341/health >/dev/null 2>&1 && break; sleep 2; done
for i in $(seq 1 30); do curl -fsSI 127.0.0.1:5340 >/dev/null 2>&1 && break; sleep 2; done
echo "api: $(curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:5341/health)  web: $(curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:5340/)"
rm -rf api.old web.old
