import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { MIGRATIONS_DIR, deals, quotes, relayerTxs, rfqs, schema, type AnyDb } from "@sealdesk/db";
import { MemoryEventBus, MemoryLocks, MemoryRelayQueue } from "@sealdesk/infra";
import { dealIdOf, deliverTypedData } from "@sealdesk/crypto";
import { createLogger, type Hex, type OnChainDealStatus, type RelayRequest, type Terms } from "@sealdesk/shared";
import { SimulationError, type DeliverForArgs, type Fees, type MinedReceipt, type RelayChain } from "../src/chain.ts";
import { Relayer, type RelayerConfig } from "../src/relayer.ts";

const ESCROW = "0x00000000000000000000000000000000000e5c0e" as Hex;
const RELAYER = "0x0000000000000000000000000000000000000e1a" as Hex;
const TOKEN = "0x322f0929c4625ed5bad873c95208d54e1c003b2d" as Hex;
const STABLE = "0x0000000000000000000000000000000000005d5d" as Hex;
const GWEI = 1_000_000_000n;

let txCounter = 0;

class FakeChain implements RelayChain {
  readonly address = RELAYER;
  status: OnChainDealStatus = "payment_locked";
  revert: string | null = null;
  feeQueue: Fees[] = [];
  baseFee: Fees = { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI };
  sends: { nonce: bigint; fees: Fees; hash: Hex }[] = [];
  /** Which send (1-based) gets mined; 0 = never. */
  mineOnSend = 1;
  reverted = false;
  async dealStatus() {
    return this.status;
  }
  async simulate(_a: DeliverForArgs) {
    if (this.revert) throw new SimulationError(this.revert);
    return { gas: 200_000n };
  }
  async fees() {
    return this.feeQueue.shift() ?? this.baseFee;
  }
  async pendingNonce() {
    return 7n;
  }
  async send(_a: DeliverForArgs, o: { nonce: bigint; gas: bigint } & Fees) {
    const hash = keccak256(toHex(`tx-${++txCounter}`));
    this.sends.push({ nonce: o.nonce, fees: { maxFeePerGas: o.maxFeePerGas, maxPriorityFeePerGas: o.maxPriorityFeePerGas }, hash });
    return hash;
  }
  async receipt(hash: Hex): Promise<MinedReceipt | null> {
    const i = this.sends.findIndex((s) => s.hash === hash);
    if (this.mineOnSend === 0 || this.sends.length < this.mineOnSend || i !== this.mineOnSend - 1) return null;
    return { status: this.reverted ? "reverted" : "success", gasUsed: 150_000n, blockNumber: 100n };
  }
  async balance() {
    return 10n ** 18n;
  }
}

const cfg: RelayerConfig = {
  chainId: 4663,
  escrow: ESCROW,
  minFeeBps: 10,
  maxGasPriceWei: 50n * GWEI,
  bumpAfterMs: 30,
  maxBumps: 3,
  pollMs: 1,
  deadlineMarginS: 60,
};

let pg: PGlite;
let db: AnyDb;
let chain: FakeChain;
let queue: MemoryRelayQueue;
let relayer: Relayer;
let bus: MemoryEventBus;
const ghostPk = generatePrivateKey();
const ghost = privateKeyToAccount(ghostPk).address.toLowerCase() as Hex;
const nowS = () => Math.floor(Date.now() / 1000);

function terms(payToken: Hex = STABLE, relayerFee = "5000000"): Terms {
  return {
    buyer: "0x0000000000000000000000000000000000000b0b",
    seller: ghost,
    token: TOKEN,
    amount: "1000",
    payToken,
    price: "5000000000",
    sellerPayout: "0x0000000000000000000000000000000000005e12",
    referrer: "0x0000000000000000000000000000000000000000",
    relayerFee,
    deadline: nowS() + 3600,
    salt: `0x${"11".repeat(32)}`,
  };
}

async function request(t: Terms, opts: { pk?: Hex; relayer?: Hex } = {}): Promise<RelayRequest> {
  const dealId = dealIdOf(t);
  const authDeadline = BigInt(nowS() + 600);
  const signature = await privateKeyToAccount(opts.pk ?? ghostPk).signTypedData(
    deliverTypedData(4663, ESCROW, dealId, opts.relayer ?? RELAYER, authDeadline),
  );
  return { id: `REQ${Math.random()}`, dealId, terms: t, permit: null, authDeadline: authDeadline.toString(), signature, receivedAt: new Date().toISOString() };
}

