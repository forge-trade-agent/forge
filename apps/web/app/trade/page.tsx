"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Hex } from "@sealdesk/sdk";
import { ConnectButton } from "@/components/chrome";
import { BlockCard, PrivateLinkModal } from "@/components/desk";
import { postBlock, type Pay } from "@/components/NewBlock";
import { PayNote, PayPicker } from "@/components/PayPicker";
import { MarketPicker } from "@/components/MarketPicker";
import { ImpactNote } from "@/components/ImpactNote";
import { ErrorNote, Segmented, TokenAvatar } from "@/components/ui";
import { api, balanceOf, tokenFacts } from "@/lib/desk";
import { fmtPct, fmtUnits, fmtUsd, toBase } from "@/lib/format";
import { useAsync, useLinks, useMarkets, useNow } from "@/lib/hooks";
import { parseTicket } from "@/lib/nl";
import { useWallet } from "@/lib/wallet";

type Win = "15m" | "1h" | "6h" | "24h";

export default function TradePage() {
  const w = useWallet();
  const now = useNow(1000);
  const { data: markets } = useMarkets();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [ca, setCa] = useState("");
  const [sizeIn, setSizeIn] = useState<"usd" | "tokens">("usd");
  const [size, setSize] = useState("");
  const [pay, setPay] = useState<Pay>("USD");
  const [win, setWin] = useState<Win>("1h");
  const [partial, setPartial] = useState(false);
  const [note, setNote] = useState("");
  const [describe, setDescribe] = useState("");
  const [nlMsg, setNlMsg] = useState<string | null>(null);
  const [bal, setBal] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<string | null>(null);
  const saved = useLinks();

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("ca")) setCa(q.get("ca")!);
    if (q.get("side") === "sell") setSide("sell");
  }, []);

  const valid = /^0x[0-9a-fA-F]{40}$/.test(ca);
  const token = valid ? (ca.toLowerCase() as Hex) : null;
  const { data: facts, error: factsErr } = useAsync(() => (token ? tokenFacts(token) : Promise.resolve(null)), [token]);
  const { data: market } = useAsync(() => (token ? api.tokenMarket(token).catch(() => null) : Promise.resolve(null)), [token]);
  const other = side === "buy" ? "sell" : "buy";
  // With a token picked: its open blocks on the other side. Without one: the whole desk's.
  const { data: book } = useAsync(() => api.listRfqs({ ...(token ? { token } : {}), side: other, limit: token ? 50 : 8 }), [token, other, created]);
  const bySym = useMemo(() => new Map((markets ?? []).map((x) => [x.token, x.symbol])), [markets]);
  // Your wallet: every listed token you hold, read from the chain (again every 20s while connected).
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (!w.address) return;
    const iv = setInterval(() => setRev((r) => r + 1), 20_000);
    return () => clearInterval(iv);
  }, [w.address]);
  const { data: holdings } = useAsync(async () => {
    if (!w.address || !markets) return null;
    const rows = await Promise.all(markets.map(async (x) => ({ m: x, bal: await balanceOf(x.token, w.address!).catch(() => 0n) })));
    return rows.filter((r) => r.bal > 0n);
  }, [w.address, markets, created, rev]);
  const m = markets?.find((x) => x.token === token);
  const priceUsd = market ? Number(market.priceUsd) : m?.reference ? Number(m.reference.price) : null;
  const decimals = facts?.decimals ?? null;

  useEffect(() => {
    if (!w.address || !token) return setBal(null);
    balanceOf(side === "sell" ? token : ("0x0000000000000000000000000000000000000000" as Hex), w.address).then(setBal, () => setBal(null));
  }, [w.address, token, side]);

  const amount = useMemo(() => {
    if (decimals === null) return null;
    if (sizeIn === "tokens") return toBase(size, decimals);
    const usd = Number(size.replace(/,/g, ""));
    if (!priceUsd || !Number.isFinite(usd) || usd <= 0) return null;
    return toBase((usd / priceUsd).toFixed(Math.min(decimals, 8)), decimals);
  }, [size, sizeIn, decimals, priceUsd]);

  const fill = () => {
    const r = parseTicket(describe, (markets ?? []).map((x) => x.symbol));
    if (r.side) setSide(r.side);
    if (r.symbol) {
      const mm = markets?.find((x) => x.symbol === r.symbol);
      if (mm) setCa(mm.token);
    }
    if (r.size) setSize(r.size);
    if (r.sizeIn) setSizeIn(r.sizeIn);
    if (r.pay) setPay(r.pay);
    if (r.window && r.window !== "4h") setWin(r.window);
    if (r.allowPartial !== undefined) setPartial(r.allowPartial);
    setNlMsg(r.unknown.length ? `Couldn't tell the ${r.unknown.join(", ")}. Set it below.` : "Ticket filled. Check it before posting.");
  };

  const setPct = (pct: number) => {
    if (bal === null || decimals === null || side !== "sell") return;
    setSizeIn("tokens");
    setSize(fmtUnits((bal * BigInt(pct)) / 100n, decimals, 8).replace(/,/g, ""));
  };

  const submit = async () => {
    if (!token || !amount) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postBlock({
        side, token, amount, pay, window: win, allowPartial: partial,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(sizeIn === "usd" && size ? { sizeUsd: Number(size.replace(/,/g, "")).toFixed(2) } : {}),
      });
      setCreated(r.link);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const sym = facts?.symbol ?? m?.symbol ?? "token";
  return (
    <div className="wrap page">
      <div className="page-head">
        <h1 className="display">{side === "buy" ? "Buy OTC" : "Sell OTC"}</h1>
        <p>Set your size. Counterparties answer privately. Only you see the prices. Pick one answer, both sides deposit into the contract, swap in one transaction. <Link className="link" href="/how">How it works</Link></p>
      </div>

      <div className="panel panel-pad stack" style={{ ["--g" as string]: "8px", marginBottom: 16 }}>
        <div className="row">
          <span style={{ color: "var(--accent)" }}>✦</span>
          <input className="input grow" placeholder='Describe it: "Sell 500 NVDA for ETH within 1 hour"' value={describe} onChange={(e) => setDescribe(e.target.value)} onKeyDown={(e) => e.key === "Enter" && fill()} aria-label="Describe your trade" />
          <button className="btn" onClick={fill} disabled={!describe.trim()}>Fill</button>
        </div>
        <span className="hint">{nlMsg ?? "Read in your browser only. Don't type personal details."}</span>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Order ticket</span>
            <Segmented value={side} onChange={setSide} tone={side === "sell" ? "sell" : undefined} label="Side" options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />
          </div>
          <div className="panel-pad stack" style={{ ["--g" as string]: "16px" }} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && amount && void submit()}>
            <div className="field">
              <span className="label">Contract address</span>
              <input className={`input${ca && !valid ? " invalid" : ""}`} placeholder="0x… any ERC-20 on this chain" value={ca} onChange={(e) => setCa(e.target.value.trim())} spellCheck={false} />
              <MarketPicker markets={markets ?? []} value={token ?? ""} onPick={setCa} />
              {factsErr ? <ErrorNote error={factsErr} /> : null}
              {facts && !facts.hasCode && <div className="errbox">No contract at this address.</div>}
            </div>

            {facts?.hasCode && (
              <div className="row panel" style={{ padding: 12, background: "var(--bg-2)" }}>
                <TokenAvatar symbol={sym} />
                <div className="grow">
                  <strong>{sym}</strong> <span className="dim">· {facts.name}</span>
                  <div className="dim" style={{ fontSize: 12 }}>
                    {market ? <>MC {fmtUsd(market.marketCapUsd)} · Price {fmtUsd(market.priceUsd)}</> : "No DEX market seen"}
                    {m?.reference?.changePct ? <> · <span className={Number(m.reference.changePct) >= 0 ? "up" : "down"}>{fmtPct(m.reference.changePct)}</span></> : null}
                    {facts.permit ? " · gasless deposit (permit)" : ""}
                  </div>
                </div>
              </div>
            )}

            <div className="field">
              <div className="row between">
                <span className="label">{side === "sell" ? "Balance" : "Buying power"}</span>
                {w.address ? <span className="mono" style={{ fontSize: 12 }}>{bal !== null ? `${fmtUnits(bal, side === "sell" ? (decimals ?? 18) : 18, 4)} ${side === "sell" ? sym : "ETH"}` : "…"}</span> : <ConnectButton compact />}
              </div>
            </div>

            <div className="field">
              <div className="row between">
                <span className="label">Size ({sizeIn === "usd" ? "USD" : sym})</span>
                <Segmented value={sizeIn} onChange={setSizeIn} label="Size unit" options={[{ value: "usd", label: "USD" }, { value: "tokens", label: "Tokens" }]} />
              </div>
              <input className="input big num" inputMode="decimal" placeholder={sizeIn === "usd" ? "25,000" : "100"} value={size} onChange={(e) => setSize(e.target.value)} />
              <div className="row" style={{ ["--g" as string]: "6px" }}>
                {[25, 50, 75, 100].map((pct) => (
                  <button key={pct} className="chip" disabled={side !== "sell" || bal === null} onClick={() => setPct(pct)}>{pct === 100 ? "MAX" : `${pct}%`}</button>
                ))}
                <span className="hint grow" style={{ textAlign: "right" }}>
                  {amount && decimals !== null ? `≈ ${fmtUnits(amount, decimals, 4)} ${sym}${priceUsd ? ` at ${fmtUsd(priceUsd)}` : ""}` : sizeIn === "usd" && !priceUsd && token ? "No reference price: size in tokens" : "–"}
                </span>
              </div>
            </div>

            <div className="row between" style={{ flexWrap: "wrap", ["--g" as string]: "16px" }}>
              <div className="field">
                <span className="label">Pay with</span>
                <PayPicker value={pay} onChange={setPay} token={sym} />
                <PayNote pay={pay} />
              </div>
              <div className="field">
                <span className="label">Offer window</span>
                <Segmented value={win} onChange={setWin} label="Offer window" options={[{ value: "15m", label: "15 min" }, { value: "1h", label: "1 hour" }, { value: "6h", label: "6 hours" }, { value: "24h", label: "24 hours" }]} />
              </div>
            </div>

            <label className="toggle">
              <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
              <span><strong>Allow partial fills</strong><span className="hint" style={{ display: "block" }}>Several counterparties can each fill part of your size. Each part settles as its own deal.</span></span>
            </label>
            <details>
              <summary className="label" style={{ cursor: "pointer" }}>Advanced</summary>
              <div className="field" style={{ marginTop: 10 }}>
                <span className="label">Note to counterparties (public, optional)</span>
                <input className="input" maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </details>
            {token && (
              <ImpactNote
                side={side}
                symbol={sym}
                sizeUsd={sizeIn === "usd" ? Number(size.replace(/,/g, "")) || 0 : priceUsd ? (Number(size.replace(/,/g, "")) || 0) * priceUsd : 0}
                liquidityUsd={market?.liquidityUsd ? Number(market.liquidityUsd) : null}
              />
            )}
            <ErrorNote error={error} />
            <button className={`btn btn-lg btn-block ${side === "buy" ? "btn-buy" : "btn-sell"}`} disabled={!amount || busy} onClick={() => void submit()}>
              {busy ? "Posting…" : side === "buy" ? "Place a private bid" : "List privately"} <span className="dim" style={{ marginLeft: 8 }}>ENTER ↵</span>
            </button>
            <span className="hint">Free to post. Prices are sealed to you. Fee only when it settles (2.5% max).</span>
          </div>
        </section>

        <aside className="stack" style={{ ["--g" as string]: "16px" }}>
          <div className="panel panel-pad stack" style={{ ["--g" as string]: "10px" }}>
            <div className="row between"><strong>Your wallet</strong><span className="dim" style={{ fontSize: 13 }}>{holdings ? `${holdings.length} token${holdings.length === 1 ? "" : "s"}` : ""}</span></div>
            {!w.address ? (
              <><span className="muted" style={{ fontSize: 13 }}>Connect your wallet to see your tokens and sell them privately in one click.</span><ConnectButton /></>
            ) : !holdings ? (
              <span className="muted" style={{ fontSize: 13 }}>Reading your balances…</span>
            ) : !holdings.length ? (
              <span className="muted" style={{ fontSize: 13 }}>No listed tokens in this wallet. Any other ERC-20 works by pasting its contract.</span>
            ) : (
              <ul className="holdings">
                {holdings.map(({ m: x, bal: b }) => {
                  const px = x.reference ? Number(x.reference.price) : x.dex ? Number(x.dex.price) : null;
                  const qty = Number(fmtUnits(b, x.decimals, 6).replace(/,/g, ""));
                  return (
                    <li key={x.token}>
                      <TokenAvatar symbol={x.symbol} size="sm" />
                      <span className="grow"><strong>{x.symbol}</strong><span className="dim num">{fmtUnits(b, x.decimals, 2)}{px ? ` · ~${fmtUsd(qty * px, 0)}` : ""}</span></span>
                      <button type="button" className="btn btn-sm btn-sell" onClick={() => { setCa(x.token); setSide("sell"); setSizeIn("tokens"); setSize(""); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Sell privately</button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="panel">
            <div className="panel-head"><strong>{side === "buy" ? "Sell-side supply" : "Buy-side demand"}</strong><span className="dim" style={{ fontSize: 13 }}>{token ? sym : "all tokens"} · anonymous</span></div>
            {!book?.items.length ? (
              <div className="empty">No {side === "buy" ? "sellers" : "buyers"} listed{token ? ` for ${sym}` : ""} right now.</div>
            ) : (
              book.items.map((r) => <BlockCard key={r.id} rfq={r} now={now} symbol={bySym.get(r.token) ?? (token ? sym : `${r.token.slice(0, 6)}…`)} />)
            )}
          </div>
          <div className="panel">
            <div className="panel-head"><strong>Your blocks</strong><Link href="/mine" className="link">all →</Link></div>
            {saved.length === 0 ? <div className="empty">Your bids and listings show up here. Private links are kept in this browser.</div> : (
              <div className="stack" style={{ padding: 12, ["--g" as string]: "6px" }}>
                {saved.slice(0, 5).map((l) => (
                  <a key={l.kind + l.id} href={l.link} className="row between chip" style={{ height: 34 }}>
                    <span>{l.kind === "rfq" ? (l.side === "sell" ? "Listing" : "Bid") : "Answer"} {l.id.slice(0, 8)}</span><span>open →</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
      {created && <PrivateLinkModal open kind="rfq" link={created} onClose={() => setCreated(null)} />}
    </div>
  );
}
