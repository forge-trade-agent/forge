"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { BRAND } from "@/lib/config";
import { api } from "@/lib/desk";
import { fmtPct, fmtUsd } from "@/lib/format";
import { useAsync, useMarkets, type MarketItem } from "@/lib/hooks";
import { AddressPill, ErrorNote, Segmented, Skeleton, Sparkline, TokenAvatar } from "./ui";

type Range = "1D" | "5D" | "1M" | "6M" | "1Y";
const RANGES: Range[] = ["1D", "5D", "1M", "6M", "1Y"];

// Chart colours: lime for up, the sell pink for down, quiet greys for the frame.
const UP = "#d4ff2a";
const DOWN = "#ff5a6e";
const INK = "#8d8d86";

// Reference listings trade in New York, so every time on the chart is New York time.
const TZ = "America/New_York";
const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });
const fmtMonth = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", year: "numeric" });
const toDate = (t: Time) => new Date((t as number) * 1000);
const et = (d: Date, intraday: boolean) => (intraday ? `${fmtTime.format(d)} ET` : fmtDay.format(d));

interface Bar { time: number; open: number; high: number; low: number; close: number; volume?: number | null }

const dp = (p: number) => (p >= 1000 ? 2 : p >= 1 ? 2 : p >= 0.01 ? 4 : 8);
const px = (p: number) => p.toFixed(dp(p));

export function PriceChart({ symbol, range, prevClose, onAsOf }: { symbol: string; range: Range; prevClose: number | null; onAsOf?: (iso: string | null) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const { data, error } = useAsync(() => api.chart(symbol, range), [symbol, range]);
  const [hover, setHover] = useState<Bar | null>(null);
  const intraday = range === "1D" || range === "5D";
  const bars: Bar[] = useMemo(() => data?.candles ?? [], [data]);
  const last = bars.at(-1) ?? null;

  useEffect(() => onAsOf?.(data?.asOf ?? null), [data, onAsOf]);

  // One chart per range (the time axis format depends on it).
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: INK,
        fontFamily: "var(--font-sans), system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.05)" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: {
        borderVisible: false,
        timeVisible: intraday,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          const d = toDate(t);
          if (type === TickMarkType.Year || type === TickMarkType.Month) return fmtMonth.format(d);
          if (type === TickMarkType.DayOfMonth) return fmtDay.format(d);
          return `${fmtTime.format(d)} ET`;
        },
      },
      localization: { timeFormatter: (t: Time) => et(toDate(t), intraday), priceFormatter: (p: number) => px(p) },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.25)", style: LineStyle.Dashed, labelBackgroundColor: "#1a1a1a" },
        horzLine: { color: "rgba(255,255,255,0.25)", style: LineStyle.Dashed, labelBackgroundColor: "#1a1a1a" },
      },
      handleScroll: false,
      handleScale: false,
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
      priceLineStyle: LineStyle.Dotted,
    });
    volume.current = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
    c.subscribeCrosshairMove((p) => {
      const b = candles.current ? (p.seriesData.get(candles.current) as Bar | undefined) : undefined;
      setHover(b && p.time !== undefined ? { ...b, time: p.time as number } : null);
    });
    chart.current = c;
    return () => {
      chart.current = candles.current = volume.current = null;
      // The library may already have a redraw queued for the next frame; removing the chart
      // now would let that redraw hit a disposed canvas. Remove it one frame later instead.
      requestAnimationFrame(() => c.remove());
    };
  }, [intraday]);

  useEffect(() => {
    const c = chart.current, cs = candles.current, vs = volume.current;
    if (!c || !cs || !vs) return;
    cs.setData(bars.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    vs.setData(
      bars.filter((k) => k.volume != null).map((k) => ({
        time: k.time as UTCTimestamp,
        value: k.volume!,
        color: k.close >= k.open ? "rgba(212,255,42,0.28)" : "rgba(255,90,110,0.28)",
      })),
    );
    const line = range === "1D" && prevClose ? cs.createPriceLine({ price: prevClose, color: "rgba(255,255,255,0.35)", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: `prev close ${px(prevClose)}` }) : null;
    c.timeScale().fitContent();
    return () => {
      // On unmount the chart is removed first (chart.current is null by then): touching it would
      // schedule a paint on a disposed canvas.
      if (line && chart.current === c) try { cs.removePriceLine(line); } catch { /* chart gone */ }
    };
  }, [bars, prevClose, range]);

  const shown = hover ?? last;
  return (
    <div className="pchart">
      <div className="pchart-legend num" aria-live="off">
        {shown ? (
          <>
            <span className="dim">{et(toDate(shown.time as Time), intraday)}</span>
            <span><i>O</i> {px(shown.open)}</span>
            <span><i>H</i> {px(shown.high)}</span>
            <span><i>L</i> {px(shown.low)}</span>
            <span className={shown.close >= shown.open ? "up" : "down"}><i>C</i> {px(shown.close)}</span>
            {shown.volume != null && <span className="hide-sm"><i>Vol</i> {Intl.NumberFormat("en-US", { notation: "compact" }).format(shown.volume)}</span>}
          </>
        ) : (
          <span className="dim">{data ? "No bars in this range yet." : "Loading…"}</span>
        )}
      </div>
      {error ? <ErrorNote error={error} /> : null}
      <div ref={el} className="pchart-canvas" aria-label={`${symbol} reference price chart, ${range}`} />
    </div>
  );
}

