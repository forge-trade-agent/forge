import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import {
  MIGRATIONS_DIR,
  deals,
  dexSnapshots,
  idempotencyKeys,
  markets,
  notificationSubscriptions,
  priceCandles,
  quotes,
  rfqs,
  schema,
  type AnyDb,
} from "@sealdesk/db";
import { MemoryCache, MemoryEventBus } from "@sealdesk/infra";
import { encryptAtRest } from "@sealdesk/crypto";
import { createLogger, hashToken, NOTIFY_CHANNEL, type Hex } from "@sealdesk/shared";
import { alertDeadlines, gcIdempotency, sweepExpired } from "../src/jobs/lifecycle.ts";
import { aggregate, parseAlphaVantage, refreshReferencePrices, snapshotDex, type Candle, type ReferenceProvider } from "../src/jobs/market.ts";
import { assertPublicHttps, createSenders, isPublicIp, NotifyDispatcher, type Senders } from "../src/jobs/notify.ts";
import { DEAD, reconcile, trackBurn, type ContractsReader } from "../src/jobs/onchain.ts";

const log = createLogger("worker-test", "silent");
const TOKEN = "0x322f0929c4625ed5bad873c95208d54e1c003b2d" as Hex;
const STABLE = "0x0000000000000000000000000000000000005d5d" as Hex;
const ESCROW = "0x00000000000000000000000000000000000e5c0e" as Hex;
const VAULT = "0x0000000000000000000000000000000000000fee" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const NOW = new Date(Date.UTC(2026, 10, 18, 12));
const KEY = new Uint8Array(32).fill(7);
const MANAGE = "sd_" + "m".repeat(43);

let pg: PGlite;
let db: AnyDb;

async function seedRfq(id: string, expiresAt: Date, tokenHash = hashToken(`sd_${id.padEnd(43, "x")}`)) {
  await db.insert(rfqs).values({
    id, chainId: 4663, side: "buy", tokenAddress: TOKEN, payToken: STABLE, amount: "10", encPubKey: Buffer.alloc(32, 1),
    manageTokenHash: tokenHash, createdAt: new Date(NOW.getTime() - 7_200_000), expiresAt,
  });
}
async function seedQuote(id: string, rfqId: string) {
  await db.insert(quotes).values({
    id, rfqId, senderEncPubKey: Buffer.alloc(32, 2), nonce: Buffer.alloc(24), ciphertext: Buffer.alloc(32), quoteTokenHash: hashToken(`sd_${id.padEnd(43, "q")}`),
  });
}
async function seedDeal(n: number, rfqId: string, quoteId: string, status: "accepted" | "payment_locked", deadline: Date) {
  await db.insert(deals).values({
    dealId: Buffer.alloc(32, n), chainId: 4663, escrowAddress: ESCROW, rfqId, quoteId, buyer: `0x${"b".repeat(40)}`, seller: `0x${"c".repeat(40)}`,
    tokenAddress: TOKEN, amount: "10", payToken: STABLE, price: "1000", sellerPayout: `0x${"c".repeat(40)}`, deadline, salt: Buffer.alloc(32, n),
    status, ...(status === "payment_locked" ? { paymentLockedAt: NOW } : {}),
  });
}

before(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS_DIR });
  db = d as unknown as AnyDb;
});
after(async () => {
  await pg.close();
});

test("sweepExpired closes expired postings, their unanswered answers and unpaid deals", async () => {
  await seedRfq("OLD00000000000000000000000", new Date(NOW.getTime() - 1000));
  await seedQuote("QOLD0000000000000000000000", "OLD00000000000000000000000");
  await seedRfq("LIVE0000000000000000000000", new Date(NOW.getTime() + 3_600_000), hashToken(MANAGE));
  await seedQuote("QLIVE000000000000000000000", "LIVE0000000000000000000000");
  await seedQuote("QLIVE200000000000000000000", "LIVE0000000000000000000000");
  await seedDeal(1, "LIVE0000000000000000000000", "QLIVE000000000000000000000", "accepted", new Date(NOW.getTime() - 1));
  await seedDeal(2, "LIVE0000000000000000000000", "QLIVE200000000000000000000", "payment_locked", new Date(NOW.getTime() + 10 * 60_000));

  const bus = new MemoryEventBus();
  assert.deepEqual(await sweepExpired(db, bus, NOW), { rfqs: 1, quotes: 1, deals: 1 });
  assert.deepEqual(await sweepExpired(db, bus, NOW), { rfqs: 0, quotes: 0, deals: 0 });
  const [q] = await db.select().from(quotes).where(eq(quotes.id, "QLIVE000000000000000000000"));
  assert.equal(q!.status, "sealed", "answers on live postings stay sealed");
  assert.equal((await bus.read("rfq:OLD00000000000000000000000", 0, 0))[0]!.type, "rfq.closed");
});

