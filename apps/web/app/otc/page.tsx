"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RfqPublic } from "@sealdesk/sdk";
import { api } from "@/lib/desk";
import { BRAND, CHAIN_NAME } from "@/lib/config";
import { toBase } from "@/lib/format";
import { useMarkets, useStream, type MarketItem } from "@/lib/hooks";
import { postBlock, type Pay, type Side, type Window } from "@/components/NewBlock";
import { PayNote, PayPicker } from "@/components/PayPicker";
import { PrivateLinkModal } from "@/components/desk";
import { ImpactNote } from "@/components/ImpactNote";
import { ErrorNote, Segmented, TokenAvatar } from "@/components/ui";

const WINDOWS: { value: Window; label: string }[] = [
  { value: "15m", label: "15 min" },
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
  { value: "24h", label: "24 hours" },
];
const MIN_USD = 5;

/**
 * Reference price for a market (the listed stock's delayed price, or the token's pool price) and
 * the pool's liquidity, for the price-impact estimate.
 */
function usePrice(m: MarketItem | undefined) {
  const [pool, setPool] = useState<{ price: number; liquidity: number | null } | null>(null);
  useEffect(() => {
    setPool(null);
    if (!m) return;
    api.tokenMarket(m.token).then((r) => setPool({ price: Number(r.priceUsd), liquidity: r.liquidityUsd ? Number(r.liquidityUsd) : null }), () => setPool(null));
  }, [m]);
  return { price: m?.reference ? Number(m.reference.price) : pool?.price ?? null, liquidity: pool?.liquidity ?? null };
}

function Ticket() {
  const { data: markets } = useMarkets();
  const [side, setSide] = useState<Side>("buy");
  const [sym, setSym] = useState("");
  const [value, setValue] = useState("");
  const [pay, setPay] = useState<Pay>("USD");
  const [win, setWin] = useState<Window>("24h");
  const [partial, setPartial] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("side") === "sell") setSide("sell");
  }, []);

  const m = markets?.find((x) => x.symbol === sym);
  const { price, liquidity } = usePrice(m);
  const n = Number(value) || 0;
  // Buy: you type dollars, the block size in tokens follows. Sell: you type tokens.
  const qty = side === "buy" ? (price ? n / price : 0) : n;
  const usd = side === "buy" ? n : price ? n * price : 0;
  const amount = useMemo(() => (m && qty > 0 ? toBase(qty.toFixed(Math.min(6, m.decimals)), m.decimals) : null), [m, qty]);
  const tooSmall = side === "buy" && n > 0 && n < MIN_USD;
  const ready = !!m && !!amount && !tooSmall && !busy;

  const submit = async () => {
    if (!m || !amount) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postBlock({ side, token: m.token, amount, pay, window: win, allowPartial: partial, ...(usd > 0 ? { sizeUsd: usd.toFixed(2) } : {}) });
      setCreated(r.link);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const tokenSelect = (
    <select className={`input otc-select${sym ? " on" : ""}`} value={sym} onChange={(e) => setSym(e.target.value)} aria-label="Token">
      <option value="">Select token</option>
      {(markets ?? []).map((x) => <option key={x.symbol} value={x.symbol}>{x.symbol} · {x.name}</option>)}
    </select>
  );

  return (
    <div className="otc-card" data-ui>
      <Segmented value={side} onChange={(v) => { setSide(v); setValue(""); }} block tone={side === "sell" ? "sell" : undefined} label="Side" options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />

      <div className="otc-leg">
        <span className="label">{side === "buy" ? "You pay" : "You sell"}</span>
        <div className="otc-row">
          {side === "buy" && <span className="otc-cur">$</span>}
          <input className="otc-amount num" inputMode="decimal" placeholder="0" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))} aria-label={side === "buy" ? "Amount in USD" : "Amount of tokens"} />
          {side === "buy" ? <span className="badge badge-dim">USD</span> : tokenSelect}
        </div>
        <div className="row between" style={{ flexWrap: "wrap" }}>
          <span className={`hint${tooSmall ? " down" : ""}`} style={{ margin: 0 }}>
            {side === "buy" ? `Minimum $${MIN_USD}` : usd > 0 ? `≈ $${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })} at the reference price` : "Token amount"}
          </span>
          <div className="row" style={{ ["--g" as string]: "8px" }}>
            <span className="label">{side === "buy" ? "Pay with" : "Get paid in"}</span>
            <PayPicker value={pay} onChange={setPay} label="Payment token" token={m?.symbol ?? null} />
          </div>
        </div>
      </div>

      <div className="otc-arrow" aria-hidden>↓</div>

      <div className="otc-leg">
        <span className="label">{side === "buy" ? "You buy" : "You get"}</span>
        <div className="otc-row">
          <span className="otc-sealed">{side === "buy" ? "sealed offers" : "sealed bids"}</span>
          {side === "buy" ? tokenSelect : <span className="badge badge-dim">{pay === "TOKEN" ? `$${BRAND.token}` : pay}</span>}
        </div>
        <span className="hint" style={{ margin: 0 }}>
          {!m ? (side === "buy" ? "Pick the token you want to buy." : "Pick the token you want to sell.")
            : side === "buy" && qty > 0 ? `≈ ${qty.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${m.symbol} at the reference price. Sellers answer with their own price.`
            : `Answers are sealed to you. Nobody else reads them.`}
        </span>
      </div>

      <div className="row between" style={{ flexWrap: "wrap", ["--g" as string]: "10px" }}>
        <span className="label">Open for</span>
        <Segmented value={win} onChange={setWin} label="Open for" options={WINDOWS} />
      </div>
      <PayNote pay={pay} />
      <label className="toggle">
        <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
        <span>Allow partial fills: several {side === "buy" ? "sellers" : "buyers"} can each fill part</span>
      </label>

      {m && <ImpactNote side={side} symbol={m.symbol} sizeUsd={usd} liquidityUsd={liquidity} />}
      <ErrorNote error={error} />
      <button className={`btn btn-lg btn-block ${side === "buy" ? "btn-buy" : "btn-sell"}`} disabled={!ready} onClick={() => void submit()}>
        {busy ? "Creating…" : side === "buy" ? "Create private bid" : "Create private listing"}
      </button>
      <p className="hint" style={{ margin: 0, textAlign: "center" }}>Non-custodial. Settled on-chain in one transaction. Prices sealed to you.</p>

      {created && <PrivateLinkModal open kind="rfq" link={created} onClose={() => { setCreated(null); setValue(""); }} />}
    </div>
  );
}

