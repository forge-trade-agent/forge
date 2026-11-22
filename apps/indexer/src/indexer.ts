/**
 * Reorg-safe log indexer for OtcEscrow and BuyBurnVault.
 *
 * Safety model:
 *  - Only blocks at least `confirmations` deep are indexed, so ordinary reorgs never reach the DB.
 *  - Every batch first re-checks that the last indexed block hash is still canonical. If not, the
 *    reorg was deeper than the confirmation depth: the indexer halts (fails closed) and alerts,
 *    because ledger and event tables are append-only by design and must not be silently rewritten.
 *  - Each batch (logs + cursor) commits in ONE transaction: exactly-once processing.
 *  - Journals and chain events are unique per (chain, tx, logIndex), so replays are no-ops.
 */
import { decodeEventLog, decodeFunctionData, type Log } from "viem";
import { and, eq } from "drizzle-orm";
import {
  burns,
  chainCursors,
  dealEvents,
  deals,
  indexedBlocks,
  settlementTicks,
  type AnyDb,
} from "@sealdesk/db";
import { buyBurnVaultAbi, otcEscrowAbi, publishDesk, type DeskEventType, type EventBus, type Hex, type Logger } from "@sealdesk/shared";
import { ext, Ledger, type Line, type Tx } from "./ledger.ts";
import type { BlockHeader, ChainSource } from "./source.ts";

export interface IndexerConfig {
  chainId: number;
  escrow: Hex;
  vault: Hex;
  stable: Hex;
  stableDecimals: number;
  startBlock: bigint;
  confirmations: number;
  batchBlocks: number;
}

export class DeepReorgError extends Error {
  constructor(block: bigint, stored: Hex, canonical: Hex) {
    super(`reorg deeper than confirmation depth at block ${block}: indexed ${stored}, canonical ${canonical}`);
    this.name = "DeepReorgError";
  }
}

type Publish = { channel: string; type: DeskEventType; data: Record<string, unknown> };
const buf = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");
const hexOf = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase() as Hex;

export class Indexer {
  private readonly ledger: Ledger;
  private readonly db: AnyDb;
  private readonly src: ChainSource;
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly cfg: IndexerConfig;

  constructor(db: AnyDb, src: ChainSource, bus: EventBus, log: Logger, cfg: IndexerConfig) {
    this.db = db;
    this.src = src;
    this.bus = bus;
    this.log = log;
    this.cfg = { ...cfg, escrow: lc(cfg.escrow), vault: lc(cfg.vault), stable: lc(cfg.stable) };
    this.ledger = new Ledger(cfg.chainId);
  }

  private async cursor(): Promise<{ lastBlock: bigint; lastBlockHash: Hex | null }> {
    const [c] = await this.db
      .select()
      .from(chainCursors)
      .where(and(eq(chainCursors.chainId, this.cfg.chainId), eq(chainCursors.contract, this.cfg.escrow)));
    if (!c) return { lastBlock: this.cfg.startBlock - 1n, lastBlockHash: null };
    return { lastBlock: c.lastBlock, lastBlockHash: hexOf(c.lastBlockHash) };
  }

