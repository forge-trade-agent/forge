/**
 * Exposure check for Ghost mode: which public on-chain hops link a one-time wallet back to the
 * wallets you call yours. Reads public chain data only (token Transfer logs, nonce, balance and the
 * deal terms, which become public at settlement) and never sends your addresses anywhere but the
 * RPC you already use.
 *
 * What it can see: ERC-20 transfers into and out of the one-time wallet, direct transfers between
 * those counterparties and your wallets (two hops), and the payout address in the terms.
 * What it can't: native ETH transfers (they leave no logs), exchange deposit addresses, timing and
 * amount patterns. A clean result means "no link found in these places", not "unlinkable".
 */
import { parseAbiItem, type PublicClient } from "viem";
import type { Hex, Terms } from "./types.ts";

export interface TransferLog {
  token: Hex;
  from: Hex;
  to: Hex;
  value: bigint;
  block: bigint;
  tx: Hex;
}

/** The chain reads the check needs. `viemExposureReader` adapts a viem PublicClient. */
export interface ExposureReader {
  latestBlock(): Promise<bigint>;
  /** First block at or after a unix time (seconds). */
  blockAt(unixSeconds: number): Promise<bigint>;
  /** ERC-20 Transfer logs on any token, filtered by sender and/or recipient. `partial` if the range was cut short. */
  transfers(q: { from?: Hex; to?: Hex; fromBlock: bigint; toBlock: bigint }): Promise<{ logs: TransferLog[]; partial: boolean }>;
  nonce(address: Hex): Promise<number>;
  ethBalance(address: Hex): Promise<bigint>;
}

export type ExposureLevel = "exposed" | "weak" | "clean";

export interface ExposureFinding {
  /** direct: one public hop to your wallet. indirect: two hops. info: worth knowing. ok: checked, fine. */
  severity: "direct" | "indirect" | "info" | "ok";
  title: string;
  detail: string;
  /** The public path, starting at your wallet and ending at the one-time wallet. */
  path?: Hex[];
  tx?: Hex;
}

export interface ExposureInput {
  /** The one-time wallet (terms.seller on a Ghost-mode deal). */
  oneTime: Hex;
  /** Deal terms, if a deal exists. The payout address in them becomes public at settlement. */
  terms?: Terms | null;
  /** Wallets that are yours: the connected wallet and any you add. */
  mine: Hex[];
  /** When the one-time wallet was created (the answer's time); nothing before it can involve it. */
  since: Date;
  /** Contracts and services to skip as counterparties: the escrow, the relayer. */
  ignore?: Hex[];
  /** How far before `since` to look for transfers between a counterparty and your wallets. */
  lookbackDays?: number;
}

