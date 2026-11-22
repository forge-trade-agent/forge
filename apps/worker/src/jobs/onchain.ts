/**
 * On-chain checks: nightly ledger reconciliation and the buy-and-burn tracker.
 */
import { erc20Abi, type PublicClient } from "viem";
import { and, eq, inArray } from "drizzle-orm";
import { ledgerAccounts, ledgerPostings, type AnyDb } from "@sealdesk/db";
import { buyBurnVaultAbi, otcEscrowAbi, type Cache, type Hex, type Logger } from "@sealdesk/shared";

export const DEAD = "0x000000000000000000000000000000000000dead" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

export interface ContractsReader {
  balanceOf(token: Hex, owner: Hex): Promise<bigint>;
  escrowTotals(asset: Hex): Promise<{ locked: bigint; owed: bigint }>;
  vault(): Promise<{ route: Hex; pendingRoute: Hex; pendingEta: bigint; totalBurned: bigint }>;
}

export class ViemContractsReader implements ContractsReader {
  private readonly c: PublicClient;
  private readonly escrow: Hex;
  private readonly vaultAddr: Hex;
  constructor(c: PublicClient, escrow: Hex, vault: Hex) {
    this.c = c;
    this.escrow = escrow;
    this.vaultAddr = vault;
  }
  balanceOf(token: Hex, owner: Hex) {
    return token === ZERO
      ? this.c.getBalance({ address: owner })
      : this.c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  }
  async escrowTotals(asset: Hex) {
    const [locked, owed] = await Promise.all([
      this.c.readContract({ address: this.escrow, abi: otcEscrowAbi, functionName: "totalLocked", args: [asset] }),
      this.c.readContract({ address: this.escrow, abi: otcEscrowAbi, functionName: "totalOwed", args: [asset] }),
    ]);
    return { locked, owed };
  }
  async vault() {
    const read = <F extends "route" | "pendingRoute" | "pendingEta" | "totalBurned">(functionName: F) =>
      this.c.readContract({ address: this.vaultAddr, abi: buyBurnVaultAbi, functionName });
    const [route, pendingRoute, pendingEta, totalBurned] = await Promise.all([
      read("route"), read("pendingRoute"), read("pendingEta"), read("totalBurned"),
    ]);
    return { route: route.toLowerCase() as Hex, pendingRoute: pendingRoute.toLowerCase() as Hex, pendingEta: BigInt(pendingEta), totalBurned };
  }
}

async function ledgerBalance(db: AnyDb, chainId: number, code: string, asset: Hex): Promise<bigint> {
  const accts = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.chainId, chainId), eq(ledgerAccounts.code, code), eq(ledgerAccounts.asset, asset)));
  if (accts.length === 0) return 0n;
  const rows = await db
    .select({ d: ledgerPostings.direction, a: ledgerPostings.amount })
    .from(ledgerPostings)
    .where(inArray(ledgerPostings.accountId, accts.map((x) => x.id)));
  return rows.reduce((s, r) => s + (r.d === "debit" ? BigInt(r.a) : -BigInt(r.a)), 0n);
}

export interface ReconcileReport {
  ok: boolean;
  checkedAt: string;
  assets: {
    asset: Hex;
    escrowOnChain: string;
    escrowContractTotals: string;
    escrowLedger: string;
    vaultOnChain: string;
    vaultLedger: string;
    problems: string[];
  }[];
}

/**
 * Three-way check per pay asset:
 *   on-chain escrow balance == contract totalLocked + totalOwed == ledger escrow:locked + escrow:owed
 *   on-chain vault balance  >= ledger vault:fees (anyone may send the vault extra)
 * Note: on-chain balances are read at "latest" while the ledger lags by the confirmation depth,
 * so a mismatch is only an incident if it persists across runs.
 */