test("alertDeadlines warns both sides once and fans out to the notify channel", async () => {
  const bus = new MemoryEventBus();
  const cache = new MemoryCache();
  assert.deepEqual(await alertDeadlines(db, bus, cache, NOW), { alerted: 1 });
  assert.deepEqual(await alertDeadlines(db, bus, cache, NOW), { alerted: 0 });
  const n = await bus.read(NOTIFY_CHANNEL, 0, 0);
  assert.deepEqual(n.map((e) => e.data["channel"]), ["rfq:LIVE0000000000000000000000", "quote:QLIVE200000000000000000000"]);
});

test("notifications: decrypt destinations, send without prices or secrets, resume from cursor", async () => {
  await db.insert(notificationSubscriptions).values([
    { capabilityHash: hashToken(MANAGE), channel: "telegram", destinationEnc: Buffer.from(encryptAtRest(KEY, "123456", "notify:telegram")) },
    { capabilityHash: hashToken(MANAGE), channel: "webhook", destinationEnc: Buffer.from(encryptAtRest(KEY, "https://hooks.example/x", "notify:webhook")) },
  ]);
  const sent: string[] = [];
  const senders: Senders = {
    telegram: async (chat, text) => void sent.push(`tg:${chat}:${text}`),
    email: async () => void sent.push("email"),
    webhook: async (url, payload) => void sent.push(`wh:${url}:${JSON.stringify(payload)}`),
  };
  const bus = new MemoryEventBus();
  const cache = new MemoryCache();
  await bus.publish(NOTIFY_CHANNEL, "answer.received", { channel: "rfq:LIVE0000000000000000000000", quoteId: "Q" });
  await bus.publish(NOTIFY_CHANNEL, "answer.received", { channel: "rfq:UNKNOWN000000000000000000" });
  const d = new NotifyDispatcher({ db, bus, cache, senders, key: KEY, log });
  assert.equal(await d.drain(0), 2);
  assert.ok(sent[0]!.startsWith("tg:123456:Forge: A sealed answer arrived"));
  assert.ok(sent[1]!.startsWith("wh:https://hooks.example/x:"));
  assert.ok(!sent.join().includes("1000") && !sent.join().includes("#"), "no price, no link");
  assert.equal(await d.drain(0), 0, "cursor persisted");
});

test("webhook SSRF guard and HMAC signature", async () => {
  assert.equal(isPublicIp("8.8.8.8"), true);
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.20.0.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  await assert.rejects(assertPublicHttps("http://example.com/x", async () => ["8.8.8.8"]), /https/);
  await assert.rejects(assertPublicHttps("https://internal.example/x", async () => ["10.0.0.5"]), /public address/);
  await assert.rejects(assertPublicHttps("https://169.254.169.254/latest/meta-data"), /public address/);

  let captured: { headers: Record<string, string>; body: string } | null = null;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    captured = { headers: init.headers as Record<string, string>, body: init.body as string };
    assert.equal(init.redirect, "error");
    return new Response("ok");
  }) as unknown as typeof fetch;
  const key = new Uint8Array(32).fill(3);
  await createSenders({ webhookKey: key, fetchImpl: fakeFetch, resolve: async () => ["93.184.216.34"] }).webhook("https://hooks.example/x", { event: "deal.settled" });
  const c = captured!;
  const expected = createHmac("sha256", key).update(`${c.headers["x-forge-timestamp"]}.${c.body}`).digest("hex");
  assert.equal(c.headers["x-forge-signature"], `sha256=${expected}`);
});

