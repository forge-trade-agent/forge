"use client";
import { useEffect, useState } from "react";
import type { Hex } from "@sealdesk/sdk";
import { ConnectButton } from "@/components/chrome";
import { Copy, ErrorNote, Tile } from "@/components/ui";
import { ZERO } from "@/lib/config";
import { api } from "@/lib/desk";
import { fmtUnits } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";

export default function ReferPage() {
  const w = useWallet();
  const [check, setCheck] = useState("");
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const target = (/^0x[0-9a-fA-F]{40}$/.test(check) ? check.toLowerCase() : w.address) as Hex | null;
  const { data, error } = useAsync(() => (target ? api.referrals(target) : Promise.resolve(null)), [target]);
  const link = w.address ? `${origin}/?ref=${w.address}` : null;

  return (
    <div className="wrap page stack" style={{ ["--g" as string]: "24px" }}>
      <div className="page-head">
        <div className="eyebrow">Referrals</div>
        <h1 className="display">Bring a trader. Earn half the fee.</h1>
        <p>Share your link. When someone you sent accepts a deal and it settles, the escrow pays you half of the protocol fee, in ETH or USD, straight to your wallet in the same transaction. No sign-up, no claiming, nothing to withdraw.</p>
      </div>
      <section className="panel panel-pad stack" style={{ ["--g" as string]: "12px" }}>
        {link ? (
          <>
            <span className="label">Your link</span>
            <div className="codebox"><code>{link}</code><Copy text={link} /></div>
          </>
        ) : (
          <>
            <span className="muted">Connect the wallet that should receive referral fees to get your link.</span>
            <ConnectButton />
          </>
        )}
      </section>
      <section className="grid-3">
        {[
          ["01", "Someone opens a link with your ?ref=. Their browser remembers your address (the latest link they opened wins)."],
          ["02", "When they accept a deal on a block they posted, your address goes into the deal terms. Both sides see it before they deposit, and it can't change afterwards."],
          ["03", "At settlement the escrow splits the protocol fee: half to the fee vault for the buy-and-burn, half to you."],
        ].map(([n, t]) => (
          <div key={n} className="panel panel-pad"><div className="eyebrow">{n}</div><p className="muted" style={{ marginBottom: 0 }}>{t}</p></div>
        ))}
      </section>
      <p className="hint">A referrer can't be the buyer, the seller or the payout address of the same deal, so you can't refer yourself. Referral fees come out of the normal fee; traders pay nothing extra.</p>
      <section className="panel panel-pad stack" style={{ ["--g" as string]: "12px" }}>
        <strong>Check any wallet</strong>
        <input className="input" placeholder="0x…" value={check} onChange={(e) => setCheck(e.target.value.trim())} />
        <ErrorNote error={error} />
        {data && (
          <div className="grid-tiles">
            {data.totals.length === 0 ? <Tile label="Referral earnings" value="0" sub="no settled referred deals yet" /> : data.totals.map((t) => (
              <Tile key={t.payToken} label={`Earned in ${t.payToken === ZERO ? "ETH" : "USD"}`} value={fmtUnits(t.earned, t.payToken === ZERO ? 18 : 6, 4)} sub={`${t.deals} deals`} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
