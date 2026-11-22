/**
 * Reference market data. Reference only: deals always settle at the sealed price.
 *  - DEX snapshots: DexScreener public API, deepest pool per token.
 *  - Delayed underlying-listing candles: pluggable provider (Alpha Vantage implementation included).
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { dexSnapshots, markets, priceCandles, type AnyDb } from "@sealdesk/db";
import type { Cache, Hex } from "@sealdesk/shared";

// ---------------------------------------------------------------- DexScreener

const DexPair = z.object({
  pairAddress: z.string(),
  baseToken: z.object({ address: z.string() }),
  priceUsd: z.string().optional(),
  marketCap: z.number().optional(),
  fdv: z.number().optional(),
  liquidity: z.object({ usd: z.number().optional() }).optional(),
  volume: z.object({ h24: z.number().optional() }).optional(),
  priceChange: z.object({ h24: z.number().optional() }).optional(),
});
type DexPair = z.infer<typeof DexPair>;

const usd = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? null : n.toFixed(6));

/** One snapshot per token from its deepest pool where it is the base token. */
export async function snapshotDex(
  db: AnyDb,
  opts: { chainId: number; slug: string; extraTokens: Hex[]; fetchImpl?: typeof fetch; now: Date },
) {
  const f = opts.fetchImpl ?? fetch;
  const listed = await db.select({ token: markets.tokenAddress }).from(markets).where(eq(markets.chainId, opts.chainId));
  const tokens = [...new Set([...listed.map((m) => m.token), ...opts.extraTokens.map((t) => t.toLowerCase())])];
  let written = 0;
  for (let i = 0; i < tokens.length; i += 30) {
    const batch = tokens.slice(i, i + 30);
    const res = await f(`https://api.dexscreener.com/tokens/v1/${opts.slug}/${batch.join(",")}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    const pairs = z.array(z.unknown()).parse(await res.json()).flatMap((p) => {
      const r = DexPair.safeParse(p);
      return r.success ? [r.data] : [];
    });
    const best = new Map<string, DexPair>();
    for (const p of pairs) {
      const t = p.baseToken.address.toLowerCase();
      if (!batch.includes(t) || !p.priceUsd) continue;
      const cur = best.get(t);
      if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(t, p);
    }
    for (const [token, p] of best) {
      await db
        .insert(dexSnapshots)
        .values({
          chainId: opts.chainId,
          tokenAddress: token,
          ts: opts.now,
          priceUsd: p.priceUsd!,
          marketCapUsd: usd(p.marketCap ?? p.fdv),
          liquidityUsd: usd(p.liquidity?.usd),
          volume24hUsd: usd(p.volume?.h24),
          change24hPct: p.priceChange?.h24 === undefined ? null : p.priceChange.h24.toFixed(4),
          poolAddress: p.pairAddress,
        })
        .onConflictDoNothing();
      written++;
    }
  }
  return { tokens: tokens.length, written };
}

// ---------------------------------------------------------------- reference candles

export interface Candle {
  t: Date;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
}

export interface ReferenceProvider {
  readonly name: string;
  intraday5m(symbol: string): Promise<Candle[]>;
  daily(symbol: string): Promise<Candle[]>;
}

/** US equities listed in America/New_York; Alpha Vantage timestamps are exchange-local. */
function nyToUtc(local: string): Date {
  const [d, t = "16:00:00"] = local.split(" ");
  const guess = new Date(`${d}T${t}Z`);
  const offsetMin =
    new Date(guess.toLocaleString("en-US", { timeZone: "UTC" })).getTime() -
    new Date(guess.toLocaleString("en-US", { timeZone: "America/New_York" })).getTime();
  return new Date(guess.getTime() + offsetMin);
}

const AvBar = z.object({ "1. open": z.string(), "2. high": z.string(), "3. low": z.string(), "4. close": z.string(), "5. volume": z.string().optional() });

export function parseAlphaVantage(json: unknown, key: string): Candle[] {
  const obj = z.record(z.string(), z.unknown()).parse(json);
  if (typeof obj["Note"] === "string" || typeof obj["Information"] === "string") throw new Error("alpha vantage rate limit");
  if (typeof obj["Error Message"] === "string") throw new Error(`alpha vantage: ${obj["Error Message"]}`);
  const series = z.record(z.string(), AvBar).parse(obj[key] ?? {});
  return Object.entries(series)
    .map(([ts, b]) => ({ t: nyToUtc(ts), o: b["1. open"], h: b["2. high"], l: b["3. low"], c: b["4. close"], v: b["5. volume"] ?? null }))
    .sort((a, b) => a.t.getTime() - b.t.getTime());
}

export class AlphaVantageProvider implements ReferenceProvider {
  readonly name = "alphavantage";
  private readonly apiKey: string;
  private readonly f: typeof fetch;
  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.f = fetchImpl;
  }
  private async get(params: Record<string, string>) {
    const qs = new URLSearchParams({ ...params, apikey: this.apiKey });
    const res = await this.f(`https://www.alphavantage.co/query?${qs}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`alpha vantage ${res.status}`);
    return res.json();
  }
  async intraday5m(symbol: string) {
    return parseAlphaVantage(await this.get({ function: "TIME_SERIES_INTRADAY", symbol, interval: "5min", outputsize: "full" }), "Time Series (5min)");
  }
  async daily(symbol: string) {
    return parseAlphaVantage(await this.get({ function: "TIME_SERIES_DAILY", symbol, outputsize: "full" }), "Time Series (Daily)");
  }
}

/** Roll 5-minute bars up into a coarser interval (bucket start aligned to UTC). */
export function aggregate(bars: Candle[], minutes: number): Candle[] {
  const ms = minutes * 60_000;
  const out = new Map<number, Candle>();
  for (const b of bars) {
    const k = Math.floor(b.t.getTime() / ms) * ms;
    const cur = out.get(k);
    if (!cur) {
      out.set(k, { ...b, t: new Date(k) });
    } else {
      cur.h = Number(b.h) > Number(cur.h) ? b.h : cur.h;
      cur.l = Number(b.l) < Number(cur.l) ? b.l : cur.l;
      cur.c = b.c;
      cur.v = cur.v !== null && b.v !== null ? String(Number(cur.v) + Number(b.v)) : null;
    }
  }
  return [...out.values()].sort((a, b) => a.t.getTime() - b.t.getTime());
}

async function upsertCandles(db: AnyDb, marketId: number, interval: "5m" | "15m" | "1h" | "1d", candles: Candle[]) {
  for (const c of candles) {
    const v = { open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v };
    await db
      .insert(priceCandles)
      .values({ marketId, interval, bucket: c.t, ...v })
      .onConflictDoUpdate({ target: [priceCandles.marketId, priceCandles.interval, priceCandles.bucket], set: v });
  }
}

/**
 * Free-tier providers allow a few calls per minute, so each run refreshes ONE market
 * (round-robin with a cursor in the cache).
 */
export async function refreshReferencePrices(db: AnyDb, cache: Cache, provider: ReferenceProvider, chainId: number) {
  const list = await db
    .select({ id: markets.id, symbol: markets.underlyingSymbol })
    .from(markets)
    .where(and(eq(markets.chainId, chainId), isNotNull(markets.underlyingSymbol)))
    .orderBy(markets.id);
  if (list.length === 0) return { market: null };
  const i = ((await cache.get<number>("refprice:cursor")) ?? 0) % list.length;
  const m = list[i]!;
  await cache.set("refprice:cursor", i + 1, 7 * 86_400);

  const bars = await provider.intraday5m(m.symbol!);
  await upsertCandles(db, m.id, "5m", bars);
  await upsertCandles(db, m.id, "15m", aggregate(bars, 15));
  await upsertCandles(db, m.id, "1h", aggregate(bars, 60));
  await upsertCandles(db, m.id, "1d", (await provider.daily(m.symbol!)).slice(-400));
  return { market: m.symbol, bars: bars.length };
}