/** Change over the 5-day sparkline the market list already carries. */
function change5d(m: MarketItem): number | null {
  const s = m.reference?.sparkline5d ?? [];
  if (s.length < 2) return null;
  return (Number(s.at(-1)![1]) / Number(s[0]![1]) - 1) * 100;
}

export function MarketDetail({ m }: { m: MarketItem }) {
  const [range, setRange] = useState<Range>("1D");
  const [asOf, setAsOf] = useState<string | null>(null);
  const ref = m.reference;
  const prev = ref?.prevClose ? Number(ref.prevClose) : null;
  const d5 = change5d(m);
  return (
    <div className="mdetail">
      <div className="mhead">
        <div className="row" style={{ minWidth: 0 }}>
          <TokenAvatar symbol={m.symbol} size="lg" logoUrl={m.logoUrl} />
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ ["--g" as string]: "8px" }}><strong className="msym">{m.symbol}</strong><span className="dim">{m.name}</span></div>
            <div className="dim" style={{ fontSize: 13 }}>{m.exchange ?? "OTC"} · {m.kind === "token" ? "token" : m.kind === "etf" ? "ETF token" : "stock token"}</div>
          </div>
        </div>
        <div className="mprice">
          <div className="num">{ref ? fmtUsd(ref.price) : m.dex ? `$${px(Number(m.dex.price))}` : "OTC"}</div>
          {!ref && m.dex?.change24hPct && <div className={`num ${Number(m.dex.change24hPct) >= 0 ? "up" : "down"}`} style={{ fontSize: 13 }}>{fmtPct(m.dex.change24hPct)} 24h · pool price</div>}
          {ref?.changePct && (
            <div className="num" style={{ fontSize: 13 }}>
              <span className={Number(ref.changePct) >= 0 ? "up" : "down"}>{fmtPct(ref.changePct)} today</span>
              {d5 !== null && <span className={d5 >= 0 ? "up" : "down"} style={{ marginLeft: 10 }}>{fmtPct(d5)} 5D</span>}
            </div>
          )}
        </div>
      </div>
      {ref ? (
        <>
          <div className="row between" style={{ flexWrap: "wrap" }}>
            <Segmented value={range} onChange={setRange} label="Range" options={RANGES.map((v) => ({ value: v, label: v }))} />
            {asOf && <span className="hint" style={{ margin: 0 }}>as of {fmtDay.format(new Date(asOf))}, {fmtTime.format(new Date(asOf))} ET</span>}
          </div>
          <PriceChart symbol={m.symbol} range={range} prevClose={prev} onAsOf={setAsOf} />
        </>
      ) : (
        <div className="empty">No listed stock behind this token, so there is no reference chart. The price above comes from its pool; on the desk it trades at the price both sides agree.</div>
      )}
      <dl className="facts">
        <div><dt className="label">Token contract</dt><dd><AddressPill address={m.token} /></dd></div>
        <div><dt className="label">Gasless deposit</dt><dd>{m.permit ? "yes (permit)" : "no"}</dd></div>
        <div><dt className="label">Open on this desk</dt><dd className="num">{m.open.bids} bid{m.open.bids === 1 ? "" : "s"} · {m.open.listings} listing{m.open.listings === 1 ? "" : "s"}</dd></div>
        <div><dt className="label">Settles in</dt><dd>ETH, USD or ${BRAND.token}</dd></div>
      </dl>
    </div>
  );
}

