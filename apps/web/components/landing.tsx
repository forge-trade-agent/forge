"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { otcEscrowAbi } from "@sealdesk/shared/abi";
import type { Hex } from "@sealdesk/sdk";
import { BRAND } from "@/lib/config";
import { balanceOf, publicClient } from "@/lib/desk";
import { fmtUnits, fmtUsd } from "@/lib/format";
import { useAsync, useMarkets, useNow } from "@/lib/hooks";
import { getBurn } from "@/lib/stats";
import { useWallet } from "@/lib/wallet";
import { useHealth } from "./chrome";
import { Copy, Segmented, TokenAvatar } from "./ui";
import { shortCa, useSiteCa } from "./SiteCa";

// ---------------------------------------------------------------- hero mosaic

export function PixelMosaic() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let visible = true;
    const cell = 22;
    const resize = () => {
      c.width = c.clientWidth * devicePixelRatio;
      c.height = c.clientHeight * devicePixelRatio;
    };
    resize();
    const seeds = new Float32Array(4096).map(() => Math.random());
    const draw = (t: number) => {
      const w = c.width, h = c.height, s = cell * devicePixelRatio;
      ctx.clearRect(0, 0, w, h);
      const cols = Math.ceil(w / s), rows = Math.ceil(h / s);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          // Diagonal band from bottom-left to top-right, drifting slowly.
          const u = x / cols, v = 1 - y / rows;
          const d = Math.abs(u * 0.72 + 0.22 - v + Math.sin(t / 6000 + y * 0.08) * 0.03);
          const band = Math.max(0, 1 - d / 0.16);
          const sd = seeds[(x * 31 + y * 17) % seeds.length]!;
          const flicker = reduce ? 0.6 : 0.55 + 0.45 * Math.sin(t / 900 + sd * 40);
          const a = band * band * flicker + (sd > 0.985 ? 0.08 : 0) + 0.025 * sd;
          if (a < 0.02) continue;
          ctx.fillStyle = band > 0.05 ? `rgba(61, 220, 151, ${Math.min(0.9, a)})` : `rgba(241, 241, 236, ${a * 0.5})`;
          ctx.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
        }
      }
      if (!reduce && visible) raf = requestAnimationFrame(draw);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      if (visible && !reduce) raf = requestAnimationFrame(draw);
      else cancelAnimationFrame(raf);
    });
    io.observe(c);
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);
  return <canvas ref={ref} aria-hidden />;
}

// ---------------------------------------------------------------- demo ticket

const DEMO = [
  { v: "signed", price: "380.04" },
  { v: "signed", price: "379.88" },
  { v: "unverified", price: "377.10" },
] as const;

export function HeroTicket() {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setShown((n) => (n >= DEMO.length + 2 ? 0 : n + 1)), 1400);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="ticket stack reveal" style={{ ["--g" as string]: "14px", animationDelay: ".25s" }} aria-label="Example block ticket">
      <div className="row">
        <TokenAvatar symbol="TSLA" />
        <div className="grow"><strong>TSLA</strong><div className="dim" style={{ fontSize: 12 }}>Tesla · Stock token</div></div>
        <span className="label">Block ticket</span>
      </div>
      <Segmented value={side} onChange={setSide} block tone={side === "sell" ? "sell" : undefined} label="Side" options={[{ value: "buy", label: "Buy block" }, { value: "sell", label: "Sell block" }]} />
      <div className="row between"><span className="label">Size</span><span className="num">2,500 TSLA</span></div>
      <div className="row between"><span className="label">Reference</span><span className="num">$380.11 <span className="up">+0.10%</span></span></div>
      <div className="row between"><span className="label">Pay in</span><span className="num">USD</span></div>
      <div className="label" style={{ marginTop: 6 }}>Sealed answers · only you can read them</div>
      <div className="stack" style={{ ["--g" as string]: "6px", minHeight: 108 }}>
        {DEMO.slice(0, Math.min(shown, DEMO.length)).map((d, i) => (
          <div key={i} className="row between panel" style={{ padding: "8px 10px", background: "var(--bg-2)", animation: "slidein .5s var(--ease)" }}>
            <span className="sealed">••••••</span>
            <span className={`badge ${d.v === "signed" ? "badge-buy" : "badge-sell"}`}>{d.v}</span>
          </div>
        ))}
      </div>
      <div className="hint" style={{ textAlign: "center" }}>Settles in one contract transaction</div>
    </div>
  );
}

