/**
 * Feeds the indexer real ABI-encoded OtcEscrow / BuyBurnVault logs and checks deal state,
 * the double-entry ledger, stats tables, exactly-once replays and deep-reorg halting.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  toHex,
  type Abi,
  type AbiEvent,
  type Log,
} from "viem";
import { MIGRATIONS_DIR, chainCursors, deals, quotes, rfqs, schema, type AnyDb } from "@sealdesk/db";
import { MemoryEventBus } from "@sealdesk/infra";
import { buyBurnVaultAbi, createLogger, otcEscrowAbi, type Hex } from "@sealdesk/shared";
import { dealIdOf, toOnChainTerms } from "@sealdesk/crypto";
import { DeepReorgError, Indexer } from "../src/indexer.ts";
import type { BlockHeader, ChainSource } from "../src/source.ts";

const ESCROW = "0x00000000000000000000000000000000000e5c0e" as Hex;
const VAULT = "0x0000000000000000000000000000000000000fee" as Hex;
const STABLE = "0x0000000000000000000000000000000000005d5d" as Hex;
const TOKEN = "0x322f0929c4625ed5bad873c95208d54e1c003b2d" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const BUYER = A(0xb0b), SELLER = A(0x5e11), PAYOUT = A(0x5e12), REF = A(0x4ef), CLAIM_TO = A(0xc1a1), ROUTE = A(0x4007e);

function encodeLog(abi: Abi, eventName: string, args: Record<string, unknown>, at: { block: bigint; index: number; tx: Hex; address: Hex }): Log {
  const item = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [item], eventName, args: args as never }) as [Hex, ...Hex[]];
  const nonIndexed = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]));
  return {
    address: at.address,
    topics,
    data,
    blockNumber: at.block,
    blockHash: blockHash(at.block),
    logIndex: at.index,
    transactionHash: at.tx,
    transactionIndex: 0,
    removed: false,
  } as Log;
}
const blockHash = (n: bigint, fork = "") => keccak256(toHex(`block-${n}${fork}`));
const txh = (s: string) => keccak256(toHex(s));

class FakeSource implements ChainSource {
  head = 0n;
  logs: Log[] = [];
  forks = new Map<bigint, string>();
  inputs = new Map<string, Hex>();
  async getBlockNumber() {
    return this.head;
  }
  async getBlock(n: bigint): Promise<BlockHeader> {
    return { number: n, hash: blockHash(n, this.forks.get(n) ?? ""), parentHash: blockHash(n - 1n), timestamp: 1_800_000_000n + n * 2n };
  }
  async getLogs(_a: Hex[], from: bigint, to: bigint) {
    return this.logs.filter((l) => l.blockNumber! >= from && l.blockNumber! <= to);
  }
  async getTransactionInput(hash: Hex) {
    return this.inputs.get(hash) ?? null;
  }
}

let pg: PGlite;
let db: AnyDb;
let src: FakeSource;
let bus: MemoryEventBus;
let indexer: Indexer;

const termsA = {
  buyer: BUYER, seller: SELLER, token: TOKEN, amount: "1000000000000000000000", payToken: STABLE,
  price: "5000000000", sellerPayout: PAYOUT, referrer: REF, relayerFee: "0", deadline: 1_800_100_000, salt: `0x${"01".padStart(64, "0")}` as Hex,
};
const termsB = { ...termsA, payToken: ZERO, price: "2000000000000000000", referrer: ZERO, salt: `0x${"02".padStart(64, "0")}` as Hex };
const termsC = { ...termsA, referrer: ZERO, sellerPayout: A(0xcafe), salt: `0x${"03".padStart(64, "0")}` as Hex };
const idA = dealIdOf(termsA), idB = dealIdOf(termsB), idC = dealIdOf(termsC);
const FEE_A = 125_000_000n, REF_A = 62_500_000n;

async function balances() {
  const r = await pg.query<{ code: string; asset: string; balance: string }>(`select code, asset, balance::text from ledger_balances`);
  return Object.fromEntries(r.rows.map((x) => [`${x.code}|${x.asset}`, BigInt(x.balance)]));
}

before(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS_DIR });
  db = d as unknown as AnyDb;

  await db.insert(rfqs).values({
    id: "R1", chainId: 4663, side: "buy", tokenAddress: TOKEN, payToken: STABLE, amount: "1", encPubKey: Buffer.alloc(32, 1),
    manageTokenHash: Buffer.alloc(32, 2), expiresAt: new Date(Date.now() + 3_600_000),
  });
  for (const [qid, h] of [["Q1", 3], ["Q2", 4]] as const) {
    await db.insert(quotes).values({ id: qid, rfqId: "R1", senderEncPubKey: Buffer.alloc(32, h), nonce: Buffer.alloc(24), ciphertext: Buffer.alloc(32), quoteTokenHash: Buffer.alloc(32, h + 10) });
  }
  for (const [t, id, qid] of [[termsA, idA, "Q1"], [termsB, idB, "Q2"]] as const) {
    await db.insert(deals).values({
      dealId: Buffer.from(id.slice(2), "hex"), chainId: 4663, escrowAddress: ESCROW, rfqId: "R1", quoteId: qid,
      buyer: t.buyer, seller: t.seller, tokenAddress: t.token, amount: t.amount, payToken: t.payToken, price: t.price,
      sellerPayout: t.sellerPayout, referrer: t.referrer === ZERO ? null : t.referrer, relayerFee: t.relayerFee,
      deadline: new Date(t.deadline * 1000), salt: Buffer.from(t.salt.slice(2), "hex"),
    });
  }

  src = new FakeSource();
  const esc = (name: string, args: Record<string, unknown>, block: bigint, index: number, tx: string) =>
    encodeLog(otcEscrowAbi as Abi, name, args, { block, index, tx: txh(tx), address: ESCROW });
  const settledArgs = (id: Hex, t: typeof termsA, fee: bigint, ref: bigint) => ({
    dealId: id, buyer: t.buyer, seller: t.seller, token: t.token, amount: BigInt(t.amount), payToken: t.payToken,
    price: BigInt(t.price), fee, referrerFee: ref, relayerFee: 0n, relayer: ZERO,
  });
  src.logs.push(
    esc("PaymentLocked", { dealId: idA, buyer: BUYER, seller: SELLER, payToken: STABLE, price: 5_000_000_000n, payer: BUYER }, 10n, 0, "lockA"),
    esc("PaymentLocked", { dealId: idB, buyer: BUYER, seller: SELLER, payToken: ZERO, price: 2n * 10n ** 18n, payer: BUYER }, 10n, 1, "lockB"),
    esc("PayoutDeferred", { payToken: STABLE, account: REF, amount: REF_A }, 11n, 0, "settleA"),
    esc("Settled", settledArgs(idA, termsA, FEE_A, REF_A), 11n, 1, "settleA"),
    esc("Claimed", { payToken: STABLE, account: REF, to: CLAIM_TO, amount: REF_A }, 12n, 0, "claim"),
    esc("Refunded", { dealId: idB, buyer: BUYER, payToken: ZERO, price: 2n * 10n ** 18n }, 12n, 1, "refundB"),
    encodeLog(buyBurnVaultAbi as Abi, "Burned", { payToken: STABLE, amountIn: FEE_A - REF_A, amountBurned: 10n ** 24n, route: ROUTE },
      { block: 12n, index: 2, tx: txh("burn"), address: VAULT }),
  );
  src.head = 14n;

  bus = new MemoryEventBus();
  indexer = new Indexer(db, src, bus, createLogger("indexer-test", "silent"), {
    chainId: 4663, escrow: ESCROW, vault: VAULT, stable: STABLE, stableDecimals: 6, startBlock: 10n, confirmations: 2, batchBlocks: 100,
  });

  // Deal C was made outside this API: its payout address must come from the settlement calldata.
  const input = encodeFunctionData({ abi: otcEscrowAbi, functionName: "deliver", args: [toOnChainTerms(termsC)] });
  src.inputs.set(txh("settleC"), input);
});

after(async () => {
  await pg.close();
});

test("indexes confirmed blocks only and drives deal state", async () => {
  const advanced = await indexer.tick();
  assert.equal(advanced, 3); // blocks 10..12; head 14 minus 2 confirmations
  const [a] = await db.select().from(deals).where(eq(deals.dealId, Buffer.from(idA.slice(2), "hex")));
  assert.equal(a!.status, "settled");
  assert.equal(a!.fee, FEE_A.toString());
  assert.equal(a!.priceUsd, "5000.000000");
  const [b] = await db.select().from(deals).where(eq(deals.dealId, Buffer.from(idB.slice(2), "hex")));
  assert.equal(b!.status, "refunded");
  assert.ok(b!.paymentLockedAt);
});

test("ledger balances: escrow and vault fully unwound, every asset sums to zero", async () => {
  const bal = await balances();
  assert.equal(bal[`escrow:locked|${STABLE}`], 0n);
  assert.equal(bal[`escrow:locked|${ZERO}`], 0n);
  assert.equal(bal[`escrow:owed|${STABLE}`], 0n);
  assert.equal(bal[`vault:fees|${STABLE}`], 0n);
  assert.equal(bal[`external:${PAYOUT}|${STABLE}`], 5_000_000_000n - FEE_A);
  assert.equal(bal[`external:${CLAIM_TO}|${STABLE}`], REF_A);
  assert.equal(bal[`external:${REF}|${STABLE}`], 0n, "deferred then claimed elsewhere");
  assert.equal(bal[`external:${BUYER}|${TOKEN}`], 10n ** 21n);
  const perAsset = new Map<string, bigint>();
  for (const [k, v] of Object.entries(bal)) perAsset.set(k.split("|")[1]!, (perAsset.get(k.split("|")[1]!) ?? 0n) + v);
  for (const [asset, sum] of perAsset) assert.equal(sum, 0n, `asset ${asset} does not net to zero`);
});

test("stats tables and realtime events are written", async () => {
  const ticks = await pg.query<{ price_usd: string }>(`select price_usd::text from settlement_ticks`);
  assert.deepEqual(ticks.rows.map((r) => r.price_usd), ["5000.000000"]);
  const burned = await pg.query<{ n: number }>(`select count(*)::int as n from burns`);
  assert.equal(burned.rows[0]!.n, 1);
  const events = await bus.read("rfq:R1", 0, 0);
  assert.deepEqual(events.map((e) => e.type), ["payment.locked", "payment.locked", "deal.settled", "deal.refunded"]);
});

test("caught up: nothing to do until new confirmed blocks", async () => {
  assert.equal(await indexer.tick(), 0);
});

test("a settlement for a deal made elsewhere is attributed via its calldata", async () => {
  src.logs.push(
    encodeLog(otcEscrowAbi as Abi, "PaymentLocked", { dealId: idC, buyer: BUYER, seller: SELLER, payToken: STABLE, price: 5_000_000_000n, payer: BUYER },
      { block: 13n, index: 0, tx: txh("lockC"), address: ESCROW }),
    encodeLog(otcEscrowAbi as Abi, "Settled", {
      dealId: idC, buyer: BUYER, seller: SELLER, token: TOKEN, amount: 10n ** 21n, payToken: STABLE, price: 5_000_000_000n,
      fee: FEE_A, referrerFee: 0n, relayerFee: 0n, relayer: ZERO,
    }, { block: 13n, index: 1, tx: txh("settleC"), address: ESCROW }),
  );
  src.head = 15n;
  assert.equal(await indexer.tick(), 1);
  const bal = await balances();
  assert.equal(bal[`external:${A(0xcafe)}|${STABLE}`], 5_000_000_000n - FEE_A);
  assert.equal(bal[`vault:fees|${STABLE}`], FEE_A);
});

test("replaying already-indexed blocks is a no-op (exactly-once)", async () => {
  const before = await pg.query<{ n: number }>(`select count(*)::int as n from ledger_postings`);
  await db.delete(chainCursors).where(sql`true`); // simulate a lost cursor
  while ((await indexer.tick()) > 0) {
    /* re-index from the start block */
  }
  const after = await pg.query<{ n: number }>(`select count(*)::int as n from ledger_postings`);
  assert.equal(after.rows[0]!.n, before.rows[0]!.n);
  const ev = await pg.query<{ n: number }>(`select count(*)::int as n from deal_events where source = 'chain'`);
  assert.equal(ev.rows[0]!.n, 4); // PaymentLocked A, Settled A, PaymentLocked B, Refunded B
});

test("a reorg deeper than the confirmation depth halts the indexer", async () => {
  src.forks.set(13n, "-fork");
  await assert.rejects(indexer.tick(), DeepReorgError);
});
