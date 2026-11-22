/**
 * "Describe it" ticket filler. Deterministic grammar, runs in the browser only (no server, no model).
 *   "Sell 500 NVDA for ETH within 1 hour"
 *   "buy $25k of TSLA with USD in 4h, partial ok"
 *   "bid 2,500 tsla usdg 24h"
 */
export interface ParsedTicket {
  side?: "buy" | "sell";
  symbol?: string;
  size?: string;
  sizeIn?: "usd" | "tokens";
  pay?: "ETH" | "USD";
  window?: "15m" | "1h" | "4h" | "6h" | "24h";
  allowPartial?: boolean;
  unknown: string[];
}

const SIDE: Record<string, "buy" | "sell"> = { buy: "buy", bid: "buy", purchase: "buy", acquire: "buy", sell: "sell", list: "sell", offload: "sell", ask: "sell" };
const PAY: Record<string, "ETH" | "USD"> = { eth: "ETH", ether: "ETH", weth: "ETH", usd: "USD", usdg: "USD", usdc: "USD", dollars: "USD", stable: "USD" };
const WINDOWS: [RegExp, ParsedTicket["window"]][] = [
  [/\b(15\s*m(in(ute)?s?)?|quarter\s*hour)\b/, "15m"],
  [/\b(1\s*h(our|r)?|one\s*hour|an\s*hour|60\s*m(in)?)\b/, "1h"],
  [/\b(4\s*h(ours?|rs?)?|four\s*hours?)\b/, "4h"],
  [/\b(6\s*h(ours?|rs?)?|six\s*hours?)\b/, "6h"],
  [/\b(24\s*h(ours?|rs?)?|1\s*d(ay)?|a\s*day|one\s*day|tomorrow)\b/, "24h"],
];

export function parseTicket(input: string, knownSymbols: string[]): ParsedTicket {
  const text = input.toLowerCase().replace(/[“”"']/g, " ");
  const out: ParsedTicket = { unknown: [] };
  const words = text.split(/[\s,;:]+/).filter(Boolean);

  for (const w of words) if (SIDE[w] && !out.side) out.side = SIDE[w];

  // Money size: $25k, 25,000 usd, 1.5m dollars
  const usd = /\$\s*([\d.,]+)\s*([km])?\b|\b([\d.,]+)\s*([km])?\s*(usd|dollars)\s+(of|worth)\b/.exec(text);
  if (usd) {
    const n = Number((usd[1] ?? usd[3] ?? "").replace(/,/g, ""));
    const mult = (usd[2] ?? usd[4]) === "k" ? 1e3 : (usd[2] ?? usd[4]) === "m" ? 1e6 : 1;
    if (Number.isFinite(n) && n > 0) {
      out.size = String(n * mult);
      out.sizeIn = "usd";
    }
  }

  const syms = new Set(knownSymbols.map((s) => s.toLowerCase()));
  for (const w of words) {
    const bare = w.replace(/^\$/, "");
    if (syms.has(bare) && !PAY[bare]) {
      out.symbol = bare.toUpperCase();
      break;
    }
  }

  // Token size: "500 nvda", "2,500 tsla"
  if (!out.size && out.symbol) {
    const m = new RegExp(`([\\d][\\d.,]*)\\s*(k|m)?\\s*(?:x\\s*)?${out.symbol.toLowerCase()}\\b`).exec(text);
    if (m) {
      const n = Number(m[1]!.replace(/,/g, "")) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
      if (Number.isFinite(n) && n > 0) {
        out.size = String(n);
        out.sizeIn = "tokens";
      }
    }
  }

  // Pay token: "for eth", "with usd", "in usdg", or a bare pay word
  const payPhrase = /\b(for|with|in|pay(?:ing)?|using)\s+(eth|ether|weth|usd|usdg|usdc|dollars|stable)\b/.exec(text);
  const phrasePay = payPhrase ? PAY[payPhrase[2]!] : undefined;
  if (phrasePay) out.pay = phrasePay;
  else
    for (const w of words) {
      const p = PAY[w];
      if (p && !(out.sizeIn === "usd" && (w === "usd" || w === "dollars"))) out.pay = p;
    }

  for (const [re, win] of WINDOWS) if (win && re.test(text)) out.window = win;
  if (/\bpartial(s|ly)?\b|\bsplit\b|\bseveral sellers\b|\bmultiple\b/.test(text)) out.allowPartial = !/\bno partial|not partial|all or nothing|fill or kill\b/.test(text);
  if (/\ball or nothing|fill or kill|no partial/.test(text)) out.allowPartial = false;

  if (!out.side) out.unknown.push("side");
  if (!out.symbol) out.unknown.push("token");
  if (!out.size) out.unknown.push("size");
  return out;
}
