/**
 * Ghost-mode relayer. For each queued request:
 *   1. Re-validate everything (never trust the API's checks): terms, deal id, signature bound to
 *      THIS relayer, fee floor, on-chain status, deadlines.
 *   2. Simulate deliverFor; a revert fails the request without spending gas.
 *   3. Refuse to send above the gas-price cap or when the fee can't cover gas (ETH deals).
 *   4. Hold a lock on the relayer address while choosing a nonce and broadcasting.
 *   5. Wait for the receipt; if stuck, replace with the same nonce and >= 12.5% higher fees.
 * Validation failures and reverts are final (acked). Transport errors are retried (not acked).
 */
import { eq } from "drizzle-orm";
import { deals, relayerTxs, type AnyDb } from "@sealdesk/db";
import { dealIdOf, recoverDeliverSigner } from "@sealdesk/crypto";
import { publishDesk, Terms, type EventBus, type Hex, type Locks, type Logger, type RelayQueue, type RelayRequest } from "@sealdesk/shared";
import { SimulationError, type DeliverForArgs, type Fees, type RelayChain } from "./chain.ts";

export interface RelayerConfig {
  chainId: number;
  escrow: Hex;
  minFeeBps: number;
  maxGasPriceWei: bigint;
  /** Wait this long for a receipt before replacing with higher fees. */
  bumpAfterMs: number;
  maxBumps: number;
  pollMs: number;
  /** Seconds of slack required between now and the deal / auth deadlines. */
  deadlineMarginS: number;
}

