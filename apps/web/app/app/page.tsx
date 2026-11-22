"use client";
import Link from "next/link";
import { useHScroll } from "@/lib/useHScroll";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RfqPublic } from "@sealdesk/sdk";
import { BlockCard } from "@/components/desk";
import { NewBlockDrawer, type Side } from "@/components/NewBlock";
import { ErrorNote, Segmented, Skeleton, Sparkline, TokenAvatar } from "@/components/ui";
import { api } from "@/lib/desk";
import { fmtPct } from "@/lib/format";
import { useMarkets, useNow, useStream, type MarketItem } from "@/lib/hooks";

type Tab = "all" | "buy" | "sell";
type Sort = "new" | "ending" | "hot";

const SORTS: { value: Sort; label: string }[] = [
  { value: "new", label: "New" },
  { value: "ending", label: "Ending" },
  { value: "hot", label: "Hot" },
];
const sorter: Record<Sort, (a: RfqPublic, b: RfqPublic) => number> = {
  new: (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  ending: (a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime(),
  hot: (a, b) => b.quoteCount - a.quoteCount || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
};

/** One column of the board: its own search and sort over the blocks it is given. */
function Column({ title, items, byToken, now, loading, onPost, empty }: {
  title: string;
  items: RfqPublic[];
  byToken: Map<string, MarketItem>;
  now: number;
  loading: boolean;
  onPost: () => void;
  empty: string;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("new");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items
      .filter((r) => !s || (byToken.get(r.token)?.symbol ?? "").toLowerCase().includes(s) || (byToken.get(r.token)?.name ?? "").toLowerCase().includes(s) || r.token.includes(s))
      .sort(sorter[sort]);
  }, [items, q, sort, byToken]);
  return (
    <section className="tcol panel" aria-label={title}>
      <div className="tcol-head">
        <strong>{title}</strong>
        <span className="tcol-count num">{items.length}</span>
        <input className="input tcol-search" placeholder="Symbol, 0x…" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${title}`} />
        <Segmented value={sort} onChange={setSort} label={`Sort ${title}`} options={SORTS} />
      </div>
      <div className="tcol-body" data-lenis-prevent>
        {loading && <div style={{ padding: 16 }}><Skeleton h={88} /><div style={{ height: 8 }} /><Skeleton h={88} /></div>}
        {!loading && shown.length === 0 && (
          <div className="empty">{q ? "Nothing matches that search." : empty} {!q && <button className="linkbtn" onClick={onPost}>Post one.</button>}</div>
        )}
        {shown.map((r) => {
          const m = byToken.get(r.token);
          return <BlockCard key={r.id} rfq={r} now={now} {...(m ? { symbol: m.symbol, name: m.name, kind: m.kind } : {})} />;
        })}
      </div>
    </section>
  );
}

export default function TerminalPage() {
  const [items, setItems] = useState<RfqPublic[] | null>(null);
  const [counts, setCounts] = useState({ open: 0, buying: 0, selling: 0, sealed: 0 });
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [drawer, setDrawer] = useState<Side | null>(null);
  const [drawerToken, setDrawerToken] = useState<string | null>(null);
  const [coinSel, setCoinSel] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  useHScroll(strip);
  const now = useNow(1000);
  const { data: markets } = useMarkets();
  const byToken = useMemo(() => new Map((markets ?? []).map((m) => [m.token, m])), [markets]);

  const load = useCallback(async () => {
    try {
      const r = await api.listRfqs({ sort: "new", limit: 100 });
      setItems(r.items);
      setCounts(r.counts);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 15_000);
    return () => clearInterval(iv);
  }, [load]);

  // New postings appear live.
  useStream("desk", null, () => void load());

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("new");
    if (p === "buy" || p === "sell") setDrawer(p);
  }, []);

  const post = (side: Side, token: string | null = null) => {
    setDrawerToken(token);
    setDrawer(side);
  };

  // Live open blocks, and per coin, from the same feed (so the strip updates with the board).
  const live = (items ?? []).filter((r) => new Date(r.expiresAt).getTime() > now);
  const openBy = new Map<string, { bids: number; listings: number }>();
  for (const r of live) {
    const o = openBy.get(r.token) ?? { bids: 0, listings: 0 };
    if (r.side === "buy") o.bids++; else o.listings++;
    openBy.set(r.token, o);
  }
  // Fixed listing order from the desk (the big names first), so the strip never reshuffles.
  const coins = markets ?? [];
  const coin = coinSel ? (markets ?? []).find((m) => m.token === coinSel) ?? null : null;
  const pool = coinSel ? live.filter((r) => r.token === coinSel) : live;
  const buyers = pool.filter((r) => r.side === "buy");
  const sellers = pool.filter((r) => r.side === "sell");
  const loading = items === null && !error;
  const nudge = (dir: 1 | -1) => strip.current?.scrollBy({ left: dir * strip.current.clientWidth * 0.8, behavior: "smooth" });

  return (
    <div className="wrap page terminal">
      <header className="thead panel">
        <div className="thead-copy">
          <div className="eyebrow">Private OTC · Terminal</div>
          <h1 className="display">Trade size. <span className="accent">Stay private.</span></h1>
          <p>Post a block. Get sealed answers only you can read. Settle both sides in one contract transaction.</p>
        </div>
        <dl className="thead-stats" aria-live="polite">
          {([["Open", counts.open], ["Buying", counts.buying], ["Selling", counts.selling], ["Sealed", counts.sealed]] as const).map(([l, v]) => (
            <div key={l}><dd className="num">{v}</dd><dt className="label">{l}</dt></div>
          ))}
        </dl>
        <div className="thead-actions">
          <button className="btn btn-buy" onClick={() => post("buy", coinSel)}>Buy a block</button>
          <button className="btn btn-sell" onClick={() => post("sell", coinSel)}>Sell privately</button>
        </div>
      </header>

      <section className="coins" aria-labelledby="coins-title">
        <div className="row between" style={{ marginBottom: 10, flexWrap: "wrap" }}>
          <h2 id="coins-title" className="label" style={{ margin: 0 }}>Markets · {markets?.length ?? "…"} coins</h2>
          <div className="row" style={{ ["--g" as string]: "6px" }}>
            <Link href="/markets" className="link" style={{ marginRight: 8 }}>Charts and details →</Link>
            <button className="iconbtn" onClick={() => nudge(-1)} aria-label="Scroll coins left">‹</button>
            <button className="iconbtn" onClick={() => nudge(1)} aria-label="Scroll coins right">›</button>
          </div>
        </div>
        <div ref={strip} className="coin-strip" role="listbox" aria-label="Filter blocks by coin">
          {!markets && Array.from({ length: 6 }, (_, i) => <div key={i} className="coin-tile"><Skeleton h={96} /></div>)}
          {coins.map((m) => {
            const o = openBy.get(m.token);
            const pts = (m.reference?.sparkline5d ?? []).map(([, c]) => Number(c));
            const price = m.reference ? Number(m.reference.price) : m.dex ? Number(m.dex.price) : null;
            const chg = m.reference?.changePct ?? m.dex?.change24hPct ?? null;
            const on = coinSel === m.token;
            return (
              <button key={m.token} type="button" role="option" aria-selected={on} className={`coin-tile${on ? " on" : ""}`} onClick={() => setCoinSel(on ? null : m.token)}>
                <span className="row" style={{ ["--g" as string]: "8px" }}>
                  <TokenAvatar symbol={m.symbol} size="sm" logoUrl={m.logoUrl} />
                  <span className="coin-name"><strong>{m.symbol}</strong><span className="dim">{m.name}</span></span>
                </span>
                <span className="row between" style={{ alignItems: "flex-end" }}>
                  <span className="num">
                    <span className="coin-px">{price !== null ? `$${price < 1 ? price.toPrecision(3) : price.toFixed(2)}` : m.kind === "token" ? "Not launched" : "OTC"}</span>
                    {chg && <span className={`coin-chg ${Number(chg) >= 0 ? "up" : "down"}`}>{fmtPct(chg)}</span>}
                  </span>
                  <Sparkline points={pts.slice(-60)} width={54} height={22} />
                </span>
                <span className={`coin-open${o ? " live" : ""}`}>{o ? `${o.bids} bid${o.bids === 1 ? "" : "s"} · ${o.listings} listing${o.listings === 1 ? "" : "s"}` : "No open blocks"}</span>
              </button>
            );
          })}
        </div>
      </section>

      {coin && (
        <div className="coin-bar panel">
          <TokenAvatar symbol={coin.symbol} size="sm" logoUrl={coin.logoUrl} />
          <span className="grow"><strong>{coin.symbol}</strong> <span className="dim">{coin.name} · showing its blocks only</span></span>
          <button className="btn btn-sm btn-buy" onClick={() => post("buy", coin.token)}>Buy {coin.symbol}</button>
          <button className="btn btn-sm btn-sell" onClick={() => post("sell", coin.token)}>Sell {coin.symbol}</button>
          <button className="btn btn-sm btn-ghost" onClick={() => setCoinSel(null)}>All coins</button>
        </div>
      )}

      {error ? <ErrorNote error={error} /> : null}

      {/* Narrow screens: one column with tabs. Wide screens: the three columns side by side. */}
      <div className="tboard-tabs">
        <Segmented value={tab} onChange={setTab} block label="Side" options={[{ value: "all", label: `New ${pool.length}` }, { value: "buy", label: `Buyers ${buyers.length}` }, { value: "sell", label: `Sellers ${sellers.length}` }]} />
      </div>
      <div className={`tboard show-${tab}`}>
        <div className="tboard-col all"><Column title="New" items={pool} byToken={byToken} now={now} loading={loading} onPost={() => post("buy", coinSel)} empty={coin ? `No open blocks for ${coin.symbol}.` : "No open blocks right now."} /></div>
        <div className="tboard-col buy"><Column title="Buyers" items={buyers} byToken={byToken} now={now} loading={loading} onPost={() => post("buy", coinSel)} empty={coin ? `Nobody is buying ${coin.symbol}.` : "No bids right now."} /></div>
        <div className="tboard-col sell"><Column title="Sellers" items={sellers} byToken={byToken} now={now} loading={loading} onPost={() => post("sell", coinSel)} empty={coin ? `Nobody is selling ${coin.symbol}.` : "No listings right now."} /></div>
      </div>

      <NewBlockDrawer open={drawer !== null} initialSide={drawer ?? "buy"} initialToken={drawerToken} onClose={() => { setDrawer(null); setDrawerToken(null); void load(); }} />
    </div>
  );
}
