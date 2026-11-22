"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { RfqPublic } from "@sealdesk/sdk";
import { api } from "@/lib/desk";
import { CHAIN_ID, CHAIN_NAME } from "@/lib/config";
import { fmtUnits, timeLeft } from "@/lib/format";
import { loadMarkets, useNow, useStream, type MarketItem } from "@/lib/hooks";
import { HeroField } from "./HeroField";
import { prefersReduced, SplitText } from "./motion";
import { SoundChip } from "./sound";
import { Countdown } from "./ui";
import { useTokenPair } from "./desk";

/** Live desk feed for the hero: newest open block + counts, refreshed by the SSE desk channel. */
function useDeskPulse() {
  const [rfqs, setRfqs] = useState<RfqPublic[]>([]);
  const [counts, setCounts] = useState({ open: 0, buying: 0, selling: 0, sealed: 0 });
  const [markets, setMarkets] = useState<MarketItem[]>([]);
  const load = useCallback(async () => {
    try {
      const r = await api.listRfqs({ sort: "new", limit: 12 });
      setRfqs(r.items);
      setCounts(r.counts);
    } catch {
      /* the hero stays usable without the API */
    }
  }, []);
  useEffect(() => {
    void load();
    loadMarkets().then(setMarkets, () => undefined);
  }, [load]);
  useStream("desk", null, () => void load());
  return { rfqs, counts, markets };
}

function LatestBlock({ rfq, symbol }: { rfq: RfqPublic | undefined; symbol?: string | undefined }) {
  const now = useNow(1000);
  const { t } = useTokenPair(rfq?.token ?? null, null);
  if (!rfq) {
    return (
      <div className="tk-main">
        <span className="tk-k">Latest sealed block</span>
        <span className="tk-v">The desk is quiet</span>
        <span className="tk-m">Post the first block. Its price stays sealed.</span>
      </div>
    );
  }
  const sym = symbol ?? t?.symbol ?? "Token";
  const size = t?.decimals != null ? fmtUnits(BigInt(rfq.amount) - BigInt(rfq.filledAmount), t.decimals, 2) : "…";
  const created = new Date(rfq.createdAt).getTime(), exp = new Date(rfq.expiresAt).getTime();
  return (
    <div className="tk-main">
      <span className="tk-k"><i className="tk-live" aria-hidden /> Latest sealed block</span>
      <span className="tk-v">
        <span className={`tk-side ${rfq.side === "buy" ? "up" : "down"}`}>{rfq.side === "buy" ? "Bid" : "Ask"}</span> {sym}
        <span className="tk-size num">{rfq.sizeUsd ? `~$${Number(rfq.sizeUsd).toLocaleString("en-US")}` : `${size} ${sym}`}</span>
      </span>
      <span className="tk-m num">Price <span className="tk-sealed" aria-label="sealed">••••••</span> · {rfq.quoteCount} sealed answer{rfq.quoteCount === 1 ? "" : "s"}</span>
      <span className="tk-bar"><Countdown from={created} to={exp} now={now} /><span className="num">{timeLeft(exp - now)}</span></span>
    </div>
  );
}

/** Counts up to a number once, then follows it. */
function CountUp({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReduced()) {
      el.textContent = String(value);
      shown.current = value;
      return;
    }
    const o = { v: shown.current };
    const tw = gsap.to(o, { v: value, duration: 1.4, ease: "expo.out", onUpdate: () => { el.textContent = String(Math.round(o.v)); } });
    shown.current = value;
    return () => { tw.kill(); };
  }, [value]);
  return <span ref={ref} className="num">0</span>;
}

