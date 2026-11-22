#!/usr/bin/env bash
# Runs on YOUR machine: ships the repo to the VPS and (re)starts the stack there.
#   bash deploy/deploy.sh                 (defaults below)
#   VPS=root@1.2.3.4 KEY=~/.ssh/forge_vps bash deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VPS="${VPS:-root@103.253.212.211}"
KEY="${KEY:-$HOME/.ssh/forge_vps}"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$VPS")

echo "== uploading to $VPS:/opt/forge"
tar --exclude=node_modules --exclude=.next --exclude='.next-*' --exclude=.git --exclude='*.log' \
    --exclude=contracts/out --exclude=contracts/cache --exclude=contracts/broadcast --exclude=contracts/lib \
    --exclude=brand --exclude='.env' --exclude='.env.local' --exclude=deploy/.env.prod \
    --exclude=apps/e2e/.dev-admin-token -czf - . | "${SSH[@]}" 'mkdir -p /opt/forge && tar -xzf - -C /opt/forge'
"${SSH[@]}" 'cd /opt/forge && bash deploy/setup.sh'