export async function reconcile(
  db: AnyDb,
  reader: ContractsReader,
  opts: { chainId: number; escrow: Hex; vault: Hex; assets: Hex[]; now: Date; log: Logger; cache: Cache },
): Promise<ReconcileReport> {
  const report: ReconcileReport = { ok: true, checkedAt: opts.now.toISOString(), assets: [] };
  for (const asset of opts.assets) {
    const [escrowOnChain, totals, locked, owed, vaultOnChain, vaultLedger] = await Promise.all([
      reader.balanceOf(asset, opts.escrow),
      reader.escrowTotals(asset),
      ledgerBalance(db, opts.chainId, "escrow:locked", asset),
      ledgerBalance(db, opts.chainId, "escrow:owed", asset),
      reader.balanceOf(asset, opts.vault),
      ledgerBalance(db, opts.chainId, "vault:fees", asset),
    ]);
    const contractTotals = totals.locked + totals.owed;
    const escrowLedger = locked + owed;
    const problems: string[] = [];
    if (escrowOnChain !== contractTotals) problems.push("escrow balance differs from contract totals (contract invariant broken!)");
    if (escrowLedger !== contractTotals) problems.push("ledger differs from escrow contract totals");
    if (vaultOnChain < vaultLedger) problems.push("vault holds less than the ledger says it received");
    if (problems.length) report.ok = false;
    report.assets.push({
      asset,
      escrowOnChain: escrowOnChain.toString(),
      escrowContractTotals: contractTotals.toString(),
      escrowLedger: escrowLedger.toString(),
      vaultOnChain: vaultOnChain.toString(),
      vaultLedger: vaultLedger.toString(),
      problems,
    });
  }
  if (report.ok) opts.log.info({ report }, "reconciliation ok");
  else opts.log.error({ report }, "RECONCILIATION MISMATCH");
  await opts.cache.set(`reconcile:${opts.chainId}`, report, 7 * 86_400);
  return report;
}

export interface BurnState {
  vault: Hex;
  route: Hex | null;
  queued: { route: Hex; eta: string; activatableNow: boolean } | null;
  totalBurnedByVault: string;
  atDeadAddress: string;
  feesWaiting: { asset: Hex; amount: string }[];
  updatedAt: string;
}

export async function trackBurn(
  reader: ContractsReader,
  cache: Cache,
  opts: { chainId: number; vault: Hex; platformToken: Hex; assets: Hex[]; now: Date },
): Promise<BurnState> {
  const v = await reader.vault();
  const [atDead, ...waiting] = await Promise.all([
    reader.balanceOf(opts.platformToken, DEAD),
    ...opts.assets.map((a) => reader.balanceOf(a, opts.vault)),
  ]);
  const state: BurnState = {
    vault: opts.vault,
    route: v.route === ZERO ? null : v.route,
    queued:
      v.pendingRoute === ZERO
        ? null
        : {
            route: v.pendingRoute,
            eta: new Date(Number(v.pendingEta) * 1000).toISOString(),
            activatableNow: BigInt(Math.floor(opts.now.getTime() / 1000)) >= v.pendingEta,
          },
    totalBurnedByVault: v.totalBurned.toString(),
    atDeadAddress: atDead!.toString(),
    feesWaiting: opts.assets.map((asset, i) => ({ asset, amount: waiting[i]!.toString() })),
    updatedAt: opts.now.toISOString(),
  };
  await cache.set(`burn:${opts.chainId}`, state, 3600);
  return state;
}

// ------------------------------------------------------------------------------------------
// Live control panel: who controls what, read from the chain (never written by hand).
// ------------------------------------------------------------------------------------------

export interface ControlRole { address: Hex; kind: "contract" | "key" | "none" }
export interface ControlState {
  chainId: number;
  escrow: {
    address: Hex;
    deployed: boolean;
    adminKeys: 0;
    maxFeeBps: number;
    feeVault: Hex;
    locked: { asset: Hex; amount: string }[];
    owed: { asset: Hex; amount: string }[];
  };
  vault: {
    address: Hex;
    governor: ControlRole;
    keeper: ControlRole;
    routeDelaySec: number;
    route: Hex | null;
    queued: { route: Hex; eta: string; activatableNow: boolean } | null;
    fees: { asset: Hex; amount: string }[];
    totalBurned: string;
  };
  burnToken: { address: Hex; atDeadAddress: string };
  stable: Hex;
  relayer: { address: Hex; ethBalance: string } | null;
  readAt: string;
}

