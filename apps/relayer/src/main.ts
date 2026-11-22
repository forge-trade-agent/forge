import { hostname } from "node:os";
import { formatEther, parseGwei } from "viem";
import { Redis } from "ioredis";
import { createDb } from "@sealdesk/db";
import { RedisEventBus, RedisLocks, RedisRelayQueue } from "@sealdesk/infra";
import {
  chainFromEnv,
  chainPreflight,
  createLogger,
  installShutdown,
  loadEnv,
  publicClientFromEnv,
  type Hex,
} from "@sealdesk/shared";
import { ViemRelayChain } from "./chain.ts";
import { Relayer } from "./relayer.ts";

const env = loadEnv("relayer");
const log = createLogger("relayer", env.LOG_LEVEL);
const shutdown = installShutdown(log);

const dbh = createDb(env.DATABASE_URL, { applicationName: "forge-relayer", max: 4 });
shutdown.register("postgres", () => dbh.close());
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const blocking = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
shutdown.register("redis", () => Promise.all([redis.quit(), blocking.quit()]));

const pub = publicClientFromEnv(env);
await chainPreflight(pub, log, { chainId: env.CHAIN_ID, contracts: { OtcEscrow: env.ESCROW_ADDRESS } });

const chain = new ViemRelayChain(pub, chainFromEnv(env), env.RPC_URLS, env.RELAYER_PRIVATE_KEY as Hex, env.ESCROW_ADDRESS);
const balance = await chain.balance();
log.info({ relayer: chain.address, balanceEth: formatEther(balance), minFeeBps: env.RELAYER_MIN_FEE_BPS }, "relayer ready");
if (balance === 0n) log.warn("relayer has no ETH for gas; requests will wait");

const relayer = new Relayer(
  { db: dbh.db, chain, queue: new RedisRelayQueue(redis, blocking), locks: new RedisLocks(redis), bus: new RedisEventBus(redis, blocking), log },
  {
    chainId: env.CHAIN_ID,
    escrow: env.ESCROW_ADDRESS,
    minFeeBps: env.RELAYER_MIN_FEE_BPS,
    maxGasPriceWei: parseGwei(String(env.RELAYER_MAX_GAS_GWEI)),
    bumpAfterMs: 45_000,
    maxBumps: 4,
    pollMs: 2_000,
    deadlineMarginS: 120,
  },
);

const stop = new AbortController();
shutdown.register("relayer-loop", () => stop.abort());
await relayer.run(stop.signal, `${hostname()}-${process.pid}`);
