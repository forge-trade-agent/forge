import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTicket } from "../lib/nl.ts";

const SYMS = ["TSLA", "NVDA", "AAPL", "SPY"];

test("sell N SYMBOL for ETH within 1 hour", () => {
  assert.deepEqual(parseTicket("Sell 500 NVDA for ETH within 1 hour", SYMS), { side: "sell", symbol: "NVDA", size: "500", sizeIn: "tokens", pay: "ETH", window: "1h", unknown: [] });
});

test("USD-denominated size with k suffix and partials", () => {
  const r = parseTicket("buy $25k of TSLA with USD in 4h, partial ok", SYMS);
  assert.equal(r.side, "buy");
  assert.equal(r.size, "25000");
  assert.equal(r.sizeIn, "usd");
  assert.equal(r.symbol, "TSLA");
  assert.equal(r.pay, "USD");
  assert.equal(r.window, "4h");
  assert.equal(r.allowPartial, true);
});

test("terse form with thousands separator and a day window", () => {
  const r = parseTicket("bid 2,500 tsla usdg 24h", SYMS);
  assert.deepEqual([r.side, r.size, r.symbol, r.pay, r.window], ["buy", "2500", "TSLA", "USD", "24h"]);
});

test("all or nothing disables partials; unknown fields are reported", () => {
  assert.equal(parseTicket("sell 10 spy all or nothing", SYMS).allowPartial, false);
  assert.deepEqual(parseTicket("something vague", SYMS).unknown, ["side", "token", "size"]);
});

test("unit price rounds to nearest instead of truncating", async () => {
  const { unitPrice, totalPrice } = await import("../lib/format.ts");
  const amount = 163896409000000000000n; // 163.896409 tokens (18 dp)
  const price = totalPrice("152.5", amount, 18, 6)!;
  assert.equal(unitPrice(price, amount, 18, 6), "152.5");
});
