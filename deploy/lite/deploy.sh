#!/usr/bin/env bash
# Redeploy Forge (lite) to the VPS. Run from the repo root on your machine:
#   bash deploy/lite/deploy.sh            build + upload + restart
#   SKIP_BUILD=1 bash deploy/lite/deploy.sh   upload the last build again
# Keeps /opt/forge/data (database) and /opt/forge/.env (secrets) on the server.
set -euo pipefail
cd "$(dirname "$0")/../.."
VPS="${VPS:-root@202.155.16.39}"
KEY="${KEY:-$HOME/.ssh/forge_vps}"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$VPS")

[ -n "${SKIP_BUILD:-}" ] || node deploy/lite/build.mjs
echo "== uploading to $VPS:/opt/forge"
tar -C deploy/lite/dist -czf - api web | "${SSH[@]}" 'rm -rf /opt/forge/release-new && mkdir -p /opt/forge/release-new && tar -xzf - -C /opt/forge/release-new'
"${SSH[@]}" 'bash -s' < deploy/lite/install.sh
echo "== live: https://forgetrade.sbs  ·  https://api.forgetrade.sbs/health"
