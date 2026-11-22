"use client";
import { MarketsBoard } from "@/components/Markets";
import { useMarkets } from "@/lib/hooks";

export default function MarketsPage() {
  const { data } = useMarkets();
  return (
    <div className="wrap page">
      <div className="page-head">
        <div className="eyebrow">Markets</div>
        <h1 className="display">
          {data ? data.length : "…"} markets.<span style={{ color: "var(--dim)", display: "block" }}>One sealed desk.</span>
        </h1>
        <p>Stock tokens, index ETFs and the platform token, each checked on-chain. Prices shown are the listed stock&apos;s, delayed. Your block settles at the price you accept. Any other ERC-20 works by address.</p>
      </div>
      <MarketsBoard />
    </div>
  );
}