function Demand() {
  const { data: markets } = useMarkets();
  const [items, setItems] = useState<RfqPublic[] | null>(null);
  const load = useCallback(() => api.listRfqs({ sort: "new", limit: 12 }).then((r) => setItems(r.items), () => setItems([])), []);
  useEffect(() => { void load(); }, [load]);
  useStream("desk", null, () => void load());
  const bySym = new Map((markets ?? []).map((m) => [m.token, m]));
  const open = (items ?? []).filter((r) => new Date(r.expiresAt).getTime() > Date.now());
  if (items && !open.length) return <div className="empty">No open blocks right now. <Link href="/app?new=buy" className="link">Post the first one.</Link></div>;
  return (
    <ul className="demand">
      {open.map((r) => {
        const m = bySym.get(r.token);
        const sym = m?.symbol ?? `${r.token.slice(0, 6)}…`;
        return (
          <li key={r.id}>
            <Link href={`/rfq/${r.id}`}>
              <TokenAvatar symbol={m?.symbol ?? "?"} size="sm" />
              <span className="grow"><strong>{sym}</strong><span className="dim">{m?.name ?? "Token"}</span></span>
              <span className="num">{r.sizeUsd ? `~$${Number(r.sizeUsd).toLocaleString("en-US", { notation: "compact" })}` : "size on request"}</span>
              <span className={`badge ${r.side === "buy" ? "badge-buy" : "badge-sell"}`}>{r.side === "buy" ? "Bid" : "For sale"}</span>
              <span className="demand-go">{r.side === "buy" ? "Sell into →" : "Bid →"}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function OtcPage() {
  return (
    <div className="wrap page">
      <section className="otc-hero">
        <h1 className="display">Private blocks.<span className="second">Sealed until settled.</span></h1>
        <Ticket />
        <ol className="feature-list" style={{ marginTop: 56 }}>
          {[["1", "Post your size", "Token and size. No account; you get a private link."], ["2", "Counterparties answer privately", "Only you can read the answers. No public order book."], ["3", "Settle in one transaction", "Payment locks in the contract first. The swap completes in full or not at all."]].map(([n, t, d]) => (
            <li key={n} data-reveal><span className="eyebrow">{n}</span><strong>{t}</strong><p>{d}</p></li>
          ))}
        </ol>
      </section>

      <section className="section">
        <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)", alignItems: "center" }}>
          <div className="stack" style={{ ["--g" as string]: "20px" }}>
            <h2 className="display" style={{ fontSize: "var(--t-h2)", margin: 0 }}>Move size.<span className="second" style={{ display: "block", color: "#5f5f5a" }}>Not the price.</span></h2>
            <p className="muted" style={{ margin: 0, fontSize: 17 }}>The desk brings buyers, sellers, teams and agents together for private block trades on {CHAIN_NAME}.</p>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <Link href="/app?new=buy" className="btn btn-lg btn-buy">Place a bid</Link>
              <Link href="/otc?side=sell" className="btn btn-lg">Sell privately</Link>
            </div>
          </div>
          <div className="stack" style={{ ["--g" as string]: "10px" }} aria-label="Example sealed offers">
            {[["NVDA", "4,000"], ["TSLA", "2,500"], ["SPY", "750"]].map(([s, q]) => (
              <div key={s} className="sealed-row" data-reveal><TokenAvatar symbol={s!} size="sm" /><strong>{s}</strong><span className="num grow">{q}</span><span className="sealed">••••••</span><span className="badge badge-dim">sealed</span></div>
            ))}
            <span className="hint">Example · sealed offers · only the buyer can read them</span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><div><div className="eyebrow">{CHAIN_NAME} · open blocks, live</div><h2 className="display">Where demand<span className="second">is forming.</span></h2></div><Link href="/app" className="btn btn-ghost">Terminal →</Link></div>
        <Demand />
      </section>

      <section className="section">
        <div className="section-head"><div><div className="eyebrow">The desk</div><h2 className="display">Bid. Offer.<span className="second">Swap.</span></h2></div></div>
        <div className="bos">
          <article data-reveal>
            <span className="eyebrow">01</span><h3>Buyer demand</h3><p>Set your size. Sellers come to you.</p>
            <div className="row" style={{ flexWrap: "wrap", ["--g" as string]: "6px" }}>{["$250K", "$1M", "$5M", "+ your size"].map((x) => <span key={x} className="chip">{x}</span>)}</div>
            <Link href="/app?new=buy" className="link">Place a bid →</Link>
          </article>
          <article data-reveal>
            <span className="eyebrow">02</span><h3>Private offers</h3><p>One buyer sees it. Nobody else.</p>
            <div className="sealed-row"><span>Offer</span><span className="sealed grow">••••••</span><span className="dim">visible to the buyer only</span></div>
            <Link href="/otc?side=sell" className="link">Sell OTC →</Link>
          </article>
          <article data-reveal>
            <span className="eyebrow">03</span><h3>Settlement contract</h3><p>One transaction swaps both sides. Or everyone gets their funds back.</p>
            <div className="flow"><span>payment locks</span><i>→</i><span>tokens in</span><i>→</i><span>swap</span></div>
            <Link href="/how" className="link">How it works →</Link>
          </article>
          <article data-reveal>
            <span className="eyebrow">04</span><h3>Ghost mode</h3><p>Sell from a one-time wallet. Gas paid for you.</p>
            <div className="flow num"><span>0x7a…c01d</span><i>→</i><span>0x9b…07fa</span></div>
            <Link href="/security" className="link">Privacy details →</Link>
          </article>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><div><div className="eyebrow">Ghost mode</div><h2 className="display">Nothing links<span className="second">back to you.</span></h2></div></div>
        <p className="muted" style={{ marginTop: -24, marginBottom: 32, fontSize: 17 }}>Sell from a one-time wallet. Get paid to a fresh address. The buyer never sees your main wallet.</p>
        <div className="ghost" data-ui>
          <div><span className="label">Seller</span><strong>one-time wallet</strong><span className="dim">tokens →</span></div>
          <div className="ghost-c"><span className="label">Contract</span><strong>settlement contract</strong><span className="dim">no owner · no admin key</span></div>
          <div><span className="label">Buyer</span><strong>tokens arrive</strong><span className="dim">one atomic swap</span></div>
        </div>
        <p className="hint" style={{ marginTop: 16 }}>Payment goes to a fresh payout address. Private, not anonymous: moving tokens into the one-time wallet is still a public transfer. It is not a mixer.</p>
      </section>
    </div>
  );
}
