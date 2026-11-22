/**
 * Worker: BullMQ-scheduled jobs plus the notification dispatch loop.
 * Each scheduled job runs on exactly one worker at a time (BullMQ job schedulers dedupe).
 */
import { createHash } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createDb } from "@sealdesk/db";
import { keyFromHex } from "@sealdesk/crypto";
import { RedisCache, RedisEventBus } from "@sealdesk/infra";
import { createLogger, installShutdown, loadEnv, publicClientFromEnv, type Hex } from "@sealdesk/shared";
import { alertDeadlines, gcIdempotency, sweepExpired } from "./jobs/lifecycle.ts";
import { AlphaVantageProvider, refreshReferencePrices, snapshotDex } from "./jobs/market.ts";
import { createSenders, NotifyDispatcher } from "./jobs/notify.ts";
import { reconcile, trackBurn, trackControl, ViemContractsReader } from "./jobs/onchain.ts";
import { catalogFor, syncCatalog } from "./jobs/catalog.ts";
import { QUEUES } from "./queues.ts";

const env = loadEnv("worker");
const log = createLogger("worker", env.LOG_LEVEL);
const shutdown = installShutdown(log);

const dbh = createDb(env.DATABASE_URL, { applicationName: "forge-worker", max: 6 });
shutdown.register("postgres", () => dbh.close());
if (!(await dbh.ping())) throw new Error("database unreachable");
const db = dbh.db;

// BullMQ requires maxRetriesPerRequest = null on its connections.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const blocking = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
shutdown.register("redis", () => Promise.all([connection.quit(), redis.quit(), blocking.quit()]));

const cache = new RedisCache(redis);
const bus = new RedisEventBus(redis, blocking);
const pub = publicClientFromEnv(env);
const reader = new ViemContractsReader(pub, env.ESCROW_ADDRESS, env.VAULT_ADDRESS);
const payAssets: Hex[] = ["0x0000000000000000000000000000000000000000", env.STABLE_ADDRESS];
const provider = env.ALPHAVANTAGE_API_KEY ? new AlphaVantageProvider(env.ALPHAVANTAGE_API_KEY) : null;
if (!provider) log.warn("ALPHAVANTAGE_API_KEY not set: delayed reference prices are disabled");
// Pre-launch: the site runs (markets, prices, notifications) before the contracts exist. Deploy with
// ESCROW_ADDRESS and VAULT_ADDRESS set to the zero address and the on-chain jobs stay idle.
const prelaunch = /^0x0{40}$/i.test(env.ESCROW_ADDRESS);
if (prelaunch) log.warn("ESCROW_ADDRESS is the zero address: pre-launch mode, on-chain jobs are skipped");
const onchain = (fn: () => Promise<unknown>) => (prelaunch ? async () => ({ skipped: "prelaunch" }) : fn);

const jobs: Record<string, () => Promise<unknown>> = {
  [QUEUES.expirySweep.name]: () => sweepExpired(db, bus, new Date()),
  [QUEUES.deadlineAlerts.name]: () => alertDeadlines(db, bus, cache, new Date()),
  [QUEUES.dexSnapshots.name]: () =>
    snapshotDex(db, { chainId: env.CHAIN_ID, slug: env.DEXSCREENER_CHAIN, extraTokens: [env.PLATFORM_TOKEN_ADDRESS], now: new Date() }),
  [QUEUES.referencePrices.name]: async () => (provider ? refreshReferencePrices(db, cache, provider, env.CHAIN_ID) : { skipped: true }),
  [QUEUES.burnTracker.name]: onchain(() =>
    trackBurn(reader, cache, { chainId: env.CHAIN_ID, vault: env.VAULT_ADDRESS, platformToken: env.PLATFORM_TOKEN_ADDRESS, assets: payAssets, now: new Date() })),
  [QUEUES.controlPanel.name]: onchain(() =>
    trackControl(pub, cache, {
      chainId: env.CHAIN_ID, escrow: env.ESCROW_ADDRESS, vault: env.VAULT_ADDRESS, stable: env.STABLE_ADDRESS,
      platformToken: env.PLATFORM_TOKEN_ADDRESS, relayer: env.RELAYER_ADDRESS ?? null, now: new Date(),
    })),
  [QUEUES.ledgerReconcile.name]: onchain(() =>
    reconcile(db, reader, { chainId: env.CHAIN_ID, escrow: env.ESCROW_ADDRESS, vault: env.VAULT_ADDRESS, assets: payAssets, now: new Date(), log, cache })),
  [QUEUES.idempotencyGc.name]: () => gcIdempotency(db, new Date()),
  [QUEUES.marketCatalog.name]: async () => syncCatalog(db, { chainId: env.CHAIN_ID, entries: await catalogFor(env.CHAIN_ID), now: new Date() }),
};

// Fill the market list straight away on a fresh database instead of waiting for the schedule.
await jobs[QUEUES.marketCatalog.name]!().then(
  (r) => log.info({ result: r }, "market catalog synced"),
  (err) => log.error({ err }, "market catalog sync failed (will retry on schedule)"),
);

for (const def of Object.values(QUEUES)) {
  const queue = new Queue(def.name, { connection });
  shutdown.register(`queue:${def.name}`, () => queue.close());
  await queue.upsertJobScheduler(`${def.name}:schedule`, { pattern: def.every, tz: "UTC" }, {
    name: def.name,
    opts: { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  });
  const worker = new Worker(
    def.name,
    async () => {
      const started = Date.now();
      const result = await jobs[def.name]!();
      log.info({ job: def.name, ms: Date.now() - started, result }, "job done");
      return result;
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, err) => log.error({ job: job?.name, err }, "job failed"));
  shutdown.register(`worker:${def.name}`, () => worker.close());
}

// Notification loop
const notifyKey = keyFromHex(env.NOTIFY_ENCRYPTION_KEY);
const dispatcher = new NotifyDispatcher({
  db,
  bus,
  cache,
  log,
  key: notifyKey,
  senders: createSenders({
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    smtpUrl: env.SMTP_URL,
    // Separate key for webhook signatures, derived so the at-rest key is never exposed.
    webhookKey: createHash("sha256").update("sealdesk-webhook-v1").update(notifyKey).digest(),
  }),
});
const stop = new AbortController();
shutdown.register("notify-loop", () => stop.abort());
log.info({ queues: Object.values(QUEUES).map((q) => q.name) }, "worker ready");
while (!stop.signal.aborted) {
  try {
    await dispatcher.drain(10_000);
  } catch (err) {
    log.error({ err }, "notify loop error");
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