  /** Index one batch. Returns the number of blocks advanced (0 = caught up). */
  async tick(): Promise<number> {
    const head = await this.src.getBlockNumber();
    const safe = head - BigInt(this.cfg.confirmations);
    const cur = await this.cursor();

    if (cur.lastBlockHash) {
      const canonical = await this.src.getBlock(cur.lastBlock);
      if (canonical.hash.toLowerCase() !== cur.lastBlockHash.toLowerCase()) {
        throw new DeepReorgError(cur.lastBlock, cur.lastBlockHash, canonical.hash);
      }
    }

    const from = cur.lastBlock + 1n;
    if (from > safe) return 0;
    const to = from + BigInt(this.cfg.batchBlocks) - 1n < safe ? from + BigInt(this.cfg.batchBlocks) - 1n : safe;

    const logs = (await this.src.getLogs([this.cfg.escrow, this.cfg.vault], from, to)).sort((a, b) =>
      a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : a.blockNumber! < b.blockNumber! ? -1 : 1,
    );

    const headers = new Map<bigint, BlockHeader>();
    const header = async (n: bigint) => {
      let h = headers.get(n);
      if (!h) {
        h = await this.src.getBlock(n);
        headers.set(n, h);
      }
      return h;
    };
    for (const l of logs) {
      const h = await header(l.blockNumber!);
      if (l.blockHash && l.blockHash.toLowerCase() !== h.hash.toLowerCase()) {
        throw new Error(`log ${l.transactionHash}:${l.logIndex} is from a non-canonical block; retrying later`);
      }
    }
    const end = await header(to);

    const outbox: Publish[] = [];
    try {
      await this.db.transaction(async (tx) => {
        for (const l of logs) await this.apply(tx, l, (await header(l.blockNumber!)).timestamp, outbox);
        for (const h of headers.values()) {
          await tx
            .insert(indexedBlocks)
            .values({ chainId: this.cfg.chainId, number: h.number, hash: buf(h.hash), parentHash: buf(h.parentHash), timestamp: new Date(Number(h.timestamp) * 1000) })
            .onConflictDoNothing();
        }
        await tx
          .insert(chainCursors)
          .values({ chainId: this.cfg.chainId, contract: this.cfg.escrow, lastBlock: to, lastBlockHash: buf(end.hash) })
          .onConflictDoUpdate({
            target: [chainCursors.chainId, chainCursors.contract],
            set: { lastBlock: to, lastBlockHash: buf(end.hash), updatedAt: new Date() },
          });
      });
    } catch (err) {
      this.ledger.reset();
      throw err;
    }

    for (const p of outbox) {
      try {
        await publishDesk(this.bus, p.channel, p.type, p.data);
      } catch (err) {
        this.log.warn({ err, channel: p.channel }, "publish failed (state is committed; clients will catch up on reconnect)");
      }
    }
    this.log.info({ from: from.toString(), to: to.toString(), logs: logs.length }, "indexed");
    return Number(to - from + 1n);
  }

