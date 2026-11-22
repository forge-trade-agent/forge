"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/desk";
import { fmtUsd } from "@/lib/format";
import { useMarkets, type MarketItem } from "@/lib/hooks";
import { CHAIN_NAME } from "@/lib/config";
import { priceImpact } from "@/lib/impact";
import { Copy, ErrorNote, Segmented, Skeleton, TokenAvatar } from "@/components/ui";

type Side = "buy" | "sell";
interface Pool { priceUsd: number; liquidityUsd: number }
const PRESETS = [1_000, 10_000, 50_000, 100_000] as const;

const impact = (side: Side, size: number, liquidity: number) => priceImpact(side, size, liquidity);

const kUsd = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);
const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;

export default function SlippagePage() {
  const { data: markets, error } = useMarkets();
  const [side, setSide] = useState<Side>("buy");
  const [raw, setRaw] = useState("50000");
  const [pools, setPools] = useState<Record<string, Pool | null>>({});

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("size")) setRaw(p.get("size")!.replace(/[^0-9.]/g, ""));
    if (p.get("side") === "sell") setSide("sell");
  }, []);

  // Keep the URL shareable.
  useEffect(() => {
    const u = new URL(window.location.href);
    u.searchParams.set("size", raw || "0");
    if (side === "sell") u.searchParams.set("side", "sell"); else u.searchParams.delete("side");
    window.history.replaceState(null, "", u);
  }, [raw, side]);

  useEffect(() => {
    if (!markets) return;
    let live = true;
    void Promise.all(
      markets.map(async (m) => {
        try {
          const r = await api.tokenMarket(m.token);
          return [m.token, { priceUsd: Number(r.priceUsd), liquidityUsd: Number(r.liquidityUsd ?? 0) }] as const;
        } catch {
          return [m.token, null] as const;
        }
      }),
    ).then((rows) => live && setPools(Object.fromEntries(rows)));
    return () => { live = false; };
  }, [markets]);

  const size = Number(raw) || 0;
  const rows = useMemo(() => {
    return (markets ?? []).map((m) => {
      const pool = pools[m.token];
      const imp = pool ? impact(side, size, pool.liquidityUsd) : null;
      return { m, pool, imp, cost: imp === null ? null : size * imp };
    }).sort((a, b) => (b.cost ?? Infinity) - (a.cost ?? Infinity));
  }, [markets, pools, side, size]);

  const loaded = markets && Object.keys(pools).length > 0;
  const best = rows.filter((r) => r.cost !== null).at(-1);

  return (
    <div className="wrap page">
      <div className="page-head">
        <div className="eyebrow">Slippage</div>
        <h1 className="display">The cost of size.<span className="second">On-chain.</span></h1>
        <p>What a block costs as a market order on {CHAIN_NAME}&apos;s DEX pools, for every market we list. On <Link href="/app" className="link">the desk</Link> the same size trades at one price both sides agree, settled in one transaction.</p>
      </div>

      <section className="panel panel-pad" data-ui>
        <div className="row" style={{ flexWrap: "wrap", ["--g" as string]: "16px", alignItems: "flex-end" }}>
          <Segmented value={side} onChange={setSide} tone={side === "sell" ? "sell" : undefined} label="Side" options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />
          <label className="field" style={{ margin: 0 }}>
            <span className="label">Size (USD)</span>
            <input className="input num" style={{ width: 200 }} inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Size in USD" />
          </label>
          <div className="row" style={{ flexWrap: "wrap", ["--g" as string]: "6px" }}>
            {PRESETS.map((p) => (
              <button key={p} type="button" className="chip" aria-pressed={size === p} onClick={() => setRaw(String(p))}>{kUsd(p)}</button>
            ))}
          </div>
        </div>
        {best && size > 0 && (
          <p className="slip-lead">
            {side === "buy" ? "Buying" : "Selling"} {kUsd(size)} of {best.m.symbol} on a DEX costs about{" "}
            <b className="down">{fmtUsd(String(best.cost), 0)}</b> in price impact ({pct(best.imp!)}). That is the deepest pool we list.
          </p>
        )}
      </section>

      <ErrorNote error={error} />
      <section className="panel" style={{ marginTop: 24, overflowX: "auto" }}>
        {!loaded ? (
          <div style={{ padding: 18 }}><Skeleton h={320} /></div>
        ) : (
          <table className="table slip-table">
            <thead>
              <tr><th>Market</th><th>DEX price</th><th>Pool liquidity</th><th>{side === "buy" ? "Buy" : "Sell"} impact</th><th>Cost</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {rows.map(({ m, pool, imp, cost }) => <Row key={m.token} m={m} pool={pool} imp={imp} cost={cost} side={side} size={size} />)}
            </tbody>
          </table>
        )}
      </section>
      <p className="hint" style={{ marginTop: 16 }}>
        Estimate from each token&apos;s deepest DEX pool, constant-product model with half the pool&apos;s liquidity on each side: buying $S costs about S/Y more than the pool price, selling returns about S/(Y+S) less. Concentrated-liquidity pools can be deeper or thinner near the price, and fees and gas come on top. Reference only, not a quote.
      </p>
    </div>
  );
}

function Row({ m, pool, imp, cost, side, size }: { m: MarketItem; pool: Pool | null | undefined; imp: number | null; cost: number | null; side: Side; size: number }) {
  const share = typeof window === "undefined" ? "" : `${window.location.origin}/slippage?size=${size}${side === "sell" ? "&side=sell" : ""}&m=${m.symbol}`;
  return (
    <tr>
      <td>
        <div className="row"><TokenAvatar symbol={m.symbol} size="sm" /><div><strong>{m.symbol}</strong><div className="dim" style={{ fontSize: 13 }}>{m.name}</div></div></div>
      </td>
      <td className="num">{pool ? fmtUsd(String(pool.priceUsd), pool.priceUsd < 1 ? 7 : 2) : "–"}</td>
      <td className="num">{pool ? kUsd(pool.liquidityUsd) : "–"}</td>
      <td className="num">{!pool ? <span className="dim">no pool</span> : imp === null ? <span className="down">pool too thin</span> : pct(imp)}</td>
      <td className="num">{cost === null ? "–" : <span className={cost > size * 0.05 ? "down" : undefined}>{fmtUsd(String(cost), 0)}</span>}</td>
      <td>
        <div className="row" style={{ justifyContent: "flex-end", ["--g" as string]: "6px" }}>
          <Link className="btn btn-sm btn-buy" href={`/trade?ca=${m.token}${side === "sell" ? "&side=sell" : ""}`}>Post OTC</Link>
          <Copy text={share} label={`Copy a link to this ${m.symbol} estimate`} />
        </div>
      </td>
    </tr>
  );
}