before(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS_DIR });
  db = d as unknown as AnyDb;
  const t = terms();
  await db.insert(rfqs).values({
    id: "R1", chainId: 4663, side: "buy", tokenAddress: TOKEN, payToken: STABLE, amount: "1000", encPubKey: Buffer.alloc(32, 1),
    manageTokenHash: Buffer.alloc(32, 2), expiresAt: new Date(Date.now() + 3_600_000),
  });
  await db.insert(quotes).values({ id: "Q1", rfqId: "R1", senderEncPubKey: Buffer.alloc(32, 3), nonce: Buffer.alloc(24), ciphertext: Buffer.alloc(32), quoteTokenHash: Buffer.alloc(32, 4) });
  await db.insert(deals).values({
    dealId: Buffer.from(dealIdOf(t).slice(2), "hex"), chainId: 4663, escrowAddress: ESCROW, rfqId: "R1", quoteId: "Q1",
    buyer: t.buyer, seller: t.seller, tokenAddress: t.token, amount: t.amount, payToken: t.payToken, price: t.price,
    sellerPayout: t.sellerPayout, relayerFee: t.relayerFee, deadline: new Date(t.deadline * 1000), salt: Buffer.from(t.salt.slice(2), "hex"),
  });
});
after(async () => {
  await pg.close();
});
beforeEach(() => {
  chain = new FakeChain();
  queue = new MemoryRelayQueue();
  bus = new MemoryEventBus();
  relayer = new Relayer({ db, chain, queue, locks: new MemoryLocks(), bus, log: createLogger("relayer-test", "silent") }, cfg);
});

test("happy path: validates, simulates, sends once, records the tx and notifies the seller", async () => {
  const req = await request(terms());
  await queue.enqueue(req);
  const out = await relayer.processNext("c1", 0);
  assert.equal(out?.kind, "mined");
  assert.equal(chain.sends.length, 1);
  assert.equal(chain.sends[0]!.nonce, 7n);
  assert.equal((await queue.getStatus(req.id))?.state, "mined");
  assert.equal(queue.pending, 0, "acked");
  const rows = await db.select().from(relayerTxs);
  assert.equal(rows.at(-1)!.status, "mined");
  const events = await bus.read("quote:Q1", 0, 0);
  assert.equal(events[0]!.type, "relay.updated");
});

test("stuck transaction is replaced with the same nonce and >= 12.5% higher fees", async () => {
  chain.mineOnSend = 2;
  const out = await relayer.handle(await request(terms()));
  assert.equal(out.kind, "mined");
  assert.equal(chain.sends.length, 2);
  assert.equal(chain.sends[1]!.nonce, chain.sends[0]!.nonce);
  assert.ok(chain.sends[1]!.fees.maxFeePerGas * 1000n >= chain.sends[0]!.fees.maxFeePerGas * 1125n);
  assert.ok(chain.sends[1]!.fees.maxPriorityFeePerGas * 1000n >= chain.sends[0]!.fees.maxPriorityFeePerGas * 1125n);
  const statuses = (await db.select({ s: relayerTxs.status }).from(relayerTxs)).map((r) => r.s);
  assert.ok(statuses.includes("replaced"));
});

test("signature for another relayer, or by someone other than the seller, is refused without sending", async () => {
  const other = await relayer.handle(await request(terms(), { relayer: "0x0000000000000000000000000000000000000bad" }));
  assert.equal(other.kind, "failed");
  const forged = await relayer.handle(await request(terms(), { pk: generatePrivateKey() }));
  assert.equal(forged.kind, "failed");
  assert.equal(chain.sends.length, 0);
});

test("tampered terms (deal id mismatch) and low fees are refused", async () => {
  const req = await request(terms());
  const tampered = await relayer.handle({ ...req, terms: { ...req.terms, price: "1" } });
  assert.equal(tampered.kind, "failed");
  const cheap = await relayer.handle(await request(terms(STABLE, "1")));
  assert.deepEqual(cheap, { kind: "failed", error: "relayer fee below minimum" });
});

test("not locked on-chain or reverting in simulation: final failure, no gas spent", async () => {
  chain.status = "settled";
  assert.deepEqual(await relayer.handle(await request(terms())), { kind: "failed", error: "deal is settled on-chain" });
  chain.status = "payment_locked";
  chain.revert = "TransferAmountMismatch";
  assert.deepEqual(await relayer.handle(await request(terms())), { kind: "failed", error: "simulation reverted: TransferAmountMismatch" });
  assert.equal(chain.sends.length, 0);
});

test("gas above the cap is retried later, not failed", async () => {
  chain.baseFee = { maxFeePerGas: 80n * GWEI, maxPriorityFeePerGas: GWEI };
  const req = await request(terms());
  await queue.enqueue(req);
  const out = await relayer.processNext("c1", 0);
  assert.equal(out?.kind, "retry");
  assert.equal((await queue.getStatus(req.id))?.state, "queued");
  assert.equal(queue.pending, 1, "not acked: will be reclaimed");
  assert.equal(chain.sends.length, 0);
});

test("ETH deals must pay at least the gas cost", async () => {
  const out = await relayer.handle(await request(terms("0x0000000000000000000000000000000000000000", "5000000")));
  assert.deepEqual(out, { kind: "failed", error: "relayer fee does not cover gas" });
});

test("only one send at a time per relayer address (nonce lock)", async () => {
  const locks = new MemoryLocks();
  const held = await locks.acquire(`relayer:4663:${RELAYER}`, 60_000);
  assert.ok(held);
  const r = new Relayer({ db, chain, queue, locks, bus, log: createLogger("relayer-test", "silent") }, cfg);
  const out = await r.handle(await request(terms()));
  assert.deepEqual(out, { kind: "retry", error: "relayer busy; will retry" });
  assert.equal(chain.sends.length, 0);
});
