"use client";
import type { MarketItem } from "@/lib/hooks";
import { TokenAvatar } from "./ui";

/** Quick picks for the first few listings, and a dropdown with every listed market. */
export function MarketPicker({ markets, value, onPick, quick = 8 }: { markets: MarketItem[]; value: string; onPick: (token: string) => void; quick?: number }) {
  const v = value.toLowerCase();
  const rest = markets.slice(quick);
  const inRest = rest.find((m) => m.token === v);
  return (
    <div className="row" style={{ flexWrap: "wrap", ["--g" as string]: "6px" }}>
      {markets.slice(0, quick).map((m) => (
        <button key={m.symbol} type="button" className="chip chip-logo" aria-pressed={v === m.token} onClick={() => onPick(m.token)}>
          <TokenAvatar symbol={m.symbol} size="sm" logoUrl={m.logoUrl} />
          {m.symbol}
        </button>
      ))}
      {rest.length > 0 && (
        <select className="chip chip-more" aria-label="More markets" value={inRest ? inRest.token : ""} onChange={(e) => e.target.value && onPick(e.target.value)}>
          <option value="">{inRest ? inRest.symbol : `+${rest.length} more`}</option>
          {rest.map((m) => <option key={m.symbol} value={m.token}>{m.symbol} · {m.name}</option>)}
        </select>
      )}
    </div>
  );
}
