import { Redis } from "ioredis";
import { createDb } from "@sealdesk/db";
import { RedisEventBus } from "@sealdesk/infra";
import { chainPreflight, createLogger, installShutdown, loadEnv, publicClientFromEnv } from "@sealdesk/shared";
import { Indexer } from "./indexer.ts";
import { ViemChainSource } from "./source.ts";

const env = loadEnv("indexer");
const log = createLogger("indexer", env.LOG_LEVEL);
const shutdown = installShutdown(log);

const dbh = createDb(env.DATABASE_URL, { applicationName: "forge-indexer", max: 4 });
shutdown.register("postgres", () => dbh.close());
if (!(await dbh.ping())) throw new Error("database unreachable");

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
shutdown.register("redis", () => redis.quit());

const client = publicClientFromEnv(env);
await chainPreflight(client, log, {
  chainId: env.CHAIN_ID,
  contracts: { OtcEscrow: env.ESCROW_ADDRESS, BuyBurnVault: env.VAULT_ADDRESS },
});

const indexer = new Indexer(dbh.db, new ViemChainSource(client), new RedisEventBus(redis, redis), log, {
  chainId: env.CHAIN_ID,
  escrow: env.ESCROW_ADDRESS,
  vault: env.VAULT_ADDRESS,
  stable: env.STABLE_ADDRESS,
  stableDecimals: env.STABLE_DECIMALS,
  startBlock: env.ESCROW_DEPLOY_BLOCK,
  confirmations: env.INDEXER_CONFIRMATIONS,
  batchBlocks: env.INDEXER_BATCH_BLOCKS,
});

const stop = new AbortController();
shutdown.register("indexer-loop", () => stop.abort());
log.info({ confirmations: env.INDEXER_CONFIRMATIONS }, "indexer running");
try {
  await indexer.run(stop.signal, env.INDEXER_POLL_MS);
} catch (err) {
  log.fatal({ err }, "indexer stopped");
  process.exit(2);
}
