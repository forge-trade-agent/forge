"use client";
import { AddressPill, ErrorNote, Skeleton, Tile } from "@/components/ui";
import { useHealth } from "@/components/chrome";
import { BRAND, ZERO } from "@/lib/config";
import { api } from "@/lib/desk";
import { fmtPct, fmtUnits, fmtUsd } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { getBurn, getStats } from "@/lib/stats";

export default function StatsPage() {
  const { data: s, error } = useAsync(getStats, []);
  const { data: burn } = useAsync(() => getBurn().catch(() => null), []);
  const { data: health } = useHealth();
  const { data: tokenMkt } = useAsync(() => (health ? api.tokenMarket(health.contracts.platformToken).catch(() => null) : Promise.resolve(null)), [health]);

  const usdVolume = s?.volumeByPayToken.reduce((a, v) => a + Number(v.volumeUsd ?? 0), 0) ?? 0;
  const stable = s?.volumeByPayToken.find((v) => v.payToken !== ZERO);
  const eth = s?.volumeByPayToken.find((v) => v.payToken === ZERO);

  return (
    <div className="wrap page stack" style={{ ["--g" as string]: "28px" }}>
      <div className="page-head">
        <div className="eyebrow">Stats</div>
        <h1 className="display">The desk, in numbers.</h1>
        <p>Deals, settled volume, fees and the ${BRAND.token} buy-and-burn. Every settled deal and every burn is a public transaction you can check. Prices of open postings stay sealed and are never counted here.</p>
      </div>
      <ErrorNote error={error} />
      {!s ? <Skeleton h={220} /> : (
        <div className="grid-tiles" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))" }}>
          <Tile label="Settled volume" value={fmtUsd(usdVolume, 0)} sub={`paid in USD${eth ? ` + ${fmtUnits(eth.volume, 18, 3)} ETH` : ""}`} />
          <Tile
            label="Saved vs DEX"
            value={s.savedVsDex && s.savedVsDex.compared > 0 ? fmtUsd(s.savedVsDex.usd, 0) : "–"}
            sub={s.savedVsDex && s.savedVsDex.compared > 0
              ? `price impact avoided on ${s.savedVsDex.compared} deal${s.savedVsDex.compared === 1 ? "" : "s"}${s.savedVsDex.beyondPool ? ` · ${s.savedVsDex.beyondPool} bigger than the pool` : ""}`
              : "vs a DEX market order of the same size, per deal"}
          />
          <Tile label="Deals settled" value={s.deals.settled} sub={`${s.deals.accepted} accepted · ${s.deals.refunded} refunded`} />
          <Tile label="Fees at settlement" value={stable ? fmtUsd(stable.feesUsd ?? 0) : "$0"} sub="to the buy-and-burn vault and referrers" />
          <Tile label="Tokens traded" value={s.deals.tokensTraded} sub="distinct tokens in settled deals" />
          <Tile label="Blocks posted" value={s.postings.posted} sub={`${s.postings.open} open now`} />
          <Tile label="Sealed answers" value={s.sealedAnswers} sub="encrypted offers and bids sent" />
        </div>
      )}

      <section className="stack" style={{ ["--g" as string]: "12px" }}>
        <h2 style={{ margin: 0 }}>${BRAND.token} market</h2>
        {tokenMkt ? (
          <>
            <div className="grid-tiles">
              <Tile label="Price" value={fmtUsd(tokenMkt.priceUsd, 8)} sub="from its deepest DEX pool" />
              <Tile label="Market cap" value={fmtUsd(tokenMkt.marketCapUsd)} />
              <Tile label="Liquidity" value={fmtUsd(tokenMkt.liquidityUsd)} sub="in the pool" />
              <Tile label="24h" value={<span className={Number((tokenMkt as { change24hPct?: string }).change24hPct ?? 0) >= 0 ? "up" : "down"}>{fmtPct((tokenMkt as { change24hPct?: string }).change24hPct ?? null)}</span>} />
            </div>
            <span className="hint">Reference only, read from the pool.</span>
          </>
        ) : (
          <div className="panel panel-pad"><strong>Not launched yet.</strong><p className="muted" style={{ margin: "6px 0 0" }}>${BRAND.token} has no pool yet, so there is no market price. Price, market cap and liquidity show up here once its pool is live. The desk works without it.</p></div>
        )}
      </section>

      <section className="stack" style={{ ["--g" as string]: "12px" }}>
        <h2 style={{ margin: 0 }}>${BRAND.token} buy-and-burn</h2>
        {!burn ? <div className="infobox">The burn tracker has not reported yet.</div> : (
          <>
            <div className="grid-tiles">
              <Tile label="Burned by the fee vault" value={`${fmtUnits(burn.totalBurnedByVault, 18, 0)}`} sub={`$${BRAND.token} bought with desk fees, sent to the burn address`} />
              <Tile label="Fees waiting to burn" value={burn.feesWaiting.map((f) => `${fmtUnits(f.amount, f.asset === ZERO ? 18 : 6, 2)} ${f.asset === ZERO ? "ETH" : "USD"}`).join(" · ")} sub="in the vault now" />
              <Tile label="At the burn address" value={fmtUnits(burn.atDeadAddress, 18, 0)} sub="all sources, including the vault" />
              <Tile label="Burn route" value={<span style={{ fontSize: 16 }}>{burn.route ? <AddressPill address={burn.route} /> : "none active"}</span>} sub={burn.queued ? `queued route active from ${new Date(burn.queued.eta).toLocaleString()}` : "no route change queued"} />
            </div>
            <p className="hint">Fees go to the fee vault <AddressPill address={burn.vault} />, which can only spend them buying ${BRAND.token} and sending it to 0x…dEaD. Nobody can withdraw them. Updated {new Date(burn.updatedAt).toUTCString()}.</p>
          </>
        )}
      </section>
      {s && <p className="hint">{s.note} Updated {new Date(s.updatedAt).toUTCString()}.</p>}
    </div>
  );
}