export interface ExposureReport {
  level: ExposureLevel;
  findings: ExposureFinding[];
  scanned: { fromBlock: string; toBlock: string; since: string; lookbackDays: number; partial: boolean };
}

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase() as Hex;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function checkExposure(reader: ExposureReader, input: ExposureInput): Promise<ExposureReport> {
  const oneTime = lc(input.oneTime);
  const mine = new Set(input.mine.map(lc).filter((a) => a !== oneTime));
  const ignore = new Set([ZERO, ...(input.ignore ?? []).map(lc)]);
  const lookbackDays = input.lookbackDays ?? 7;
  const sinceSec = Math.floor(input.since.getTime() / 1000);

  const toBlock = await reader.latestBlock();
  // The key was generated when the answer was sent: a little slack for clock drift is enough.
  const fromBlock = await reader.blockAt(sinceSec - 600);
  const lookFrom = await reader.blockAt(sinceSec - lookbackDays * 86_400);
  let partial = false;

  const findings: ExposureFinding[] = [];

  /** Transfers between `addr` and any of your wallets, in either direction. */
  const linkToMine = async (addr: Hex): Promise<{ wallet: Hex; tx: Hex } | null> => {
    for (const m of mine) {
      for (const q of [{ from: m, to: addr }, { from: addr, to: m }]) {
        const r = await reader.transfers({ ...q, fromBlock: lookFrom, toBlock });
        partial ||= r.partial;
        if (r.logs[0]) return { wallet: m, tx: r.logs[0].tx };
      }
    }
    return null;
  };

  // 1. Payout address: public in the settlement transaction.
  const t = input.terms;
  if (t && lc(t.seller) === oneTime) {
    const payout = lc(t.sellerPayout);
    if (mine.has(payout)) {
      findings.push({
        severity: "direct",
        title: "Payment goes to your main wallet",
        detail: `The deal pays ${short(payout)}, which is yours. The terms, payout included, are public once the deal settles, so anyone can connect this one-time wallet to it. Next time, set a fresh payout address in Ghost mode.`,
        path: [payout, oneTime],
      });
    } else if (payout === oneTime) {
      findings.push({ severity: "info", title: "Payment stays in the one-time wallet", detail: "Nothing links yet. Moving it straight to your main wallet later would create the link." });
    } else if (mine.size) {
      const l = await linkToMine(payout);
      findings.push(
        l
          ? { severity: "indirect", title: "Payout address has traded with your wallet", detail: `The deal pays ${short(payout)}, which has a token transfer with ${short(l.wallet)}. Two public hops link them.`, path: [l.wallet, payout, oneTime], tx: l.tx }
          : { severity: "ok", title: "Payout address", detail: `Pays ${short(payout)}. No transfer between it and your wallets in the last ${lookbackDays} days.` },
      );
    }
  }

  // 2. Who funded the one-time wallet, and where its tokens went.
  const [inbound, outbound] = await Promise.all([
    reader.transfers({ to: oneTime, fromBlock, toBlock }),
    reader.transfers({ from: oneTime, fromBlock, toBlock }),
  ]);
  partial ||= inbound.partial || outbound.partial;

  const check = async (logs: TransferLog[], dir: "in" | "out") => {
    const seen = new Set<Hex>();
    for (const log of logs) {
      const other = lc(dir === "in" ? log.from : log.to);
      if (ignore.has(other) || other === oneTime || seen.has(other)) continue;
      seen.add(other);
      if (mine.has(other)) {
        findings.push({
          severity: "direct",
          title: dir === "in" ? "Funded straight from your wallet" : "Tokens sent back to your wallet",
          detail: dir === "in"
            ? `${short(other)} sent tokens to the one-time wallet. That transfer is public and links the two.`
            : `The one-time wallet sent tokens to ${short(other)}. That transfer is public and links the two.`,
          path: [other, oneTime],
          tx: log.tx,
        });
        continue;
      }
      const l = mine.size ? await linkToMine(other) : null;
      findings.push(
        l
          ? {
              severity: "indirect",
              title: dir === "in" ? "Funded by an address linked to you" : "Sent to an address linked to you",
              detail: `${short(other)} ${dir === "in" ? "funded the one-time wallet" : "received from the one-time wallet"} and has a token transfer with ${short(l.wallet)}. Two public hops link them.`,
              path: [l.wallet, other, oneTime],
              tx: l.tx,
            }
          : {
              severity: "ok",
              title: dir === "in" ? "Funding source" : "Outgoing transfer",
              detail: `${dir === "in" ? "Funded by" : "Sent to"} ${short(other)}. No transfer between it and your wallets in the last ${lookbackDays} days.`,
              tx: log.tx,
            },
      );
    }
  };
  await check(inbound.logs, "in");
  await check(outbound.logs, "out");
  if (inbound.logs.length === 0) {
    findings.push({ severity: "info", title: "Not funded yet", detail: "The one-time wallet hasn't received any tokens. Fund it from an address with no direct link to you." });
  }

  // 3. Native ETH: no logs, so we can only tell that it happened.
  const [nonce, eth] = await Promise.all([reader.nonce(oneTime), reader.ethBalance(oneTime)]);
  if (nonce > 0 || eth > 0n) {
    findings.push({
      severity: "info",
      title: nonce > 0 ? `Sent ${nonce} transaction${nonce > 1 ? "s" : ""} itself` : "Holds ETH",
      detail: "So someone sent it ETH. Native ETH transfers don't show in token logs: check who sent it on the block explorer. Ghost mode needs no ETH; the relayer pays gas.",
    });
  }

  if (!mine.size) {
    findings.push({ severity: "info", title: "No wallet to compare with", detail: "Connect your main wallet or add your addresses to see whether anything links back to them." });
  }

  const level: ExposureLevel = findings.some((f) => f.severity === "direct") ? "exposed" : findings.some((f) => f.severity === "indirect") ? "weak" : "clean";
  const order = { direct: 0, indirect: 1, info: 2, ok: 3 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    level,
    findings,
    scanned: { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), since: input.since.toISOString(), lookbackDays, partial },
  };
}

// ---------------------------------------------------------------- viem adapter

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/**
 * Reads through a viem PublicClient. Log ranges the RPC refuses are split in half until they fit,
 * up to `maxRequests` calls per query; past that the result is marked partial.
 */
export function viemExposureReader(pub: PublicClient, opts: { maxRequests?: number } = {}): ExposureReader {
  const maxRequests = opts.maxRequests ?? 48;
  return {
    // cacheTime 0: a cached head would miss transfers made seconds ago.
    latestBlock: () => pub.getBlockNumber({ cacheTime: 0 }),
    async blockAt(ts) {
      let hi = await pub.getBlockNumber({ cacheTime: 0 });
      const top = await pub.getBlock({ blockNumber: hi });
      if (Number(top.timestamp) <= ts) return hi;
      let lo = 0n;
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        const b = await pub.getBlock({ blockNumber: mid });
        if (Number(b.timestamp) < ts) lo = mid + 1n;
        else hi = mid;
      }
      return lo;
    },
    async transfers(q) {
      let requests = 0;
      let partial = false;
      const out: TransferLog[] = [];
      const run = async (from: bigint, to: bigint): Promise<void> => {
        if (from > to) return;
        if (requests >= maxRequests) {
          partial = true;
          return;
        }
        requests++;
        try {
          const logs = await pub.getLogs({
            event: transferEvent,
            args: { ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) },
            fromBlock: from,
            toBlock: to,
          });
          for (const l of logs) {
            if (!l.args.from || !l.args.to || l.args.value === undefined || l.blockNumber === null || l.transactionHash === null) continue;
            out.push({ token: lc(l.address), from: lc(l.args.from), to: lc(l.args.to), value: l.args.value, block: l.blockNumber, tx: l.transactionHash });
          }
        } catch (err) {
          if (to === from) throw err;
          const mid = (from + to) / 2n;
          await run(from, mid);
          await run(mid + 1n, to);
        }
      };
      await run(q.fromBlock, q.toBlock);
      out.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
      return { logs: out, partial };
    },
    nonce: (a) => pub.getTransactionCount({ address: a }),
    ethBalance: (a) => pub.getBalance({ address: a }),
  };
}
