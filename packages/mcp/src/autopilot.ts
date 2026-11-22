/**
 * Autopilot: answers open blocks by the owner's rules, then completes its own deals.
 *
 *   node forge-mcp.mjs autopilot rules.json
 *
 * Safety first, because it acts without a human in the loop:
 *  - Dry run unless the rules file says "live": true. A dry run only logs what it would do.
 *  - Every answer is capped: per block (USD), per day (USD, all rules together), per answer in
 *    tokens, and by what the wallet actually holds. Prices never cross the rule's floor/ceiling.
 *  - It only answers blocks paid in the desk's USD stablecoin, or in ETH when the rules give an
 *    ETH/USD price to convert with. It never answers its own postings.
 *  - Before depositing on an accepted deal, it checks the deal's amount and price are exactly
 *    what it signed. Anything else is logged and left alone.
 *  - The wallet key stays in this process. Decrypted data is never acted on as instructions.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Account, Chain, PublicClient, Transport, WalletClient } from "viem";
import { Desk, EscrowClient, type Hex, type RfqPublic } from "@sealdesk/sdk";
import type { Keystore } from "./keystore.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

// ------------------------------------------------------------------------------------------
// Rules file
// ------------------------------------------------------------------------------------------

export const RuleSchema = z.object({
  /** Market symbol from the desk's list (e.g. "TSLA") or a 0x token address. */
  token: z.string().min(1),
  /** "sell": answer bids (you sell). "buy": answer listings (you buy). */
  side: z.enum(["sell", "buy"]),
  /** sell: ask at least this much over the market price, in percent. */
  premiumPct: z.number().min(-50).max(500).default(1),
  /** buy: offer at least this much under the market price, in percent. */
  discountPct: z.number().min(-50).max(99).default(1),
  /** sell: never sell below this price per token, in USD. */
  floorUsd: z.number().positive().optional(),
  /** buy: never pay more than this price per token, in USD. */
  ceilingUsd: z.number().positive().optional(),
  /** Hard cap on one answer's value, in USD. */
  maxUsdPerBlock: z.number().positive(),
  /** Skip blocks worth less than this, in USD. */
  minUsd: z.number().nonnegative().default(50),
  /** sell: most tokens to sell in one answer (whole tokens). */
  maxTokens: z.number().positive().optional(),
  /** Use this as the market price instead of the desk's reference/pool price (USD per token). */
  refPriceUsd: z.number().positive().optional(),
  /** Pay tokens to answer. ETH needs `ethUsd` at the top level. */
  payIn: z.array(z.enum(["USD", "ETH"])).min(1).default(["USD"]),
});

export const ConfigSchema = z.object({
  /** false (default): dry run, nothing is sent. true: answers and deposits for real. */
  live: z.boolean().default(false),
  pollSeconds: z.number().int().min(5).max(3600).default(20),
  /** Hard cap on the total value answered per UTC day, all rules together, in USD. */
  dailyMaxUsd: z.number().positive(),
  /** ETH price in USD, needed only to answer ETH-paid blocks. */
  ethUsd: z.number().positive().optional(),
  /** Minutes the counterparty has to complete a deal after accepting. */
  dealMinutes: z.number().int().min(15).max(43_200).default(120),
  rules: z.array(RuleSchema).min(1).max(50),
});