test("DexScreener snapshot keeps the deepest pool per token", async () => {
  await db.insert(markets).values({ chainId: 4663, symbol: "TSLA", name: "Tesla", kind: "stock", tokenAddress: TOKEN, decimals: 18, underlyingSymbol: "TSLA", featured: true });
  const body = [
    { pairAddress: "0xshallow", baseToken: { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" }, priceUsd: "380.00", liquidity: { usd: 1000 } },
    { pairAddress: "0xdeep", baseToken: { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" }, priceUsd: "383.47", liquidity: { usd: 250000 },
      marketCap: 4_510_000, volume: { h24: 726067.1 }, priceChange: { h24: 0.3 } },
    { pairAddress: "0xquote", baseToken: { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" }, priceUsd: "700" },
  ];
  let url = "";
  const fakeFetch = (async (u: string) => {
    url = u;
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  const r = await snapshotDex(db, { chainId: 4663, slug: "robinhood", extraTokens: [], fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.written, 1);
  assert.ok(url.startsWith("https://api.dexscreener.com/tokens/v1/robinhood/0x322f"));
  const [s] = await db.select().from(dexSnapshots);
  assert.equal(s!.poolAddress, "0xdeep");
  assert.equal(s!.priceUsd, "383.470000000000000000");
});

test("Alpha Vantage parsing converts New York time to UTC; 5m bars roll up correctly", () => {
  const json = {
    "Meta Data": { "6. Time Zone": "US/Eastern" },
    "Time Series (5min)": {
      "2026-11-17 15:55:00": { "1. open": "380.00", "2. high": "381.00", "3. low": "379.50", "4. close": "380.50", "5. volume": "100" },
      "2026-11-17 15:50:00": { "1. open": "379.00", "2. high": "380.20", "3. low": "378.00", "4. close": "380.00", "5. volume": "50" },
      "2026-11-17 15:45:00": { "1. open": "378.50", "2. high": "379.10", "3. low": "378.40", "4. close": "379.00", "5. volume": "25" },
    },
  };
  const bars = parseAlphaVantage(json, "Time Series (5min)");
  assert.equal(bars[0]!.t.toISOString(), "2026-11-17T20:45:00.000Z"); // EST = UTC-5 in November
  const q = aggregate(bars, 15);
  assert.equal(q.length, 1);
  assert.deepEqual([q[0]!.o, q[0]!.h, q[0]!.l, q[0]!.c, q[0]!.v], ["378.50", "381.00", "378.00", "380.50", "175"]);
  assert.throws(() => parseAlphaVantage({ Note: "Thank you for using Alpha Vantage! ..." }, "Time Series (5min)"), /rate limit/);
});

test("reference prices refresh one market per run into 5m/15m/1h/1d candles", async () => {
  const bar = (iso: string, c: string): Candle => ({ t: new Date(iso), o: c, h: c, l: c, c, v: "1" });
  const provider: ReferenceProvider = {
    name: "fake",
    intraday5m: async () => [bar("2026-11-17T20:00:00Z", "1"), bar("2026-11-17T20:05:00Z", "2"), bar("2026-11-17T20:55:00Z", "3")],
    daily: async () => [bar("2026-11-16T21:00:00Z", "10"), bar("2026-11-17T21:00:00Z", "11")],
  };
  const r = await refreshReferencePrices(db, new MemoryCache(), provider, 4663);
  assert.equal(r.market, "TSLA");
  const rows = await db.select().from(priceCandles);
  const by = (i: string) => rows.filter((x) => x.interval === i).length;
  assert.deepEqual([by("5m"), by("15m"), by("1h"), by("1d")], [3, 2, 1, 2]);
});

test("reconciliation passes when chain, contract totals and ledger agree, and flags drift", async () => {
  const reader = (escrowBal: bigint): ContractsReader => ({
    balanceOf: async (_t, owner) => (owner === ESCROW ? escrowBal : 0n),
    escrowTotals: async () => ({ locked: 0n, owed: 0n }),
    vault: async () => ({ route: ZERO, pendingRoute: ZERO, pendingEta: 0n, totalBurned: 0n }),
  });
  const cache = new MemoryCache();
  const ok = await reconcile(db, reader(0n), { chainId: 4663, escrow: ESCROW, vault: VAULT, assets: [STABLE], now: NOW, log, cache });
  assert.equal(ok.ok, true);
  const bad = await reconcile(db, reader(5n), { chainId: 4663, escrow: ESCROW, vault: VAULT, assets: [STABLE], now: NOW, log, cache });
  assert.equal(bad.ok, false);
  assert.match(bad.assets[0]!.problems[0]!, /contract invariant/);
});

test("burn tracker reports active route, queued route with ETA and dead-address total", async () => {
  const route = "0x0000000000000000000000000000000000004007" as Hex;
  const queued = "0x0000000000000000000000000000000000004008" as Hex;
  const reader: ContractsReader = {
    balanceOf: async (token, owner) => (owner === DEAD ? 6_321_611n * 10n ** 18n : token === STABLE ? 42n : 0n),
    escrowTotals: async () => ({ locked: 0n, owed: 0n }),
    vault: async () => ({ route, pendingRoute: queued, pendingEta: BigInt(NOW.getTime() / 1000 + 86_400), totalBurned: 7n }),
  };
  const cache = new MemoryCache();
  const s = await trackBurn(reader, cache, { chainId: 4663, vault: VAULT, platformToken: TOKEN, assets: [ZERO, STABLE], now: NOW });
  assert.equal(s.route, route);
  assert.equal(s.queued?.activatableNow, false);
  assert.equal(s.atDeadAddress, (6_321_611n * 10n ** 18n).toString());
  assert.deepEqual(s.feesWaiting.map((f) => f.amount), ["0", "42"]);
  assert.deepEqual(await cache.get("burn:4663"), JSON.parse(JSON.stringify(s)));
});

test("idempotency GC deletes only expired keys", async () => {
  await db.insert(idempotencyKeys).values([
    { scope: "s", key: "expired-key-1", requestHash: Buffer.alloc(32), expiresAt: new Date(NOW.getTime() - 1) },
    { scope: "s", key: "live-key-0001", requestHash: Buffer.alloc(32), expiresAt: new Date(NOW.getTime() + 1000) },
  ]);
  assert.deepEqual(await gcIdempotency(db, NOW), { deleted: 1 });
});