  /** Run until stopped. Backs off on errors; halts on deep reorgs. */
  async run(signal: AbortSignal, pollMs: number): Promise<void> {
    let backoff = pollMs;
    while (!signal.aborted) {
      try {
        const advanced = await this.tick();
        backoff = pollMs;
        if (advanced === 0) await sleep(pollMs, signal);
      } catch (err) {
        if (err instanceof DeepReorgError) {
          this.log.fatal({ err }, "deep reorg: indexer halted, manual intervention required");
          throw err;
        }
        this.log.error({ err }, "indexer batch failed; retrying");
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  // ------------------------------------------------------------------------------------------

  private async dealRow(tx: Tx, dealId: Hex) {
    const [d] = await tx.select().from(deals).where(eq(deals.dealId, buf(dealId)));
    return d ?? null;
  }

  private async event(tx: Tx, dealId: Hex, kind: string, l: Log, payload: Record<string, unknown>) {
    await tx
      .insert(dealEvents)
      .values({
        dealId: buf(dealId),
        kind,
        source: "chain",
        chainId: this.cfg.chainId,
        txHash: buf(l.transactionHash!),
        logIndex: Number(l.logIndex),
        blockNumber: l.blockNumber!,
        payload,
      })
      .onConflictDoNothing();
  }

  /** Seller payout and referrer come from our DB, or from the settlement calldata for deals made elsewhere. */
  private async payoutParties(dealId: Hex, l: Log, dbRow: { sellerPayout: string; referrer: string | null } | null) {
    if (dbRow) return { sellerPayout: dbRow.sellerPayout, referrer: dbRow.referrer };
    const input = await this.src.getTransactionInput(l.transactionHash!);
    if (input) {
      try {
        const call = decodeFunctionData({ abi: otcEscrowAbi, data: input });
        const terms = (call.args as readonly unknown[] | undefined)?.[0] as { sellerPayout?: string; referrer?: string } | undefined;
        if (terms?.sellerPayout) {
          return { sellerPayout: terms.sellerPayout, referrer: terms.referrer && terms.referrer !== ZERO ? terms.referrer : null };
        }
      } catch {
        /* not a direct escrow call (e.g. through a multicall) */
      }
    }
    this.log.warn({ dealId }, "unknown deal: attributing payout to external:unknown");
    return { sellerPayout: "unknown", referrer: "unknown" };
  }

  private async apply(tx: Tx, l: Log, blockTs: bigint, outbox: Publish[]) {
    const address = lc(l.address);
    const at = new Date(Number(blockTs) * 1000);
    const ref = (dealId: Hex | null, description: string) => ({
      txHash: l.transactionHash!,
      logIndex: Number(l.logIndex),
      blockNumber: l.blockNumber!,
      dealId,
      description,
    });

    if (address === this.cfg.vault) {
      let ev;
      try {
        ev = decodeEventLog({ abi: buyBurnVaultAbi, data: l.data, topics: l.topics });
      } catch {
        return;
      }
      if (ev.eventName === "Burned") {
        const a = ev.args;
        await tx
          .insert(burns)
          .values({
            chainId: this.cfg.chainId,
            txHash: buf(l.transactionHash!),
            logIndex: Number(l.logIndex),
            ts: at,
            payToken: lc(a.payToken),
            amountIn: a.amountIn.toString(),
            amountBurned: a.amountBurned.toString(),
            route: lc(a.route),
          })
          .onConflictDoNothing();
        await this.ledger.post(tx, ref(null, "Burned"), [
          { account: "vault:fees", asset: lc(a.payToken), direction: "credit", amount: a.amountIn },
          { account: ext(a.route), asset: lc(a.payToken), direction: "debit", amount: a.amountIn },
        ]);
      } else if (ev.eventName === "RouteQueued" || ev.eventName === "RouteActivated" || ev.eventName === "RouteCancelled") {
        this.log.warn({ event: ev.eventName, args: ev.args }, "burn route change");
      }
      return;
    }

    if (address !== this.cfg.escrow) return;
    let ev;
    try {
      ev = decodeEventLog({ abi: otcEscrowAbi, data: l.data, topics: l.topics });
    } catch {
      return;
    }

    switch (ev.eventName) {
      case "FeeBurned": {
        // Deal paid in the platform token: the protocol's share went straight to 0x…dEaD in the
        // settlement transaction. "Settled" books every fee share to vault:fees; move this one
        // to "burned", and count it with the vault's burns so the stats show one total.
        const a = ev.args;
        await tx
          .insert(burns)
          .values({
            chainId: this.cfg.chainId,
            txHash: buf(l.transactionHash!),
            logIndex: Number(l.logIndex),
            ts: at,
            payToken: lc(a.token),
            amountIn: a.amount.toString(),
            amountBurned: a.amount.toString(),
            route: this.cfg.escrow,
          })
          .onConflictDoNothing();
        await this.ledger.post(tx, ref(null, "FeeBurned"), [
          { account: "vault:fees", asset: lc(a.token), direction: "credit", amount: a.amount },
          { account: "burned", asset: lc(a.token), direction: "debit", amount: a.amount },
        ]);
        break;
      }

      case "PaymentLocked": {
        const a = ev.args;
        const d = await this.dealRow(tx, a.dealId);
        if (d) {
          if (d.status === "accepted") {
            await tx
              .update(deals)
              .set({ status: "payment_locked", paymentLockedAt: at, paymentTx: buf(l.transactionHash!) })
              .where(eq(deals.dealId, d.dealId));
          }
          await this.event(tx, a.dealId, "PaymentLocked", l, { payer: lc(a.payer) });
          outbox.push(
            { channel: `rfq:${d.rfqId}`, type: "payment.locked", data: { dealId: a.dealId, txHash: l.transactionHash } },
            { channel: `quote:${d.quoteId}`, type: "payment.locked", data: { dealId: a.dealId, txHash: l.transactionHash } },
          );
        }
        await this.ledger.post(tx, ref(d ? a.dealId : null, "PaymentLocked"), [
          { account: "escrow:locked", asset: lc(a.payToken), direction: "debit", amount: a.price },
          { account: ext(a.payer), asset: lc(a.payToken), direction: "credit", amount: a.price },
        ]);
        break;
      }

      case "Settled": {
        const a = ev.args;
        const d = await this.dealRow(tx, a.dealId);
        const parties = await this.payoutParties(a.dealId, l, d);
        const pay = lc(a.payToken);
        const vaultFee = a.fee - a.referrerFee;
        const sellerNet = a.price - a.fee - a.relayerFee;
        const lines: Line[] = [
          { account: "escrow:locked", asset: pay, direction: "credit", amount: a.price },
          { account: ext(parties.sellerPayout), asset: pay, direction: "debit", amount: sellerNet },
          { account: "vault:fees", asset: pay, direction: "debit", amount: vaultFee },
          { account: ext(parties.referrer ?? "unknown"), asset: pay, direction: "debit", amount: a.referrerFee },
          { account: ext(a.relayer), asset: pay, direction: "debit", amount: a.relayerFee },
          // Token leg passes through the escrow atomically: seller -> buyer.
          { account: ext(a.buyer), asset: lc(a.token), direction: "debit", amount: a.amount },
          { account: ext(a.seller), asset: lc(a.token), direction: "credit", amount: a.amount },
        ];
        // Journals link to a deal only when we know it (deals made elsewhere still balance the ledger).
        await this.ledger.post(tx, ref(d ? a.dealId : null, "Settled"), lines);

        const priceUsd = pay === this.cfg.stable ? fmtUnits(a.price, this.cfg.stableDecimals) : null;
        const feeUsd = pay === this.cfg.stable ? fmtUnits(a.fee, this.cfg.stableDecimals) : null;
        await tx
          .insert(settlementTicks)
          .values({
            ts: at,
            dealId: buf(a.dealId),
            chainId: this.cfg.chainId,
            tokenAddress: lc(a.token),
            payToken: pay,
            price: a.price.toString(),
            fee: a.fee.toString(),
            priceUsd,
            feeUsd,
          })
          .onConflictDoNothing();

        if (d) {
          if (d.status === "accepted") {
            await tx.update(deals).set({ status: "payment_locked", paymentLockedAt: at }).where(eq(deals.dealId, d.dealId));
          }
          if (d.status !== "settled") {
            await tx
              .update(deals)
              .set({
                status: "settled",
                settledAt: at,
                settleTx: buf(l.transactionHash!),
                settleBlock: l.blockNumber!,
                fee: a.fee.toString(),
                referrerFee: a.referrerFee.toString(),
                relayer: lc(a.relayer) === ZERO ? null : lc(a.relayer),
                priceUsd,
              })
              .where(eq(deals.dealId, d.dealId));
          } else if (d.priceUsd === null && priceUsd !== null) {
            await tx.update(deals).set({ priceUsd }).where(eq(deals.dealId, d.dealId));
          }
          await this.event(tx, a.dealId, "Settled", l, { fee: a.fee.toString(), relayer: lc(a.relayer) });
          const data = { dealId: a.dealId, txHash: l.transactionHash };
          outbox.push(
            { channel: `rfq:${d.rfqId}`, type: "deal.settled", data },
            { channel: `quote:${d.quoteId}`, type: "deal.settled", data },
          );
        }
        break;
      }

      case "Refunded": {
        const a = ev.args;
        const d = await this.dealRow(tx, a.dealId);
        await this.ledger.post(tx, ref(d ? a.dealId : null, "Refunded"), [
          { account: "escrow:locked", asset: lc(a.payToken), direction: "credit", amount: a.price },
          { account: ext(a.buyer), asset: lc(a.payToken), direction: "debit", amount: a.price },
        ]);
        if (d) {
          if (d.status === "accepted") {
            await tx.update(deals).set({ status: "payment_locked", paymentLockedAt: at }).where(eq(deals.dealId, d.dealId));
          }
          if (d.status !== "refunded") {
            await tx
              .update(deals)
              .set({ status: "refunded", refundedAt: at, refundTx: buf(l.transactionHash!) })
              .where(eq(deals.dealId, d.dealId));
          }
          await this.event(tx, a.dealId, "Refunded", l, {});
          outbox.push(
            { channel: `rfq:${d.rfqId}`, type: "deal.refunded", data: { dealId: a.dealId } },
            { channel: `quote:${d.quoteId}`, type: "deal.refunded", data: { dealId: a.dealId } },
          );
        }
        break;
      }

      case "PayoutDeferred": {
        // The escrow kept a payout it could not push: reclassify it from "paid out" to "owed".
        const a = ev.args;
        await this.ledger.post(tx, ref(null, "PayoutDeferred"), [
          { account: "escrow:owed", asset: lc(a.payToken), direction: "debit", amount: a.amount },
          { account: ext(a.account), asset: lc(a.payToken), direction: "credit", amount: a.amount },
        ]);
        break;
      }

      case "Claimed": {
        const a = ev.args;
        await this.ledger.post(tx, ref(null, "Claimed"), [
          { account: "escrow:owed", asset: lc(a.payToken), direction: "credit", amount: a.amount },
          { account: ext(a.to), asset: lc(a.payToken), direction: "debit", amount: a.amount },
        ]);
        break;
      }
    }
  }
}

export function fmtUnits(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).slice(0, 6).padEnd(6, "0");
  return `${int}.${frac}`;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