// ---------------------------------------------------------------- marquee

export function MarketMarquee() {
  const { data } = useMarkets();
  const items = data ?? [];
  if (!items.length) return null;
  // Repeat short lists so the track is long enough to loop; long lists loop as they are.
  const row = items.length >= 20 ? items : [...items, ...items, ...items, ...items];
  return (
    <>
    <p className="marquee-cap">{items.length} markets · or any ERC-20 on the chain · pay in ETH, USD or ${BRAND.token}</p>
    <div className="marquee" aria-label="Listed markets">
      {[false, true].map((rev) => (
        <div key={String(rev)} className={`marquee-track${rev ? " rev" : ""}`}>
          {[...row, ...row].map((m, i) => (
            <Link key={i} href={`/markets?m=${m.symbol}`} className="mchip">
              <TokenAvatar symbol={m.symbol} size="sm" logoUrl={m.logoUrl} />
              <strong>{m.symbol}</strong>
              <span className="dim">{m.name}</span>
              <span className="badge badge-dim">{m.kind}</span>
            </Link>
          ))}
        </div>
      ))}
    </div>
    </>
  );
}

/** CTA line with the live market count in front when it is known. */
export function MarketCount() {
  const { data } = useMarkets();
  const rest = "sealed answers only you can read, and one-transaction settlement. No account, no order book.";
  return <>{data?.length ? `${data.length} markets, ${rest}` : `${rest[0]!.toUpperCase()}${rest.slice(1)}`}</>;
}

// ---------------------------------------------------------------- privacy matrix

const VIEW = {
  others: { label: "Other traders", note: "They see that a block exists and its size. Nothing that lets them trade against you.", cells: ["SEALED", "SEALED", "VISIBLE", "SEALED"] },
  server: { label: "Our server", note: "It stores ciphertext it cannot open, and never sees your link's key.", cells: ["SEALED", "SEALED", "VISIBLE", "SEALED"] },
  counterparty: { label: "Counterparty", note: "Only the side you accept sees the final terms, and only once you accept.", cells: ["VISIBLE", "VISIBLE", "VISIBLE", "VISIBLE"] },
  you: { label: "You", note: "Everything, in this browser only.", cells: ["VISIBLE", "VISIBLE", "VISIBLE", "VISIBLE"] },
} as const;