export function FrontierHero() {
  const { rfqs, counts, markets } = useDeskPulse();
  const root = useRef<HTMLElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const newest = rfqs.find((r) => new Date(r.expiresAt).getTime() > Date.now());
  const sym = markets.find((m) => m.token === newest?.token)?.symbol;

  useEffect(() => {
    if (prefersReduced() || !root.current) return;
    const ctx = gsap.context(() => {
      // Entrance: pill, then the headline (SplitText), then copy, actions and the ticket.
      gsap.fromTo(".hx-in", { opacity: 0, y: 18, filter: "blur(6px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 1.1, ease: "expo.out", stagger: 0.09, delay: 0.35 });
      gsap.fromTo(".hx-ticket", { opacity: 0, y: 40, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 1.3, ease: "expo.out", delay: 0.75 });
      // Leaving: the content lifts and softens as the next section arrives.
      gsap.to(inner.current, { yPercent: -8, opacity: 0.2, ease: "none", scrollTrigger: { trigger: root.current!, start: "top top", end: "bottom top", scrub: true } });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={root} className="hx" aria-labelledby="hero-title">
      <HeroField className="hx-canvas" />
      <div className="hx-glow" aria-hidden />
      <div ref={inner} className="wrap hx-inner">
        <Link href="/app" className="hx-pill hx-in">
          <span className="hx-pill-dot" aria-hidden />
          <span><b className="num">{counts.open}</b> open blocks</span>
          <span className="hx-pill-sep" aria-hidden />
          <span className="dim">{CHAIN_NAME}{markets.length ? ` · ${markets.length} markets` : ""}</span>
          <span aria-hidden className="hx-pill-arrow">→</span>
        </Link>
        <h1 id="hero-title" className="display hx-title">
          <SplitText lines={["Trade size.", "Stay private."]} text="Trade size. Stay private." delay={0.2} />
        </h1>
        <p className="hx-sub hx-in">
          A private OTC desk for block trades in stock tokens. Prices come back sealed to you alone, and both sides settle in one contract transaction.
        </p>
        <div className="hx-actions hx-in">
          <Link href="/app?new=buy" className="btn btn-buy btn-lg">Post a block</Link>
          <Link href="/how" className="btn btn-lg btn-ghost">How it works</Link>
        </div>

        <div className="hx-ticket">
          <Link data-ui href={newest ? `/rfq/${newest.id}` : "/app?new=buy"} className="tk" aria-label={newest ? "Open the latest sealed block" : "Post the first block"}>
            <LatestBlock rfq={newest} symbol={sym} />
            <dl className="tk-stats">
              <div><dt>Open</dt><dd><CountUp value={counts.open} /></dd></div>
              <div><dt>Buying</dt><dd className="up"><CountUp value={counts.buying} /></dd></div>
              <div><dt>Selling</dt><dd className="down"><CountUp value={counts.selling} /></dd></div>
              <div><dt>Sealed answers</dt><dd><CountUp value={counts.sealed} /></dd></div>
            </dl>
          </Link>
          <span className="hx-chain dim">chain {CHAIN_ID} · <SoundChip /></span>
        </div>
      </div>
      <span className="hx-cue" aria-hidden><i /></span>
    </section>
  );
}

/** Pinned scroll scene: one block from post to settlement, one step per stretch of scroll. */
const STEPS: [string, string, boolean?][] = [
  ["Post", "Bid to buy or list to sell. A private link, no account. Others see the token and size, never the price."],
  ["Sealed box", "Answers are encrypted to your key in the sender's browser. The server stores ciphertext it can't open."],
  ["Signature check", "Each answer is signed by its wallet and checked for funds. Forgeries are flagged and ranked last.", true],
  ["Contract", "You accept. Payment locks first, then the seller deposits the tokens. No admin key anywhere."],
  ["Settled", "Both legs swap in one transaction. A public receipt, rebuilt from the chain."],
];

export function HowScene() {
  const root = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!root.current) return;
    if (prefersReduced() || window.innerWidth < 900) {
      setActive(STEPS.length - 1);
      return;
    }
    const st = ScrollTrigger.create({
      trigger: root.current,
      start: "top top",
      end: `+=${STEPS.length * 30}%`,
      pin: true,
      pinSpacing: true,
      scrub: true,
      onUpdate: (self) => {
        setActive(Math.min(STEPS.length - 1, Math.floor(self.progress * STEPS.length)));
        if (bar.current) bar.current.style.height = `${(self.progress * 100).toFixed(1)}%`;
      },
    });
    return () => st.kill();
  }, []);
  const done = active === STEPS.length - 1;
  return (
    <section ref={root} className="scene" aria-labelledby="how-title">
      <div className="wrap scene-pin">
        <div className="stack" style={{ ["--g" as string]: "18px" }}>
          <span className="eyebrow">How a block trades <span style={{ color: "var(--dim)" }}>· 03 / 06</span></span>
          <h2 id="how-title" className="display scene-big">
            You decide.<span className="second">Code settles.</span>
          </h2>
          <p className="muted" style={{ maxWidth: 440, fontSize: 16, margin: 0 }}>
            One block, from the post to a settlement on-chain. Scroll to walk it through.
          </p>
          <div className="big-stat num" aria-live="polite" style={{ color: done ? "var(--lime)" : undefined }}>
            {String(active + 1).padStart(2, "0")}<span className="dim" style={{ fontSize: "0.4em" }}> / {String(STEPS.length).padStart(2, "0")}</span>
          </div>
        </div>
        <ol className="scene-steps" style={{ listStyle: "none", margin: 0 }}>
          <span className="scene-progress" aria-hidden><i ref={bar} /></span>
          {STEPS.map(([t, d, check], i) => (
            <li key={t} className={`scene-step${i <= active ? " on" : ""}${i === active ? " now" : ""}`}>
              <div className="row between">
                <span className="t">{t}</span>
                {check && i <= active && <span className="badge badge-warn">unverified → last</span>}
              </div>
              <p>{d}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
