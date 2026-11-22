#!/usr/bin/env bash
# Runs ON the VPS (Ubuntu/Debian), from /opt/forge. Safe to run again: it never overwrites secrets.
#   bash deploy/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "== installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

# Firewall: only SSH and the web.
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

ENV=deploy/.env.prod
if [ ! -f "$ENV" ]; then
  echo "== creating $ENV with fresh secrets"
  cp deploy/env.prod.example "$ENV"
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" "$ENV"
  sed -i "s|^NOTIFY_ENCRYPTION_KEY=.*|NOTIFY_ENCRYPTION_KEY=$(openssl rand -hex 32)|" "$ENV"
  sed -i "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-40)|" "$ENV"
  chmod 600 "$ENV"
fi

echo "== building and starting"
docker compose -f deploy/docker-compose.prod.yml --env-file "$ENV" up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose -f deploy/docker-compose.prod.yml --env-file "$ENV" ps
echo "== done. Admin token for https://\$(grep ^DOMAIN= $ENV | cut -d= -f2)/admin: grep ^ADMIN_TOKEN= /opt/forge/$ENV"