/**
 * Reads every role and balance the Security page shows. Each field comes from a contract call
 * or a balance on the configured chain; the only inputs are the deployment addresses.
 */
export async function trackControl(
  c: PublicClient,
  cache: Cache,
  opts: { chainId: number; escrow: Hex; vault: Hex; stable: Hex; platformToken: Hex; relayer: Hex | null; now: Date },
): Promise<ControlState> {
  const assets = [ZERO, opts.stable];
  const bal = (token: Hex, owner: Hex) =>
    token === ZERO ? c.getBalance({ address: owner }) : c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  const role = async (address: Hex): Promise<ControlRole> => {
    if (address === ZERO) return { address, kind: "none" };
    const code = await c.getCode({ address });
    return { address: address.toLowerCase() as Hex, kind: code && code !== "0x" ? "contract" : "key" };
  };
  const esc = <F extends "MAX_FEE_BPS" | "FEE_VAULT">(functionName: F) => c.readContract({ address: opts.escrow, abi: otcEscrowAbi, functionName });
  const vlt = <F extends "GOVERNOR" | "KEEPER" | "ROUTE_DELAY" | "route" | "pendingRoute" | "pendingEta" | "totalBurned">(functionName: F) =>
    c.readContract({ address: opts.vault, abi: buyBurnVaultAbi, functionName });

  const [code, maxFeeBps, feeVault, governor, keeper, delay, route, pendingRoute, pendingEta, totalBurned, atDead] = await Promise.all([
    c.getCode({ address: opts.escrow }),
    esc("MAX_FEE_BPS"), esc("FEE_VAULT"),
    vlt("GOVERNOR"), vlt("KEEPER"), vlt("ROUTE_DELAY"), vlt("route"), vlt("pendingRoute"), vlt("pendingEta"), vlt("totalBurned"),
    bal(opts.platformToken, DEAD),
  ]);
  const [locked, owed, fees, gov, kp, relayerEth] = await Promise.all([
    Promise.all(assets.map((a) => c.readContract({ address: opts.escrow, abi: otcEscrowAbi, functionName: "totalLocked", args: [a] }))),
    Promise.all(assets.map((a) => c.readContract({ address: opts.escrow, abi: otcEscrowAbi, functionName: "totalOwed", args: [a] }))),
    Promise.all(assets.map((a) => bal(a, opts.vault))),
    role(governor as Hex),
    role(keeper as Hex),
    opts.relayer ? c.getBalance({ address: opts.relayer }) : Promise.resolve(null),
  ]);
  const pr = (pendingRoute as string).toLowerCase() as Hex;
  const eta = BigInt(pendingEta);
  const state: ControlState = {
    chainId: opts.chainId,
    escrow: {
      address: opts.escrow,
      deployed: !!code && code !== "0x",
      adminKeys: 0,
      maxFeeBps: Number(maxFeeBps),
      feeVault: (feeVault as string).toLowerCase() as Hex,
      locked: assets.map((asset, i) => ({ asset, amount: locked[i]!.toString() })),
      owed: assets.map((asset, i) => ({ asset, amount: owed[i]!.toString() })),
    },
    vault: {
      address: opts.vault,
      governor: gov,
      keeper: kp,
      routeDelaySec: Number(delay),
      route: (route as string).toLowerCase() === ZERO ? null : ((route as string).toLowerCase() as Hex),
      queued: pr === ZERO ? null : { route: pr, eta: new Date(Number(eta) * 1000).toISOString(), activatableNow: BigInt(Math.floor(opts.now.getTime() / 1000)) >= eta },
      fees: assets.map((asset, i) => ({ asset, amount: fees[i]!.toString() })),
      totalBurned: (totalBurned as bigint).toString(),
    },
    burnToken: { address: opts.platformToken, atDeadAddress: atDead.toString() },
    stable: opts.stable,
    relayer: opts.relayer && relayerEth !== null ? { address: opts.relayer, ethBalance: relayerEth.toString() } : null,
    readAt: opts.now.toISOString(),
  };
  await cache.set(`control:${opts.chainId}`, state, 600);
  return state;
}
