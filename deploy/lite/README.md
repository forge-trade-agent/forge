# Forge lite: pre-launch on a small VPS

Live at **https://forgetrade.sbs**, with the API at **https://api.forgetrade.sbs**. It runs on 202.155.16.39 (AlmaLinux 8, 1 vCPU, 950 MB RAM, Node 24 in /usr/local). It moved there from 103.253.212.211 on 2026-11-20.

## What runs

| Unit | Port (127.0.0.1) | What |
|---|---|---|
| `forge-web` | 5340 | Next.js standalone (`/opt/forge/web`), built with `PRELAUNCH=1` |
| `forge-api` | 5341 | `apps/api/src/lite.ts` bundled to `/opt/forge/api/server.mjs`: the API, PGlite in `/opt/forge/data`, the market list every 6h and DEX prices every 2 min |
| Caddy | 80/443 | `/etc/caddy/Caddyfile`: TLS (Let's Encrypt), www → apex, proxies to the two services |

Secrets live in `/opt/forge/.env` (mode 600). They are generated on the server and never leave it. To read the `/admin` token:

```
ssh -i ~/.ssh/forge_vps root@202.155.16.39 "grep ^ADMIN_TOKEN= /opt/forge/.env"
```

## Redeploy

From the repo root:

```
bash deploy/lite/deploy.sh
```

This builds, uploads, swaps the release and restarts. `/opt/forge/data` and `/opt/forge/.env` are kept.

- Public build values are in `site.env`.
- Logs: `journalctl -u forge-api -f` / `journalctl -u forge-web -f`.

`forge-api` runs Node with `--liftoff-only`: without it V8's optimizing wasm compiler runs out of memory on PGlite's wasm on this box. A fresh database initialises in seconds, and the market list syncs on start.

## At launch

Lite has no indexer, no relayer and no on-chain jobs. It cannot run trading. Once the contracts are deployed:

1. Move to a server with at least 2 GB RAM.
2. Use `deploy/docker-compose.prod.yml` (Postgres, Redis, every service).
3. Set the contract addresses and `PRELAUNCH=0`.
