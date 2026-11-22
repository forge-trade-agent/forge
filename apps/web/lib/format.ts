import { formatUnits, parseUnits } from "viem";

export const short = (a?: string | null, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "");

/** Human amount with grouping, trimming to `dp` decimals. */
export function fmtUnits(v: bigint | string, decimals: number, dp = 4): string {
  const s = formatUnits(BigInt(v), decimals);
  const [i, f = ""] = s.split(".");
  const int = BigInt(i!).toLocaleString("en-US");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export function fmtUsd(n: number | string | null | undefined, dp = 2): string {
  if (n === null || n === undefined || n === "") return "–";
  const x = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(x)) return "–";
  if (Math.abs(x) >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (Math.abs(x) >= 1e4) return `$${(x / 1e3).toFixed(1)}K`;
  if (Math.abs(x) > 0 && Math.abs(x) < 0.01) return `$${x.toPrecision(3)}`;
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function fmtPct(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "–";
  const x = Number(n);
  return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}%`;
}

/** Parse a user-typed decimal into base units; null if invalid. */
export function toBase(input: string, decimals: number): bigint | null {
  const s = input.replace(/[,_\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    const v = parseUnits(s, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** total price (pay base units) = unit price (pay units per 1 token) * amount (token base units) / 10^tokenDecimals */
export function totalPrice(unitPrice: string, amount: bigint, tokenDecimals: number, payDecimals: number): bigint | null {
  const u = toBase(unitPrice, payDecimals);
  if (u === null) return null;
  return (u * amount) / 10n ** BigInt(tokenDecimals);
}

export function unitPrice(price: bigint | string, amount: bigint | string, tokenDecimals: number, payDecimals: number): string {
  const a = BigInt(amount);
  if (a === 0n) return "–";
  // Round to nearest so 152.5 doesn't display as 152.4999 after integer division.
  const u = (BigInt(price) * 10n ** BigInt(tokenDecimals) + a / 2n) / a;
  return fmtUnits(u, payDecimals, payDecimals === 18 ? 6 : 4);
}

export function timeLeft(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}
