/**
 * Public, read-only data: token facts, market reference data, receipts, desk stats, referrals.
 * Everything market-related is labelled reference-only: deals settle at the sealed price.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { burns, deals, dexSnapshots, markets, priceCandles, quotes, rfqs, settlementTicks } from "@sealdesk/db";
import { Address, AppError, ErrorCode, Hex32 } from "@sealdesk/shared";
import type { Ctx } from "../context.ts";
import { hex, parse } from "../http.ts";
import { tokenFactsCached } from "./rfqs.ts";

/** Window back from the latest bar. 1D: one session (no bars overnight); 5D: five sessions. */
const RANGES = {
  "1D": { interval: "5m", ms: 18 * 3_600_000 },
  "5D": { interval: "15m", ms: 6.5 * 86_400_000 },
  "1M": { interval: "1h", ms: 31 * 86_400_000 },
  "6M": { interval: "1d", ms: 183 * 86_400_000 },
  "1Y": { interval: "1d", ms: 366 * 86_400_000 },
} as const;

const INTERVAL_MS = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "1d": 86_400_000 } as const;

export function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  // ------------------------------------------------------------------ token facts
  app.get<{ Params: { address: string } }>("/token/:address", async (req) => {
    const address = parse(Address, req.params.address);
    return { token: await tokenFactsCached(ctx, address) };
  });

  app.get<{ Params: { address: string } }>("/token/:address/market", async (req) => {
    const address = parse(Address, req.params.address);
    const [snap] = await ctx.db
      .select()
      .from(dexSnapshots)
      .where(and(eq(dexSnapshots.chainId, ctx.config.chainId), eq(dexSnapshots.tokenAddress, address)))
      .orderBy(desc(dexSnapshots.ts))
      .limit(1);
    if (!snap) throw new AppError(ErrorCode.NOT_FOUND, "No DEX market seen for this token yet");
    return {
      referenceOnly: true,
      token: address,
      priceUsd: snap.priceUsd,
      marketCapUsd: snap.marketCapUsd,
      liquidityUsd: snap.liquidityUsd,
      volume24hUsd: snap.volume24hUsd,
      change24hPct: snap.change24hPct,
      pool: snap.poolAddress,
      asOf: snap.ts.toISOString(),
    };
  });

  app.get<{ Params: { token: string } }>("/price/:token", async (req) => {
    const address = parse(Address, req.params.token);
    const [snap] = await ctx.db
      .select({ priceUsd: dexSnapshots.priceUsd, ts: dexSnapshots.ts })
      .from(dexSnapshots)
      .where(and(eq(dexSnapshots.chainId, ctx.config.chainId), eq(dexSnapshots.tokenAddress, address)))
      .orderBy(desc(dexSnapshots.ts))
      .limit(1);
    if (!snap) throw new AppError(ErrorCode.NOT_FOUND, "No price for this token yet");
    return { token: address, priceUsd: snap.priceUsd, asOf: snap.ts.toISOString(), referenceOnly: true };
  });

  // ------------------------------------------------------------------ markets
  app.get("/markets", async () => {
    const cached = await ctx.cache.get<unknown>(`markets:${ctx.config.chainId}`);
    if (cached) return cached;
    const now = ctx.now();
    const rows = await ctx.db
      .select()
      .from(markets)
      .where(and(eq(markets.chainId, ctx.config.chainId), eq(markets.featured, true)))
      .orderBy(asc(markets.sortOrder), asc(markets.symbol));
    const open = await ctx.db
      .select({
        token: rfqs.tokenAddress,
        bids: sql<number>`count(*) filter (where ${rfqs.side} = 'buy')::int`,
        listings: sql<number>`count(*) filter (where ${rfqs.side} = 'sell')::int`,
      })
      .from(rfqs)
      .where(and(eq(rfqs.status, "open"), gte(rfqs.expiresAt, now), eq(rfqs.chainId, ctx.config.chainId)))
      .groupBy(rfqs.tokenAddress);
    const openBy = new Map(open.map((o) => [o.token, o]));
    const since = new Date(now.getTime() - 6 * 86_400_000);

    const items = [];
    for (const m of rows) {
      const candles = await ctx.db
        .select({ t: priceCandles.bucket, c: priceCandles.close })
        .from(priceCandles)
        .where(and(eq(priceCandles.marketId, m.id), eq(priceCandles.interval, "1h"), gte(priceCandles.bucket, since)))
        .orderBy(asc(priceCandles.bucket));
      const daily = await ctx.db
        .select({ c: priceCandles.close })
        .from(priceCandles)
        .where(and(eq(priceCandles.marketId, m.id), eq(priceCandles.interval, "1d")))
        .orderBy(desc(priceCandles.bucket))
        .limit(2);
      const last = candles.at(-1)?.c ?? daily[0]?.c ?? null;
      const prevClose = daily[1]?.c ?? null;
      const o = openBy.get(m.tokenAddress);
      // Tokens with no listed stock behind them (or no reference feed yet) are priced from their pool instead.
      const [snap] = m.underlyingSymbol && last
        ? []
        : await ctx.db
            .select({ price: dexSnapshots.priceUsd, change: dexSnapshots.change24hPct })
            .from(dexSnapshots)
            .where(and(eq(dexSnapshots.chainId, ctx.config.chainId), eq(dexSnapshots.tokenAddress, m.tokenAddress)))
            .orderBy(desc(dexSnapshots.ts))
            .limit(1);
      items.push({
        dex: snap ? { price: snap.price, change24hPct: snap.change } : null,
        symbol: m.symbol,
        name: m.name,
        kind: m.kind,
        token: m.tokenAddress,
        decimals: m.decimals,
        logoUrl: m.logoUrl,
        exchange: m.exchange,
        permit: m.permitSupported,
        verified: m.verifiedAt !== null,
        reference:
          m.underlyingSymbol && last
            ? {
                delayed: true,
                price: last,
                prevClose,
                changePct: prevClose ? ((Number(last) / Number(prevClose) - 1) * 100).toFixed(2) : null,
                sparkline5d: candles.map((c) => [c.t.toISOString(), c.c]),
              }
            : null,
        open: { bids: o?.bids ?? 0, listings: o?.listings ?? 0 },
      });
    }
    const body = { referenceOnly: true, items };
    await ctx.cache.set(`markets:${ctx.config.chainId}`, body, 30);
    return body;
  });

  app.get<{ Params: { symbol: string } }>("/markets/:symbol/chart", async (req) => {
    const { range } = parse(z.object({ range: z.enum(["1D", "5D", "1M", "6M", "1Y"]).default("1D") }), req.query);
    const symbol = parse(z.string().regex(/^[A-Za-z0-9.$-]{1,16}$/), req.params.symbol).toUpperCase();
    const [m] = await ctx.db.select().from(markets).where(and(eq(markets.chainId, ctx.config.chainId), eq(markets.symbol, symbol)));
    if (!m) throw new AppError(ErrorCode.NOT_FOUND, "Unknown market");
    const r = RANGES[range];
    // Anchor on the latest bar, not on now: after the close or over a weekend "1D" still shows
    // the last session instead of an empty chart.
    const [latest] = await ctx.db
      .select({ t: priceCandles.bucket })
      .from(priceCandles)
      .where(and(eq(priceCandles.marketId, m.id), eq(priceCandles.interval, r.interval)))
      .orderBy(desc(priceCandles.bucket))
      .limit(1);
    const anchor = latest?.t.getTime() ?? ctx.now().getTime();
    // "As of": the end of the newest 5-minute bar, whatever the range's interval.
    const [fresh] = await ctx.db
      .select({ t: priceCandles.bucket })
      .from(priceCandles)
      .where(and(eq(priceCandles.marketId, m.id), eq(priceCandles.interval, "5m")))
      .orderBy(desc(priceCandles.bucket))
      .limit(1);
    const rows = await ctx.db
      .select()
      .from(priceCandles)
      .where(
        and(
          eq(priceCandles.marketId, m.id),
          eq(priceCandles.interval, r.interval),
          gte(priceCandles.bucket, new Date(anchor - r.ms)),
        ),
      )
      .orderBy(asc(priceCandles.bucket));
    return {
      symbol,
      range,
      interval: r.interval,
      delayed: true,
      asOf: fresh ? new Date(fresh.t.getTime() + INTERVAL_MS["5m"]).toISOString() : latest ? new Date(anchor + INTERVAL_MS[r.interval]).toISOString() : null,
      // TradingView Lightweight Charts format
      candles: rows.map((c) => ({
        time: Math.floor(c.bucket.getTime() / 1000),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.volume === null ? null : Number(c.volume),
      })),
    };
  });

  // ------------------------------------------------------------------ receipts (rebuilt from chain)
  app.get<{ Params: { tx: string } }>("/receipts/:tx", async (req) => {
    const tx = parse(Hex32, req.params.tx);
    const cacheKey = `receipt:${ctx.config.chainId}:${tx}`;
    const cached = await ctx.cache.get<unknown>(cacheKey);
    if (cached) return cached;
    const p = await ctx.chain.settlementFromTx(tx);
    if (!p) throw new AppError(ErrorCode.TX_NOT_SETTLEMENT, "Not a settlement on the desk escrow");
    const body = {
      chainId: ctx.config.chainId,
      escrow: p.escrow,
      txHash: p.txHash,
      block: p.blockNumber.toString(),
      settledAt: new Date(p.timestamp * 1000).toISOString(),
      dealId: p.dealId,
      buyer: p.buyer,
      seller: p.seller,
      token: p.token,
      amount: p.amount.toString(),
      payToken: p.payToken,
      price: p.price.toString(),
      fees: {
        total: p.fee.toString(),
        vault: (p.fee - p.referrerFee).toString(),
        referrer: p.referrerFee.toString(),
        relayer: p.relayerFee.toString(),
      },
      sellerProceeds: (p.price - p.fee - p.relayerFee).toString(),
      relayer: /^0x0{40}$/.test(p.relayer) ? null : p.relayer,
    };
    await ctx.cache.set(cacheKey, body, 86_400); // settled receipts are final
    return body;
  });

  // ------------------------------------------------------------------ buy-and-burn tracker (refreshed by the worker)
  app.get("/burn", async () => {
    const state = await ctx.cache.get<unknown>(`burn:${ctx.config.chainId}`);
    if (!state) throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, "Burn tracker has not run yet");
    return state;
  });

  // ------------------------------------------------------------------ live control panel (read from chain by the worker)
  app.get("/control", async () => {
    const state = await ctx.cache.get<unknown>(`control:${ctx.config.chainId}`);
    if (!state) throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, "Control panel has not been read from the chain yet");
    return state;
  });

  // ------------------------------------------------------------------ desk stats
  app.get("/stats", async () => {
    const cached = await ctx.cache.get<unknown>(`stats:${ctx.config.chainId}`);
    if (cached) return cached;
    const chainId = ctx.config.chainId;
    const now = ctx.now();
    const [dealCounts] = await ctx.db
      .select({
        accepted: sql<number>`count(*)::int`,
        settled: sql<number>`count(*) filter (where ${deals.status} = 'settled')::int`,
        refunded: sql<number>`count(*) filter (where ${deals.status} = 'refunded')::int`,
        tokensTraded: sql<number>`count(distinct ${deals.tokenAddress}) filter (where ${deals.status} = 'settled')::int`,
      })
      .from(deals)
      .where(eq(deals.chainId, chainId));
    const volume = await ctx.db
      .select({
        payToken: settlementTicks.payToken,
        volume: sql<string>`sum(${settlementTicks.price})::text`,
        fees: sql<string>`sum(${settlementTicks.fee})::text`,
        volumeUsd: sql<string | null>`sum(${settlementTicks.priceUsd})::text`,
        feesUsd: sql<string | null>`sum(${settlementTicks.feeUsd})::text`,
      })
      .from(settlementTicks)
      .where(eq(settlementTicks.chainId, chainId))
      .groupBy(settlementTicks.payToken);
    const [postings] = await ctx.db
      .select({
        posted: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where ${rfqs.status} = 'open' and ${rfqs.expiresAt} > ${now})::int`,
      })
      .from(rfqs)
      .where(eq(rfqs.chainId, chainId));
    const [answers] = await ctx.db
      .select({ sealed: sql<number>`count(*)::int` })
      .from(quotes)
      .innerJoin(rfqs, eq(rfqs.id, quotes.rfqId))
      .where(eq(rfqs.chainId, chainId));
    const [burned] = await ctx.db
      .select({ total: sql<string>`coalesce(sum(${burns.amountBurned}), 0)::text`, count: sql<number>`count(*)::int` })
      .from(burns)
      .where(eq(burns.chainId, chainId));
    // Saved vs DEX: for each settled deal with a USD value, the price impact the same size would
    // have paid as a market order on the token's pool (same constant-product model as the slippage
    // calculator: half the pool's liquidity Y per side, buying $S costs about S²/Y). Deals larger than
    // the pool side can't be compared and are counted separately.
    const ticks = await ctx.db
      .select({ token: settlementTicks.tokenAddress, usd: settlementTicks.priceUsd })
      .from(settlementTicks)
      .where(and(eq(settlementTicks.chainId, chainId), sql`${settlementTicks.priceUsd} is not null`));
    const liq = new Map<string, number | null>();
    for (const t of new Set(ticks.map((x) => x.token))) {
      const [snap] = await ctx.db
        .select({ l: dexSnapshots.liquidityUsd })
        .from(dexSnapshots)
        .where(and(eq(dexSnapshots.chainId, chainId), eq(dexSnapshots.tokenAddress, t)))
        .orderBy(desc(dexSnapshots.ts))
        .limit(1);
      liq.set(t, snap?.l ? Number(snap.l) : null);
    }
    let savedUsd = 0, compared = 0, beyondPool = 0, noPool = 0;
    for (const t of ticks) {
      const s = Number(t.usd), l = liq.get(t.token);
      if (!l || !(l > 0)) { noPool++; continue; }
      const y = l / 2;
      if (s >= y) { beyondPool++; continue; }
      savedUsd += (s * s) / y;
      compared++;
    }
    const body = {
      deals: dealCounts,
      savedVsDex: { usd: savedUsd.toFixed(2), compared, beyondPool, noPool },
      volumeByPayToken: volume,
      postings,
      sealedAnswers: answers?.sealed ?? 0,
      burn: { burnedByVault: burned?.total ?? "0", burns: burned?.count ?? 0, vault: ctx.config.vault },
      updatedAt: now.toISOString(),
      note: "Counts deals accepted through this desk and checked against the escrow. Open postings' prices are sealed and never counted.",
    };
    await ctx.cache.set(`stats:${chainId}`, body, 60);
    return body;
  });

  // ------------------------------------------------------------------ referrals
  app.get<{ Params: { address: string } }>("/referrals/:address", async (req) => {
    const address = parse(Address, req.params.address);
    const settledByMe = and(
      eq(deals.chainId, ctx.config.chainId),
      eq(deals.referrer, address),
      eq(deals.status, "settled"),
    );
    const totals = await ctx.db
      .select({
        payToken: deals.payToken,
        deals: sql<number>`count(*)::int`,
        earned: sql<string>`coalesce(sum(${deals.referrerFee}), 0)::text`,
      })
      .from(deals)
      .where(settledByMe)
      .groupBy(deals.payToken);
    const recent = await ctx.db
      .select({
        dealId: deals.dealId,
        token: deals.tokenAddress,
        payToken: deals.payToken,
        referrerFee: deals.referrerFee,
        settledAt: deals.settledAt,
        settleTx: deals.settleTx,
      })
      .from(deals)
      .where(settledByMe)
      .orderBy(desc(deals.settledAt))
      .limit(100);
    return {
      referrer: address,
      totals,
      deals: recent.map((d) => ({
        dealId: hex(d.dealId),
        token: d.token,
        payToken: d.payToken,
        earned: d.referrerFee,
        settledAt: d.settledAt?.toISOString() ?? null,
        txHash: hex(d.settleTx),
      })),
    };
  });
}
