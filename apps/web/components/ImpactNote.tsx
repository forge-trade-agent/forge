"use client";
import Link from "next/link";
import { fmtUsd } from "@/lib/format";
import { priceImpact } from "@/lib/impact";

/**
 * Shown under an order form: what the same size would cost as a DEX market order, so the poster
 * sees what a private block saves. Reference only, from the token's pool.
 */
export function ImpactNote({ side, sizeUsd, liquidityUsd, symbol }: { side: "buy" | "sell"; sizeUsd: number; liquidityUsd: number | null; symbol: string }) {
  if (!(sizeUsd > 0)) return null;
  if (!liquidityUsd) return <div className="impact"><span className="dim">No DEX pool to compare with for {symbol}. On the desk the price is whatever both sides agree.</span></div>;
  const imp = priceImpact(side, sizeUsd, liquidityUsd);
  return (
    <div className="impact">
      {imp === null ? (
        <span>As a DEX market order, <b>{fmtUsd(sizeUsd, 0)}</b> of {symbol} is more than its pool can fill. A private block is the only way to move this size.</span>
      ) : (
        <span>As a DEX market order this would cost about <b className="down">{fmtUsd(sizeUsd * imp, 0)}</b> in price impact (<b>{(imp * 100).toFixed(imp < 0.1 ? 2 : 1)}%</b>). On the desk it trades at one agreed price.</span>
      )}
      <Link href={`/slippage?size=${Math.round(sizeUsd)}${side === "sell" ? "&side=sell" : ""}`} className="link">Compare all markets →</Link>
    </div>
  );
}
