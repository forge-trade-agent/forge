/**
 * Double-entry mirror of what the contracts hold, built only from chain events.
 *
 * Accounts (per chain, per asset):
 *   escrow:locked          payments locked in the escrow             (debit-positive asset)
 *   escrow:owed            deferred payouts still held by the escrow (debit-positive asset)
 *   vault:fees             fees held by the buy-and-burn vault       (debit-positive asset)
 *   burned                 fees in the platform token the escrow sent to 0x…dEaD at settlement
 *   external:<address>     the outside world (wallets, routes)       (contra accounts)
 *
 * Invariants checked by the reconciliation job:
 *   escrow balance(asset) == escrow:locked + escrow:owed
 *   vault balance(asset)  >= vault:fees   (anyone may send the vault extra)
 */
import { and, eq } from "drizzle-orm";
import { ledgerAccounts, ledgerJournals, ledgerPostings, type AnyDb } from "@sealdesk/db";
import type { Hex } from "@sealdesk/shared";

export type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];

export interface Line {
  account: string;
  asset: Hex;
  direction: "debit" | "credit";
  amount: bigint;
}

export class Ledger {
  private ids = new Map<string, number>();
  private readonly chainId: number;
  constructor(chainId: number) {
    this.chainId = chainId;
  }

  private async accountId(tx: Tx, code: string, asset: Hex): Promise<number> {
    const k = `${code}|${asset}`;
    const hit = this.ids.get(k);
    if (hit) return hit;
    await tx.insert(ledgerAccounts).values({ chainId: this.chainId, code, asset }).onConflictDoNothing();
    const [row] = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.chainId, this.chainId), eq(ledgerAccounts.code, code), eq(ledgerAccounts.asset, asset)));
    this.ids.set(k, row!.id);
    return row!.id;
  }

  /**
   * Post one journal for a chain log. Idempotent: a log that was already journaled is skipped.
   * Zero-amount lines are dropped. Balance is enforced by a deferred DB trigger at commit.
   */
  async post(
    tx: Tx,
    ref: { txHash: Hex; logIndex: number; blockNumber: bigint; dealId: Hex | null; description: string },
    lines: Line[],
  ): Promise<boolean> {
    const nonZero = lines.filter((l) => l.amount > 0n);
    if (nonZero.length === 0) return false;
    const [j] = await tx
      .insert(ledgerJournals)
      .values({
        chainId: this.chainId,
        dealId: ref.dealId ? Buffer.from(ref.dealId.slice(2), "hex") : null,
        txHash: Buffer.from(ref.txHash.slice(2), "hex"),
        logIndex: ref.logIndex,
        blockNumber: ref.blockNumber,
        description: ref.description,
      })
      .onConflictDoNothing()
      .returning({ id: ledgerJournals.id });
    if (!j) return false;
    for (const l of nonZero) {
      await tx.insert(ledgerPostings).values({
        journalId: j.id,
        accountId: await this.accountId(tx, l.account, l.asset),
        direction: l.direction,
        amount: l.amount.toString(),
      });
    }
    return true;
  }

  /** Forget cached account ids (after a rolled-back transaction). */
  reset() {
    this.ids.clear();
  }
}

export const ext = (a: string) => `external:${a.toLowerCase()}`;
