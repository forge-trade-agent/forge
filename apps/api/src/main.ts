import { Redis } from "ioredis";
import { createDb } from "@sealdesk/db";
import { RedisCache, RedisEventBus, RedisRateLimiter, RedisRelayQueue, ViemChainReader } from "@sealdesk/infra";
import { keyFromHex } from "@sealdesk/crypto";
import { createLogger, hashToken, installShutdown, loadEnv, publicClientFromEnv } from "@sealdesk/shared";
import { buildApp } from "./app.ts";
import { DEFAULT_LIMITS, type Ctx } from "./context.ts";

const env = loadEnv("api");
const log = createLogger("api", env.LOG_LEVEL);
const shutdown = installShutdown(log);

const dbh = createDb(env.DATABASE_URL, { applicationName: "forge-api" });
shutdown.register("postgres", () => dbh.close());

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableReadyCheck: true });
// SSE long-polls block a connection; keep them off the main one.
const blocking = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
shutdown.register("redis", () => Promise.all([redis.quit(), blocking.quit()]));

const ctx: Ctx = {
  db: dbh.db,
  chain: new ViemChainReader(publicClientFromEnv(env), env.CHAIN_ID, env.ESCROW_ADDRESS),
  bus: new RedisEventBus(redis, blocking),
  limiter: new RedisRateLimiter(redis),
  cache: new RedisCache(redis),
  relay: new RedisRelayQueue(redis, blocking),
  log,
  now: () => new Date(),
  checks: { db: () => dbh.ping(), redis: async () => (await redis.ping()) === "PONG" },
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
    version: process.env["npm_package_version"] ?? "0.1.0",
    limits: DEFAULT_LIMITS,
  },
};

const app = await buildApp(ctx);
shutdown.register("http", () => app.close());
await app.listen({ host: "0.0.0.0", port: env.API_PORT });
