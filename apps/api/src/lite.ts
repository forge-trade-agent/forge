/**
 * Forge "lite": the whole pre-launch backend in one small process, for a VPS without Postgres or Redis.
 *   - API (same routes as production) on 127.0.0.1:API_PORT
 *   - PGlite (embedded Postgres) persisted to DATA_DIR
 *   - in-memory cache / rate limits / event bus
 *   - market list from Robinhood every 6h, DEX prices every 2 min (+ Alpha Vantage candles if keyed)
 * No indexer, relayer or on-chain jobs: there are no contracts yet (ESCROW_ADDRESS = zero address).
 * At launch, move to the full stack (deploy/docker-compose.prod.yml) on a server with room for it.
 *
 * Env: the API's usual variables (see packages/shared/src/env.ts) plus DATA_DIR. DATABASE_URL and
 * REDIS_URL are not used here; set them to any URL (e.g. file:///opt/forge/data, memory://local).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_DIR, schema, type AnyDb } from "@sealdesk/db";
import { MemoryCache, MemoryEventBus, MemoryRateLimiter, MemoryRelayQueue, ViemChainReader } from "@sealdesk/infra";
import { keyFromHex } from "@sealdesk/crypto";
import { createLogger, hashToken, installShutdown, loadEnv, publicClientFromEnv } from "@sealdesk/shared";
import { catalogFor, syncCatalog } from "../../worker/src/jobs/catalog.ts";
import { AlphaVantageProvider, refreshReferencePrices, snapshotDex } from "../../worker/src/jobs/market.ts";
import { buildApp } from "./app.ts";
import { DEFAULT_LIMITS, type Ctx } from "./context.ts";

const env = loadEnv("api");
const log = createLogger("forge-lite", env.LOG_LEVEL);
const shutdown = installShutdown(log);

const dataDir = process.env["DATA_DIR"] ?? path.resolve("data");
mkdirSync(dataDir, { recursive: true });
const pg = new PGlite(path.join(dataDir, "pg"));
shutdown.register("pglite", () => pg.close());
const d = drizzle(pg, { schema });
await migrate(d, { migrationsFolder: process.env["MIGRATIONS_DIR"] ?? MIGRATIONS_DIR });
const db = d as unknown as AnyDb;
log.info({ dataDir }, "database ready");

const cache = new MemoryCache();
const ctx: Ctx = {
  db,
  chain: new ViemChainReader(publicClientFromEnv(env), env.CHAIN_ID, env.ESCROW_ADDRESS),
  bus: new MemoryEventBus(),
  limiter: new MemoryRateLimiter(),
  cache,
  relay: new MemoryRelayQueue(),
  log,
  now: () => new Date(),
  checks: { db: async () => (await pg.query("select 1")).rows.length === 1, redis: async () => true },
  config: {
    chainId: env.CHAIN_ID,
    chainName: env.CHAIN_NAME,
    rpcUrl: env.RPC_URLS[0]!,
    escrow: env.ESCROW_ADDRESS,
    vault: env.VAULT_ADDRESS,
    stable: env.STABLE_ADDRESS,
    platformToken: env.PLATFORM_TOKEN_ADDRESS,
    relayer: env.RELAYER_ADDRESS ?? null,
    relayerMinFeeBps: env.RELAYER_MIN_FEE_BPS,
    notifyKey: keyFromHex(env.NOTIFY_ENCRYPTION_KEY),
    notify: { channels: env.NOTIFY_CHANNELS, telegramBot: env.TELEGRAM_BOT_USERNAME ?? null },
    adminTokenHash: env.ADMIN_TOKEN ? hashToken(env.ADMIN_TOKEN) : null,
    publicUrl: env.API_PUBLIC_URL,
    corsOrigins: env.CORS_ORIGINS,
    version: process.env["npm_package_version"] ?? "0.1.0-lite",
    limits: DEFAULT_LIMITS,
  },
};

// ---------------------------------------------------------------- background jobs
/** Runs fn now and then every `ms`, never two at once; failures are logged and retried next tick. */
function every(name: string, ms: number, fn: () => Promise<unknown>) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    const t0 = Date.now();
    try {
      log.info({ job: name, ms: Date.now() - t0, result: await fn() }, "job done");
    } catch (err) {
      log.error({ job: name, err }, "job failed");
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(run, ms);
  timer.unref();
  return run;
}
const slug = process.env["DEXSCREENER_CHAIN"] ?? "robinhood";
const syncMarkets = every("market-catalog", 6 * 3600_000, async () =>
  syncCatalog(db, { chainId: env.CHAIN_ID, entries: await catalogFor(env.CHAIN_ID), now: new Date() }),
);
const prices = every("dex-snapshots", 120_000, () => snapshotDex(db, { chainId: env.CHAIN_ID, slug, extraTokens: [], now: new Date() }));
const av = process.env["ALPHAVANTAGE_API_KEY"];
const candles = av ? every("reference-prices", 15 * 60_000, () => refreshReferencePrices(db, cache, new AlphaVantageProvider(av), env.CHAIN_ID)) : null;

const app = await buildApp(ctx);
shutdown.register("http", () => app.close());
await app.listen({ host: process.env["API_HOST"] ?? "127.0.0.1", port: env.API_PORT });

// Markets first, then prices for them.
void syncMarkets().then(() => prices()).then(() => candles?.());
