import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema, planAnswer, RuleSchema, type PlanInput } from "../src/autopilot.ts";

const E18 = 10n ** 18n;
const USD = { kind: "USD" as const, decimals: 6 };
const rule = (r: Record<string, unknown>) => RuleSchema.parse({ token: "TSLA", maxUsdPerBlock: 1_000_000, minUsd: 0, ...r });
const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  rule: rule({ side: "sell", premiumPct: 2 }),
  remaining: 10n * E18,
  allowPartial: false,
  tokenDecimals: 18,
  marketUsd: 100,
  pay: USD,
  balance: 1_000n * E18,
  spentTodayUsd: 0,
  dailyMaxUsd: 10_000_000,
  ...over,
});

test("sell: answers the whole block at market plus the premium", () => {
  const p = planAnswer(base());
  assert.equal(p.action, "answer");
  if (p.action !== "answer") return;
  assert.equal(p.amount, 10n * E18);
  assert.equal(p.price, 1_020_000_000n); // 10 x $102.00 in 6-decimal USD
  assert.equal(p.partial, false);
});

test("sell: the floor wins over a low market price", () => {
  const p = planAnswer(base({ rule: rule({ side: "sell", premiumPct: 0, floorUsd: 150 }) }));
  assert.ok(p.action === "answer" && p.unitUsd === 150 && p.price === 1_500_000_000n);
});

test("per-block cap: partial when allowed, skipped when not", () => {
  const capped = rule({ side: "sell", premiumPct: 0, maxUsdPerBlock: 500 });
  assert.equal(planAnswer(base({ rule: capped })).action, "skip");
  const p = planAnswer(base({ rule: capped, allowPartial: true }));
  assert.ok(p.action === "answer" && p.partial && p.amount === 5n * E18 && p.price === 500_000_000n);
});

test("sell: never more than the wallet holds or maxTokens", () => {
  const p = planAnswer(base({ balance: 3n * E18, allowPartial: true }));
  assert.ok(p.action === "answer" && p.amount === 3n * E18);
  const q = planAnswer(base({ rule: rule({ side: "sell", maxTokens: 2 }), allowPartial: true }));
  assert.ok(q.action === "answer" && q.amount === 2n * E18);
  const r = planAnswer(base({ balance: 0n, allowPartial: true }));
  assert.equal(r.action, "skip");
});

test("daily cap: uses only what is left, then stops", () => {
  const p = planAnswer(base({ rule: rule({ side: "sell", premiumPct: 0 }), allowPartial: true, spentTodayUsd: 9_999_800, dailyMaxUsd: 10_000_000 }));
  assert.ok(p.action === "answer" && p.amount === 2n * E18);
  const q = planAnswer(base({ spentTodayUsd: 10_000_000 }));
  assert.ok(q.action === "skip" && q.reason === "daily cap reached");
});

test("buy: market minus the discount, bounded by the ceiling and the balance", () => {
  const p = planAnswer(base({ rule: rule({ side: "buy", discountPct: 5 }), balance: 10_000n * 1_000_000n }));
  assert.ok(p.action === "answer" && p.unitUsd === 95 && p.price === 950_000_000n);
  const q = planAnswer(base({ rule: rule({ side: "buy", discountPct: 0, ceilingUsd: 80 }), balance: 10_000n * 1_000_000n }));
  assert.ok(q.action === "answer" && q.unitUsd === 80);
  // Only $400 in the wallet at $100 a token: 4 tokens, partial.
  const r = planAnswer(base({ rule: rule({ side: "buy", discountPct: 0 }), balance: 400n * 1_000_000n, allowPartial: true }));
  assert.ok(r.action === "answer" && r.amount === 4n * E18 && r.partial);
});

test("ETH-paid blocks are priced through the given ETH/USD", () => {
  const p = planAnswer(base({ rule: rule({ side: "sell", premiumPct: 0, payIn: ["ETH"] }), marketUsd: 3000, remaining: 2n * E18, pay: { kind: "ETH", ethUsd: 3000 } }));
  assert.ok(p.action === "answer" && p.price === 2n * E18); // 2 tokens x $3000 = 2 ETH
});

test("too small or unpriced blocks are skipped", () => {
  assert.equal(planAnswer(base({ rule: rule({ side: "sell", minUsd: 5_000 }) })).action, "skip");
  assert.equal(planAnswer(base({ marketUsd: NaN })).action, "skip");
});

test("rules file: dry run by default, ETH needs ethUsd", () => {
  const c = ConfigSchema.parse({ dailyMaxUsd: 1000, rules: [{ token: "TSLA", side: "sell", maxUsdPerBlock: 100 }] });
  assert.equal(c.live, false);
  assert.deepEqual(c.rules[0]!.payIn, ["USD"]);
  assert.throws(() => ConfigSchema.parse({ dailyMaxUsd: 1000, rules: [] }));
});