export function ViewAs() {
  const [who, setWho] = useState<keyof typeof VIEW>("others");
  const v = VIEW[who];
  return (
    <div className="panel" data-ui>
      <div className="panel-head" style={{ flexWrap: "wrap", gap: 10 }}>
        <span className="label">View as</span>
        <Segmented value={who} onChange={setWho} label="View as" options={(Object.keys(VIEW) as (keyof typeof VIEW)[]).map((k) => ({ value: k, label: VIEW[k].label }))} />
      </div>
      <table className="table matrix">
        <tbody>
          {["Price", "Your wallet", "Size", "Deal terms"].map((row, i) => (
            <tr key={row}>
              <td>{row}</td>
              <td style={{ textAlign: "right" }}><span className={`badge ${v.cells[i] === "SEALED" ? "badge-dim" : "badge-buy"}`}>{v.cells[i]}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hint" style={{ padding: "0 16px 16px" }}>{v.note}</div>
    </div>
  );
}

// ---------------------------------------------------------------- pipeline simulation

const NODES = [
  ["POST", "Bid to buy or list to sell. A private link, no account."],
  ["SEALED_BOX", "Answers are encrypted to the poster. We store ciphertext."],
  ["SIGNATURE_CHECK", "Each answer is signed by its wallet. Pass or flag."],
  ["CONTRACT", "Payment locks first. Then the tokens. No admin key."],
  ["CHAIN", "Both sides swap in one transaction. A receipt on chain."],
] as const;

const SCENARIOS: { lines: string[]; path: number[]; branch?: "UNVERIFIED" | "REFUND" }[] = [
  { lines: ["buyer bids for 2,500 TSLA · pays in USD · reply window 1h", "seller sends a sealed answer", "signature ok · wallet funded", "buyer accepts · payment locked", "seller delivers · settled in one tx"], path: [0, 1, 2, 3, 4] },
  { lines: ["seller lists 40,000 NVDA · pays in ETH", "answer arrives without a valid signature", "flagged UNVERIFIED · ranked last · needs explicit OK"], path: [0, 1, 2], branch: "UNVERIFIED" },
  { lines: ["buyer locks payment for 10 SPY", "seller never delivers", "deadline passes · REFUND to the buyer"], path: [0, 1, 2, 3], branch: "REFUND" },
];

export function Pipeline() {
  const [sc, setSc] = useState(0);
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState("");
  const s = SCENARIOS[sc]!;
  const line = s.lines[Math.min(step, s.lines.length - 1)]!;
  useEffect(() => {
    setTyped("");
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setTyped(line.slice(0, i));
      if (i >= line.length) clearInterval(iv);
    }, 22);
    return () => clearInterval(iv);
  }, [line]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (step < s.lines.length - 1) setStep(step + 1);
      else {
        setStep(0);
        setSc((sc + 1) % SCENARIOS.length);
      }
    }, 2600);
    return () => clearTimeout(t);
  }, [step, sc, s.lines.length]);
  const activeNode = s.path[Math.min(step, s.path.length - 1)]!;
  const finished = step === s.lines.length - 1;
  return (
    <div className="stack" style={{ ["--g" as string]: "14px" }}>
      <div className="pipeline">
        {NODES.map(([name, desc], i) => (
          <div key={name} className={`pnode${i === activeNode ? (finished && s.branch ? (s.branch === "UNVERIFIED" ? " warn" : " bad") : " active") : ""}`}>
            <div className="label" style={{ color: i <= activeNode ? "var(--text)" : undefined }}>{name}</div>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>{desc}</p>
          </div>
        ))}
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <span className={`badge ${finished && s.branch === "UNVERIFIED" ? "badge-warn" : "badge-dim"}`}>UNVERIFIED · ranked last; accepting needs your explicit OK</span>
        <span className={`badge ${finished && s.branch === "REFUND" ? "badge-sell" : "badge-dim"}`}>REFUND · deadline passes before both sides fund</span>
      </div>
      <div className="term">
        <div className="term-body" style={{ minHeight: 0 }}><span className="p">&gt; </span><span className="o caret">{typed}</span></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- agent terminal

const AGENT = [
  ["$", "node forge-mcp.mjs"],
  [">", "agent: list_open_blocks { token: TSLA }"],
  ["<", "1 bid · 2,500 TSLA · price sealed"],
  [">", "agent: send_sealed_answer { amount: 2500e18, price: 950275e6 }"],
  ["<", "quoteId Q7…  saved to local keystore"],
  [">", "agent: get_deal_status { quoteId }"],
  ["<", "accepted · payment locked"],
  [">", "agent: deposit_tokens { quoteId, confirm: false }"],
  ["<", "preview · you receive 931,269.50 USD · fee 2.00%"],
  [">", "agent: deposit_tokens { quoteId, confirm: true }"],
  ["<", "settled in one transaction"],
] as const;

export function AgentTerminal() {
  const [n, setN] = useState(1);
  useEffect(() => {
    const iv = setInterval(() => setN((x) => (x >= AGENT.length + 3 ? 1 : x + 1)), 900);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="term" aria-label="Example agent session" data-ui>
      <div className="term-head"><i /><i /><i /><span className="dim mono" style={{ fontSize: 11, marginLeft: 8 }}>~/desk · agent + {BRAND.name.toLowerCase()} mcp</span></div>
      <div className="term-body">
        {AGENT.slice(0, Math.min(n, AGENT.length)).map(([k, t], i) => (
          <div key={i}><span className={k === "<" ? "" : "p"}>{k} </span><span className={k === "<" ? "" : "o"}>{t}</span></div>
        ))}
        <span className="caret" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- token section

export function TimelockCard() {
  const now = useNow(1000);
  const { data: burn } = useAsync(() => getBurn().catch(() => null), []);
  const q = burn?.queued;
  const left = q ? Math.max(0, new Date(q.eta).getTime() - now) : 0;
  const parts = [Math.floor(left / 86_400_000), Math.floor((left % 86_400_000) / 3_600_000), Math.floor((left % 3_600_000) / 60_000), Math.floor((left % 60_000) / 1000)];
  return (
    <div className="panel panel-pad stack" style={{ ["--g" as string]: "14px" }} data-ui>
      <div className="row between">
        <span className="label">Burn route · public 2-day timelock</span>
        <span className={`badge ${q ? "badge-warn" : burn?.route ? "badge-buy" : "badge-dim"}`}>{q ? "QUEUED" : burn?.route ? "ACTIVE" : "NONE YET"}</span>
      </div>
      {q ? (
        <>
          <div className="countdown">
            {(["Days", "Hrs", "Min", "Sec"] as const).map((l, i) => (
              <div key={l}><b>{String(parts[i]).padStart(2, "0")}</b><span className="label">{l}</span></div>
            ))}
          </div>
          <span className="muted">Can be turned on from {new Date(q.eta).toLocaleString()}.</span>
        </>
      ) : (
        <span className="muted">{burn?.route ? "The current route buys the token on its pool and burns it." : "No route is active yet: fees simply collect in the vault. Nobody can withdraw them."}</span>
      )}
      <ol className="muted" style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
        <li><strong>Queued on-chain.</strong> A new route is deployed and queued in the vault. Anyone can read it.</li>
        <li><strong>2 days in public.</strong> Time for anyone to check the route before it touches a single fee.</li>
        <li><strong>Switched on.</strong> Only after the wait. Every burn must hit a minimum, checked twice.</li>
      </ol>
    </div>
  );
}

export function WalletChecker() {
  const w = useWallet();
  const { data: health } = useHealth();
  const [addr, setAddr] = useState("");
  const [res, setRes] = useState<{ bal: bigint; min: bigint } | null>(null);
  const target = (/^0x[0-9a-fA-F]{40}$/.test(addr) ? addr.toLowerCase() : w.address) as Hex | null;
  useEffect(() => {
    if (!target || !health) return setRes(null);
    Promise.all([
      balanceOf(health.contracts.platformToken, target),
      publicClient.readContract({ address: health.contracts.escrow, abi: otcEscrowAbi, functionName: "MIN_HOLDING" }),
    ]).then(([bal, min]) => setRes({ bal, min }), () => setRes(null));
  }, [target, health]);
  return (
    <div className="panel panel-pad stack" style={{ ["--g" as string]: "12px" }} data-ui>
      <span className="label">Check your wallet</span>
      <input className="input" placeholder="Paste any address, or connect" value={addr} onChange={(e) => setAddr(e.target.value.trim())} />
      {res && (
        <div className={res.bal >= res.min ? "okbox" : "infobox"}>
          Holds {fmtUnits(res.bal, 18, 0)} ${BRAND.token} of {fmtUnits(res.min, 18, 0)} needed.{" "}
          {res.bal >= res.min ? "Eligible: deals pay 0.5% less." : "Not eligible for the holder discount yet."}
        </div>
      )}
    </div>
  );
}

export function TokenStrip() {
  const { data: health } = useHealth();
  const { ca } = useSiteCa();
  const { data: m } = useAsync(
    () => (health ? import("@/lib/desk").then(({ api }) => api.tokenMarket(health.contracts.platformToken)).catch(() => null) : Promise.resolve(null)),
    [health],
  );
  const mm = m as (null | { priceUsd: string; marketCapUsd: string | null; liquidityUsd: string | null; change24hPct?: string | null });
  return (
    <div className="panel panel-pad row" style={{ flexWrap: "wrap", ["--g" as string]: "28px" }}>
      <div><span className="label">${BRAND.token}</span>{ca ? <div className="addr">{shortCa(ca.address, 5)} <Copy text={ca.address} /></div> : <div className="dim">CA coming soon</div>}</div>
      <div><div className="label">Price</div><div className="num">{mm ? fmtUsd(mm.priceUsd, 8) : "–"}</div></div>
      <div><div className="label">Mcap</div><div className="num">{mm ? fmtUsd(mm.marketCapUsd) : "–"}</div></div>
      <div><div className="label">Liquidity</div><div className="num">{mm ? fmtUsd(mm.liquidityUsd) : "–"}</div></div>
      <div><div className="label">24h</div><div className={`num ${Number(mm?.change24hPct ?? 0) >= 0 ? "up" : "down"}`}>{mm?.change24hPct ? `${Number(mm.change24hPct).toFixed(1)}%` : "–"}</div></div>
      <span className="hint">{mm ? "Reference only, from the pool." : `No pool yet: $${BRAND.token} hasn't launched.`}</span>
      {health && <Link href={`/trade?ca=${health.contracts.platformToken}`} className="link" style={{ marginLeft: "auto" }}>Trade ${BRAND.token} OTC, no slippage →</Link>}
    </div>
  );
}