export type Outcome =
  | { kind: "mined"; txHash: Hex }
  | { kind: "failed"; error: string }
  | { kind: "retry"; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Relayer {
  private readonly db: AnyDb;
  private readonly chain: RelayChain;
  private readonly queue: RelayQueue;
  private readonly locks: Locks;
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly cfg: RelayerConfig;
  private readonly now: () => number;

  constructor(
    deps: { db: AnyDb; chain: RelayChain; queue: RelayQueue; locks: Locks; bus: EventBus; log: Logger; now?: () => number },
    cfg: RelayerConfig,
  ) {
    this.db = deps.db;
    this.chain = deps.chain;
    this.queue = deps.queue;
    this.locks = deps.locks;
    this.bus = deps.bus;
    this.log = deps.log;
    this.cfg = cfg;
    this.now = deps.now ?? Date.now;
  }

  /** Claim and process one request. Returns null when the queue is empty. */
  async processNext(consumer: string, blockMs: number): Promise<Outcome | null> {
    const req = await this.queue.claim(consumer, blockMs);
    if (!req) return null;
    const outcome = await this.handle(req);
    const at = new Date(this.now()).toISOString();
    if (outcome.kind === "mined") {
      await this.queue.setStatus(req.id, { state: "mined", txHash: outcome.txHash, updatedAt: at });
      await this.queue.ack(req.id);
    } else if (outcome.kind === "failed") {
      await this.queue.setStatus(req.id, { state: "failed", error: outcome.error, updatedAt: at });
      await this.queue.ack(req.id);
    } else {
      // Leave un-acked: another attempt (or another relayer instance) reclaims it later.
      await this.queue.setStatus(req.id, { state: "queued", error: outcome.error, updatedAt: at });
    }
    await this.notify(req, outcome);
    this.log.info({ requestId: req.id, dealId: req.dealId, outcome }, "relay request processed");
    return outcome;
  }

  async handle(req: RelayRequest): Promise<Outcome> {
    // ---------------------------------------------------------- 1. validate
    const parsed = Terms.safeParse(req.terms);
    if (!parsed.success) return { kind: "failed", error: "malformed terms" };
    const t = parsed.data;
    const dealId = dealIdOf(t);
    if (dealId !== req.dealId.toLowerCase()) return { kind: "failed", error: "deal id does not match terms" };

    const nowS = Math.floor(this.now() / 1000);
    const authDeadline = BigInt(req.authDeadline);
    if (authDeadline <= BigInt(nowS + this.cfg.deadlineMarginS)) return { kind: "failed", error: "authorization expires too soon" };
    if (t.deadline <= nowS + this.cfg.deadlineMarginS) return { kind: "failed", error: "deal deadline too close" };

    const minFee = (BigInt(t.price) * BigInt(this.cfg.minFeeBps)) / 10_000n;
    if (BigInt(t.relayerFee) < minFee) return { kind: "failed", error: "relayer fee below minimum" };

    const signer = await recoverDeliverSigner(this.cfg.chainId, this.cfg.escrow, dealId, this.chain.address, authDeadline, req.signature);
    if (!signer || signer.toLowerCase() !== t.seller) return { kind: "failed", error: "authorization not signed by the seller for this relayer" };

    const args: DeliverForArgs = { terms: t, permit: req.permit, authDeadline, signature: req.signature };
    try {
      const status = await this.chain.dealStatus(dealId);
      if (status !== "payment_locked") return { kind: "failed", error: `deal is ${status} on-chain` };

      // ---------------------------------------------------------- 2. simulate
      let gas: bigint;
      try {
        ({ gas } = await this.chain.simulate(args));
      } catch (err) {
        if (err instanceof SimulationError) return { kind: "failed", error: `simulation reverted: ${err.message}` };
        throw err;
      }

      // ---------------------------------------------------------- 3. economics
      const fees = await this.chain.fees();
      if (fees.maxFeePerGas > this.cfg.maxGasPriceWei) return { kind: "retry", error: "gas price above cap; will retry" };
      if (/^0x0{40}$/.test(t.payToken) && BigInt(t.relayerFee) < gas * fees.maxFeePerGas) {
        return { kind: "failed", error: "relayer fee does not cover gas" };
      }
      if ((await this.chain.balance()) < gas * fees.maxFeePerGas) return { kind: "retry", error: "relayer balance too low; will retry" };

      // ---------------------------------------------------------- 4/5. send with nonce lock, bump if stuck
      return await this.sendAndWait(args, dealId, gas, fees);
    } catch (err) {
      this.log.warn({ err, requestId: req.id }, "transient relay error");
      return { kind: "retry", error: "temporary chain error; will retry" };
    }
  }

  private async sendAndWait(args: DeliverForArgs, dealId: Hex, gas: bigint, initial: Fees): Promise<Outcome> {
    const release = await this.locks.acquire(`relayer:${this.cfg.chainId}:${this.chain.address}`, 120_000);
    if (!release) return { kind: "retry", error: "relayer busy; will retry" };
    const known = await this.dealKnown(dealId);
    try {
      const nonce = await this.chain.pendingNonce();
      let fees = initial;
      let prevId: bigint | null = null;
      const hashes: Hex[] = [];

      for (let attempt = 0; attempt <= this.cfg.maxBumps; attempt++) {
        if (attempt > 0) {
          const market = await this.chain.fees();
          fees = {
            maxFeePerGas: max(market.maxFeePerGas, bump(fees.maxFeePerGas)),
            maxPriorityFeePerGas: max(market.maxPriorityFeePerGas, bump(fees.maxPriorityFeePerGas)),
          };
          if (fees.maxFeePerGas > this.cfg.maxGasPriceWei) break;
        }
        const hash = await this.chain.send(args, { nonce, gas, ...fees });
        hashes.push(hash);
        // The tx is already broadcast: bookkeeping failures must never stop us watching it.
        if (known) {
          try {
            const [row]: { id: bigint }[] = await this.db
              .insert(relayerTxs)
              .values({
                chainId: this.cfg.chainId,
                dealId: buf(dealId),
                relayer: this.chain.address,
                nonce,
                txHash: buf(hash),
                maxFeePerGas: fees.maxFeePerGas.toString(),
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
                gasLimit: gas.toString(),
                replacesId: prevId,
              })
              .returning({ id: relayerTxs.id });
            if (prevId !== null) await this.db.update(relayerTxs).set({ status: "replaced" }).where(eq(relayerTxs.id, prevId));
            prevId = row?.id ?? null;
          } catch (err) {
            this.log.error({ err, hash }, "failed to record relay tx; still watching it");
          }
        }

        const deadline = this.now() + this.cfg.bumpAfterMs;
        while (this.now() < deadline) {
          // Any of our same-nonce transactions may be the one that lands.
          for (const h of hashes) {
            const r = await this.chain.receipt(h);
            if (!r) continue;
            if (known) {
              await this.db
                .update(relayerTxs)
                .set({ status: r.status === "success" ? "mined" : "failed", gasUsed: r.gasUsed.toString(), finalizedAt: new Date(this.now()) })
                .where(eq(relayerTxs.txHash, buf(h)))
                .catch((err: unknown) => this.log.error({ err, hash: h }, "failed to record receipt"));
            }
            return r.status === "success" ? { kind: "mined", txHash: h } : { kind: "failed", error: `transaction reverted: ${h}` };
          }
          await sleep(this.cfg.pollMs);
        }
        this.log.warn({ dealId, nonce: nonce.toString(), attempt }, "relay tx not mined yet; replacing with higher fees");
      }
      return { kind: "retry", error: "transaction not mined; will keep watching" };
    } finally {
      await release();
    }
  }

  private async dealKnown(dealId: Hex): Promise<boolean> {
    const [d] = await this.db.select({ id: deals.dealId }).from(deals).where(eq(deals.dealId, buf(dealId)));
    return !!d;
  }

  private async notify(req: RelayRequest, outcome: Outcome) {
    try {
      const [d] = await this.db.select({ quoteId: deals.quoteId }).from(deals).where(eq(deals.dealId, buf(req.dealId)));
      if (!d) return;
      await publishDesk(this.bus, `quote:${d.quoteId}`, "relay.updated", {
        requestId: req.id,
        state: outcome.kind === "retry" ? "queued" : outcome.kind,
        ...(outcome.kind === "mined" ? { txHash: outcome.txHash } : { error: outcome.error }),
      });
    } catch (err) {
      this.log.warn({ err }, "relay notification failed");
    }
  }

  async run(signal: AbortSignal, consumer: string): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.processNext(consumer, 5_000);
      } catch (err) {
        this.log.error({ err }, "relayer loop error");
        await sleep(2_000);
      }
    }
  }
}

const buf = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");
const bump = (x: bigint) => (x * 1125n) / 1000n + 1n; // +12.5%, the minimum most nodes accept for replacement
const max = (a: bigint, b: bigint) => (a > b ? a : b);