/** Right-hand column: what a private block on this market means, and the two ways in. */
function MarketAside({ m }: { m: MarketItem }) {
  return (
    <aside className="maside">
      <span className="eyebrow">Private block · {m.symbol}</span>
      <h3>Move {m.symbol} size without showing your price.</h3>
      <ol className="msteps">
        <li><b>Post the size.</b> Others see {m.symbol} and the size, nothing else.</li>
        <li><b>Read sealed answers.</b> Prices are encrypted to you.</li>
        <li><b>Settle once.</b> Both sides swap in one contract transaction.</li>
      </ol>
      <Link className="btn btn-lg btn-buy btn-block" href={`/trade?ca=${m.token}`}>Bid for {m.symbol}</Link>
      <Link className="btn btn-lg btn-block" href={`/trade?ca=${m.token}&side=sell`}>Sell {m.symbol}</Link>
      <Link className="link" href={`/slippage?m=${m.symbol}`}>Small size? See what a DEX would cost →</Link>
      <p className="hint" style={{ margin: 0 }}>Stock tokens aren&apos;t available everywhere. Check eligibility in your region.</p>
      <p className="hint" style={{ margin: 0 }}>Max fee 2.5%, set in the contract. Reference price only; your block settles at the price you accept.</p>
    </aside>
  );
}

export function MarketsBoard({ compact }: { compact?: boolean }) {
  const { data, error } = useMarkets();
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("m");
    if (m) setSel(m.toUpperCase());
  }, []);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Skeleton h={480} />;
  const list = data.filter((m) => !q || m.symbol.toLowerCase().includes(q.toLowerCase()) || m.name.toLowerCase().includes(q.toLowerCase()));
  const current = data.find((m) => m.symbol === sel) ?? data[0];
  const pick = (s: string) => {
    setSel(s);
    if (!compact) {
      const u = new URL(window.location.href);
      u.searchParams.set("m", s);
      window.history.replaceState(null, "", u);
    }
  };
  return (
    <div className="mboard panel" data-ui>
      <div className="mboard-top">
        <input className="input" style={{ height: 36, maxWidth: 260 }} placeholder="Search markets" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search markets" />
        <span className="hint" style={{ margin: 0 }}><span className="dot" aria-hidden /> Reference prices of the listed stock · delayed</span>
      </div>
      <div className="mboard-grid">
        <div className="mlist" role="listbox" aria-label="Markets" data-lenis-prevent>
          {list.map((m) => {
            const pts = (m.reference?.sparkline5d ?? []).map(([, c]) => Number(c));
            const on = current?.symbol === m.symbol;
            return (
              <button key={m.symbol} role="option" aria-selected={on} onClick={() => pick(m.symbol)} className={`mrow${on ? " on" : ""}`}>
                <TokenAvatar symbol={m.symbol} size="sm" logoUrl={m.logoUrl} />
                <span className="mrow-name"><strong>{m.symbol}</strong><span className="dim">{m.name}</span></span>
                <span className="hide-sm"><Sparkline points={pts.slice(-60)} width={56} height={20} /></span>
                <span className="mrow-px num">
                  <span>{m.reference ? px(Number(m.reference.price)) : m.dex ? px(Number(m.dex.price)) : "OTC"}</span>
                  {m.reference?.changePct ? <span className={Number(m.reference.changePct) >= 0 ? "up" : "down"}>{fmtPct(m.reference.changePct)}</span>
                    : m.dex?.change24hPct ? <span className={Number(m.dex.change24hPct) >= 0 ? "up" : "down"}>{fmtPct(m.dex.change24hPct)}</span> : null}
                </span>
              </button>
            );
          })}
          {!list.length && <div className="empty">No market matches.</div>}
        </div>
        <div className="mmain">{current ? <MarketDetail m={current} /> : <div className="empty">No markets.</div>}</div>
        {current && <MarketAside m={current} />}
      </div>
    </div>
  );
}