export type Rule = z.infer<typeof RuleSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(file: string): Promise<Config> {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`rules file is invalid:\n${r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  for (const rule of r.data.rules) {
    if (rule.payIn.includes("ETH") && !r.data.ethUsd) throw new Error(`rule for ${rule.token} pays in ETH: set "ethUsd" at the top level`);
  }
  return r.data;
}

// ------------------------------------------------------------------------------------------
// Decision: what to answer on one block (pure, unit-tested)
// ------------------------------------------------------------------------------------------

export interface PlanInput {
  rule: Rule;
  /** Remaining size of the block, in token base units. */
  remaining: bigint;
  allowPartial: boolean;
  tokenDecimals: number;
  /** Market price, USD per whole token. */
  marketUsd: number;
  pay: { kind: "USD"; decimals: number } | { kind: "ETH"; ethUsd: number };
  /** sell: tokens the wallet holds (base units). buy: pay token the wallet holds (base units). */
  balance: bigint;
  /** USD already answered today, and the daily cap. */
  spentTodayUsd: number;
  dailyMaxUsd: number;
}

export type Plan =
  | { action: "answer"; amount: bigint; price: bigint; unitUsd: number; usd: number; partial: boolean }
  | { action: "skip"; reason: string };

const pow10 = (n: number) => 10n ** BigInt(n);
/** Whole-token number to base units, rounded down, without floating-point overshoot. */
const toUnits = (x: number, decimals: number) => {
  if (!(x > 0)) return 0n;
  const scaled = Math.floor(x * 1e6);
  return (BigInt(scaled) * pow10(decimals)) / 1_000_000n;
};
const fromUnits = (x: bigint, decimals: number) => Number(x) / 10 ** decimals;

export function planAnswer(p: PlanInput): Plan {
  const { rule } = p;
  if (!(p.marketUsd > 0)) return { action: "skip", reason: "no market price" };
  // 1. Price per token, bounded by the rule.
  let unit = rule.side === "sell" ? p.marketUsd * (1 + rule.premiumPct / 100) : p.marketUsd * (1 - rule.discountPct / 100);
  if (rule.side === "sell" && rule.floorUsd !== undefined) unit = Math.max(unit, rule.floorUsd);
  if (rule.side === "buy" && rule.ceilingUsd !== undefined) {
    if (rule.ceilingUsd < unit) unit = rule.ceilingUsd;
  }
  if (!(unit > 0)) return { action: "skip", reason: "price would be zero or negative" };

  // 2. Size: the block's remainder, cut down by every cap.
  let amount = p.remaining;
  const room = Math.min(rule.maxUsdPerBlock, p.dailyMaxUsd - p.spentTodayUsd);
  if (room <= 0) return { action: "skip", reason: "daily cap reached" };
  const byUsd = toUnits(room / unit, p.tokenDecimals);
  if (byUsd < amount) amount = byUsd;
  if (rule.side === "sell") {
    if (rule.maxTokens !== undefined) {
      const byTokens = toUnits(rule.maxTokens, p.tokenDecimals);
      if (byTokens < amount) amount = byTokens;
    }
    if (p.balance < amount) amount = p.balance;
  }
  const payPerToken = (u: number) => (p.pay.kind === "USD" ? u : u / p.pay.ethUsd);
  const payDecimals = p.pay.kind === "USD" ? p.pay.decimals : 18;
  if (rule.side === "buy") {
    // Can't promise more than the wallet can pay.
    const affordable = toUnits(fromUnits(p.balance, payDecimals) / payPerToken(unit), p.tokenDecimals);
    if (affordable < amount) amount = affordable;
  }
  if (amount <= 0n) return { action: "skip", reason: rule.side === "sell" ? "nothing to sell (balance or caps)" : "nothing to spend (balance or caps)" };
  const partial = amount < p.remaining;
  if (partial && !p.allowPartial) return { action: "skip", reason: "block needs the full size and partial fills are off" };

  const usd = fromUnits(amount, p.tokenDecimals) * unit;
  if (usd < rule.minUsd) return { action: "skip", reason: `worth $${usd.toFixed(2)}, under the $${rule.minUsd} minimum` };
  // 3. Total price in the pay token's base units.
  const price = toUnits(fromUnits(amount, p.tokenDecimals) * payPerToken(unit), payDecimals);
  if (price <= 0n) return { action: "skip", reason: "price rounds to zero" };
  return { action: "answer", amount, price, unitUsd: unit, usd, partial };
}

// ------------------------------------------------------------------------------------------
// State: what the autopilot has answered, and today's total
// ------------------------------------------------------------------------------------------

const Entry = z.object({
  quoteId: z.string(),
  rfqId: z.string(),
  side: z.enum(["sell", "buy"]),
  amount: z.string(),
  price: z.string(),
  usd: z.number(),
  at: z.string(),
  done: z.string().optional(),
});
const State = z.object({ v: z.literal(1), day: z.string(), spentUsd: z.number(), answered: z.array(Entry) });
type StateT = z.infer<typeof State>;

class StateFile {
  readonly file: string;
  data: StateT = { v: 1, day: "", spentUsd: 0, answered: [] };
  constructor(file: string) {
    this.file = file;
  }
  async load() {
    try {
      this.data = State.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`autopilot state unreadable: ${(err as Error).message}`);
    }
  }
  async save() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
  rollDay(now: Date) {
    const day = now.toISOString().slice(0, 10);
    if (this.data.day !== day) {
      this.data.day = day;
      this.data.spentUsd = 0;
    }
  }
}

// ------------------------------------------------------------------------------------------
// Engine
// ------------------------------------------------------------------------------------------

export interface AutopilotDeps {
  desk: Desk;
  pub: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
  keystore: Keystore;
  stable: Hex;
  stateFile: string;
  log: (line: string) => void;
  now?: () => Date;
}

const erc20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

export class Autopilot {
  private readonly d: AutopilotDeps;
  private readonly cfg: Config;
  private readonly state: StateFile;
  private readonly escrow: EscrowClient;
  private readonly seenDry = new Set<string>();
  private stableDecimals: number | null = null;
  private readonly decimals = new Map<string, number>();

  constructor(deps: AutopilotDeps, cfg: Config) {
    this.d = deps;
    this.cfg = cfg;
    this.state = new StateFile(deps.stateFile);
    this.escrow = new EscrowClient(deps.pub, deps.desk.cfg.escrow);
  }

  private me() {
    return this.d.wallet.account.address.toLowerCase() as Hex;
  }
  private now() {
    return this.d.now ? this.d.now() : new Date();
  }
  private balance(token: Hex) {
    return token === ZERO
      ? this.d.pub.getBalance({ address: this.me() })
      : this.d.pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [this.me()] });
  }
  private async tokenDecimals(token: Hex) {
    const hit = this.decimals.get(token);
    if (hit !== undefined) return hit;
    const f = await this.d.desk.api.token(token);
    const dec = (f.token as { decimals?: number | null }).decimals ?? 18;
    this.decimals.set(token, dec);
    return dec;
  }

  async start() {
    await this.state.load();
    this.d.log(`autopilot ${this.cfg.live ? "LIVE" : "dry run"} · wallet ${this.me()} · ${this.cfg.rules.length} rule(s) · daily cap $${this.cfg.dailyMaxUsd}`);
  }

  /** One pass: answer what matches, then move accepted deals forward. Returns a short summary. */
  async tick(): Promise<{ answered: number; skipped: number; actions: number }> {
    const now = this.now();
    this.state.rollDay(now);
    const { items: markets } = (await this.d.desk.api.markets()) as unknown as { items: { symbol: string; token: Hex; decimals: number; reference: { price: string } | null }[] };
    if (this.stableDecimals === null) this.stableDecimals = await this.tokenDecimals(this.d.stable);
    let answered = 0, skipped = 0;

    for (const rule of this.cfg.rules) {
      const m = /^0x[0-9a-fA-F]{40}$/.test(rule.token)
        ? markets.find((x) => x.token === rule.token.toLowerCase())
        : markets.find((x) => x.symbol.toUpperCase() === rule.token.toUpperCase());
      const token = (m?.token ?? (/^0x/.test(rule.token) ? rule.token.toLowerCase() : null)) as Hex | null;
      if (!token) {
        this.d.log(`rule ${rule.token}: not a listed market or address, skipped`);
        continue;
      }
      const label = m?.symbol ?? token.slice(0, 10);
      let marketUsd = rule.refPriceUsd ?? (m?.reference ? Number(m.reference.price) : NaN);
      if (!(marketUsd > 0)) marketUsd = await this.d.desk.api.tokenMarket(token).then((r) => Number(r.priceUsd), () => NaN);
      const tokenDec = m?.decimals ?? (await this.tokenDecimals(token));
      const { items } = await this.d.desk.api.listRfqs({ token, side: rule.side === "sell" ? "buy" : "sell", limit: 100 });

      for (const rfq of items as RfqPublic[]) {
        if (rfq.status !== "open" || new Date(rfq.expiresAt).getTime() <= now.getTime()) continue;
        if (this.state.data.answered.some((e) => e.rfqId === rfq.id) || this.seenDry.has(rfq.id)) continue;
        if (await this.d.keystore.block(rfq.id)) continue; // never answer our own posting
        const payKind = rfq.payToken === ZERO ? "ETH" : rfq.payToken === this.d.stable ? "USD" : null;
        if (!payKind || !rule.payIn.includes(payKind)) {
          skipped++;
          continue;
        }
        const pay = payKind === "USD" ? { kind: "USD" as const, decimals: this.stableDecimals } : { kind: "ETH" as const, ethUsd: this.cfg.ethUsd! };
        const balance = await this.balance(rule.side === "sell" ? token : (rfq.payToken as Hex));
        const plan = planAnswer({
          rule, remaining: BigInt(rfq.amount) - BigInt(rfq.filledAmount), allowPartial: rfq.allowPartial, tokenDecimals: tokenDec,
          marketUsd, pay, balance, spentTodayUsd: this.state.data.spentUsd, dailyMaxUsd: this.cfg.dailyMaxUsd,
        });
        if (plan.action === "skip") {
          skipped++;
          this.d.log(`${label} ${rfq.side === "buy" ? "bid" : "listing"} ${rfq.id.slice(0, 8)}: skip, ${plan.reason}`);
          if (!this.cfg.live) this.seenDry.add(rfq.id);
          continue;
        }
        const what = `${rule.side === "sell" ? "sell" : "buy"} ${(Number(plan.amount) / 10 ** tokenDec).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${label} at $${plan.unitUsd.toFixed(4)} (~$${plan.usd.toFixed(2)}${plan.partial ? ", partial" : ""})`;
        if (!this.cfg.live) {
          this.seenDry.add(rfq.id);
          this.d.log(`DRY RUN: would answer ${rfq.id.slice(0, 8)}: ${what}`);
          answered++;
          continue;
        }
        const sent = await this.d.desk.answer({
          rfqId: rfq.id,
          signer: { address: this.me(), signTypedData: (td: never) => this.d.wallet.signTypedData({ ...(td as object), account: this.d.wallet.account } as never) },
          amount: plan.amount.toString(),
          price: plan.price.toString(),
          deadlineSeconds: this.cfg.dealMinutes * 60,
        });
        await this.d.keystore.addAnswer({ quoteId: sent.quoteId, rfqId: rfq.id, quoteToken: sent.quoteToken, createdAt: now.toISOString() });
        this.state.data.answered.push({ quoteId: sent.quoteId, rfqId: rfq.id, side: rule.side, amount: plan.amount.toString(), price: plan.price.toString(), usd: plan.usd, at: now.toISOString() });
        this.state.data.spentUsd += plan.usd;
        await this.state.save();
        this.d.log(`answered ${rfq.id.slice(0, 8)}: ${what}`);
        answered++;
      }
    }
    const actions = this.cfg.live ? await this.followDeals(now) : 0;
    return { answered, skipped, actions };
  }

  /** Accepted deals this autopilot answered: buyer locks payment, seller delivers. */
  private async followDeals(now: Date): Promise<number> {
    let actions = 0;
    for (const e of this.state.data.answered.filter((x) => !x.done)) {
      const a = await this.d.keystore.answer(e.quoteId);
      if (!a) continue;
      const deal = await this.d.desk.myDeal(a.quoteId, a.quoteToken).catch(() => null);
      if (!deal) {
        // Never accepted: stop watching a day after the posting closed.
        const { rfq } = await this.d.desk.api.getRfq(e.rfqId).catch(() => ({ rfq: null as RfqPublic | null }));
        if (!rfq || (rfq.status !== "open" && now.getTime() > new Date(rfq.expiresAt).getTime() + 86_400_000)) {
          e.done = "not accepted";
          await this.state.save();
        }
        continue;
      }
      const t = deal.terms;
      if (String(t.amount) !== e.amount || String(t.price) !== e.price) {
        this.d.log(`deal on ${e.rfqId.slice(0, 8)}: terms differ from what was signed (amount/price), left alone`);
        e.done = "terms mismatch";
        await this.state.save();
        continue;
      }
      const status = await this.escrow.status(t);
      if (status === "settled" || status === "refunded") {
        e.done = status;
        await this.state.save();
        this.d.log(`deal on ${e.rfqId.slice(0, 8)}: ${status}`);
        continue;
      }
      try {
        if (e.side === "buy" && status === "none" && t.buyer === this.me()) {
          const tx = await this.escrow.depositPayment(this.d.wallet, t);
          this.d.log(`deal on ${e.rfqId.slice(0, 8)}: payment locked (${tx})`);
          actions++;
        } else if (e.side === "sell" && status === "payment_locked" && t.seller === this.me()) {
          const tx = await this.escrow.deliver(this.d.wallet, t);
          await this.d.desk.api.reportSettled(deal.rfqId, tx).catch(() => null);
          e.done = "settled";
          await this.state.save();
          this.d.log(`deal on ${e.rfqId.slice(0, 8)}: delivered and settled (${tx})`);
          actions++;
        }
      } catch (err) {
        this.d.log(`deal on ${e.rfqId.slice(0, 8)}: ${(err as Error).message}`);
      }
    }
    return actions;
  }

  /** Run until stopped. */
  async run(signal?: AbortSignal) {
    await this.start();
    while (!signal?.aborted) {
      try {
        const r = await this.tick();
        if (r.answered || r.actions) this.d.log(`pass: ${r.answered} answered, ${r.actions} deal step(s), $${this.state.data.spentUsd.toFixed(2)} of $${this.cfg.dailyMaxUsd} used today`);
      } catch (err) {
        this.d.log(`pass failed: ${(err as Error).message}`);
      }
      await new Promise((res) => setTimeout(res, this.cfg.pollSeconds * 1000));
    }
  }
}
