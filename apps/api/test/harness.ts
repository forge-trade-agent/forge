import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_DIR, schema, type AnyDb } from "@sealdesk/db";
import { MemoryCache, MemoryEventBus, MemoryRateLimiter, MemoryRelayQueue } from "@sealdesk/infra";
import {
  createLogger,
  type ChainReader,
  type Hex,
  type OnChainDealStatus,
  type SettlementProof,
  type TokenFacts,
} from "@sealdesk/shared";
import { buildApp } from "../src/app.ts";
import { DEFAULT_LIMITS, type Ctx, type DeskConfig } from "../src/context.ts";

export const CHAIN_ID = 4663;
export const ESCROW = "0x00000000000000000000000000000000000e5c0e" as Hex;
export const STABLE = "0x0000000000000000000000000000000000005d5d" as Hex;
export const TSLA = "0x322f0929c4625ed5bad873c95208d54e1c003b2d" as Hex;
export const RELAYER = "0x0000000000000000000000000000000000000e1a" as Hex;
export const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

export class FakeChain implements ChainReader {
  readonly chainId = CHAIN_ID;
  readonly escrow = ESCROW;
  tokens = new Map<string, TokenFacts>([
    [TSLA, { address: TSLA, hasCode: true, name: "Tesla", symbol: "TSLA", decimals: 18, totalSupply: "1000000000000000000000000", permit: true }],
  ]);
  statuses = new Map<string, OnChainDealStatus>();
  settlements = new Map<string, SettlementProof>();
  balances = new Map<string, bigint>();
  async tokenFacts(address: Hex): Promise<TokenFacts> {
    return this.tokens.get(address) ?? { address, hasCode: false, name: null, symbol: null, decimals: null, totalSupply: null, permit: false };
  }
  async dealStatus(dealId: Hex): Promise<OnChainDealStatus> {
    return this.statuses.get(dealId) ?? "none";
  }
  async settlementFromTx(tx: Hex): Promise<SettlementProof | null> {
    return this.settlements.get(tx) ?? null;
  }
  async balanceOf(token: Hex, owner: Hex): Promise<bigint> {
    return this.balances.get(`${token}:${owner}`) ?? 0n;
  }
}

export interface Harness {
  ctx: Ctx;
  app: Awaited<ReturnType<typeof buildApp>>;
  chain: FakeChain;
  bus: MemoryEventBus;
  relay: MemoryRelayQueue;
  pg: PGlite;
  clock: { now: number };
  close(): Promise<void>;
}

export async function createHarness(overrides: Partial<DeskConfig> = {}): Promise<Harness> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  const chain = new FakeChain();
  const bus = new MemoryEventBus();
  const relay = new MemoryRelayQueue();
  const clock = { now: Date.UTC(2026, 10, 18, 12, 0, 0) };
  const ctx: Ctx = {
    db: db as unknown as AnyDb,
    chain,
    bus,
    limiter: new MemoryRateLimiter(() => clock.now),
    cache: new MemoryCache(),
    relay,
    log: createLogger("api-test", "silent"),
    now: () => new Date(clock.now),
    checks: { db: async () => true, redis: async () => true },
    config: {
      chainId: CHAIN_ID,
      chainName: "Robinhood Chain",
      rpcUrl: "https://rpc.invalid",
      escrow: ESCROW,
      vault: "0x0000000000000000000000000000000000000fee",
      stable: STABLE,
      platformToken: "0x0000000000000000000000000000000000005ea1",
      relayer: RELAYER,
      relayerMinFeeBps: 10,
      notifyKey: new Uint8Array(32).fill(9),
      publicUrl: "http://desk.test",
      corsOrigins: ["http://localhost:3000"],
      version: "test",
      limits: DEFAULT_LIMITS,
      ...overrides,
    },
  };
  const app = await buildApp(ctx, { streamHeartbeatMs: 200 });
  return {
    ctx,
    app,
    chain,
    bus,
    relay,
    pg,
    clock,
    async close() {
      await app.close();
      await pg.close();
    },
  };
}

let n = 0;
export const idem = () => ({ "idempotency-key": `test-key-${Date.now()}-${++n}` });
export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
