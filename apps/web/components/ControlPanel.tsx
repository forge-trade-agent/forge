"use client";
/**
 * Security page: who controls what, right now. Every value comes from /control, which the worker
 * reads from this desk's own contracts on the configured chain. Nothing here is typed by hand.
 */
import { useEffect, useState } from "react";
import type { Hex } from "@sealdesk/sdk";
import { API_URL, BRAND, ZERO } from "@/lib/config";
import { api } from "@/lib/desk";
import { fmtUnits, timeLeft } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { AddressPill, Skeleton } from "./ui";

interface Role { address: Hex; kind: "contract" | "key" | "none" }
interface Control {
  chainId: number;
  escrow: { address: Hex; deployed: boolean; adminKeys: 0; maxFeeBps: number; feeVault: Hex; locked: { asset: Hex; amount: string }[]; owed: { asset: Hex; amount: string }[] };
  vault: { address: Hex; governor: Role; keeper: Role; routeDelaySec: number; route: Hex | null; queued: { route: Hex; eta: string; activatableNow: boolean } | null; fees: { asset: Hex; amount: string }[]; totalBurned: string };
  burnToken: { address: Hex; atDeadAddress: string };
  stable: Hex;
  relayer: { address: Hex; ethBalance: string } | null;
  readAt: string;
}

const REFRESH = 30_000;

function useControl() {
  const [data, setData] = useState<Control | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => api.http.request<Control>("GET", "/control").then((d) => live && (setData(d), setError(false)), () => live && setError(true));
    void load();
    const iv = setInterval(load, REFRESH);
    return () => { live = false; clearInterval(iv); };
  }, []);
  return { data, error };
}

const roleText = (r: Role, what: string) =>
  r.kind === "contract" ? `A contract (for example a multisig Safe) holds the ${what} role.` : r.kind === "key" ? `A single key holds the ${what} role. Moving it to a multisig is recommended before launch.` : `Nobody holds the ${what} role.`;

export function ControlPanel() {
  const { data: c, error } = useControl();
  const now = useNow(1000);
  const money = (list: { asset: Hex; amount: string }[]) =>
    list.map((x) => (x.asset === ZERO ? `${fmtUnits(x.amount, 18, 4)} ETH` : `${fmtUnits(x.amount, 6, 2)} USD`)).join(" · ");

  if (error && !c) return <div className="panel panel-pad control-panel"><span className="label">Live · who controls what</span><p className="muted" style={{ margin: "8px 0 0" }}>The chain hasn&apos;t been read yet. This panel fills in once the worker has run.</p></div>;
  if (!c) return <div className="control-panel"><Skeleton h={320} /></div>;

  const ago = Math.max(0, Math.round((now - new Date(c.readAt).getTime()) / 1000));
  return (
    <section className="control-panel" aria-labelledby="control-title" data-ui>
      <div className="control-top">
        <div className="ctile"><span className="label">Settlement contract</span><strong className={c.escrow.deployed ? "up" : "down"}>{c.escrow.deployed ? "Live" : "Not deployed"}</strong><AddressPill address={c.escrow.address} /></div>
        <div className="ctile"><span className="label">Admin keys</span><strong>0</strong><span className="dim">no owner, pause or upgrade</span></div>
        <div className="ctile"><span className="label">Fee cap</span><strong>{(c.escrow.maxFeeBps / 100).toFixed(1)}%</strong><span className="dim">hard maximum, in code</span></div>
        <div className="ctile"><span className="label">Route delay</span><strong>{Math.round(c.vault.routeDelaySec / 3600)}h</strong><span className="dim">before a new burn route can start</span></div>
      </div>

      <div className="control-head">
        <span className="eyebrow">Live</span>
        <h2 id="control-title" className="display">Who controls what,<span className="second">right now.</span></h2>
        <p className="muted">Read from the chain about every {REFRESH / 1000} seconds, not written by hand. Every address links to the explorer so you can check it yourself.</p>
      </div>

      <div className="control-grid">
        <article>
          <span className="label">Your deal funds</span>
          <h3>In the escrow. No owner.</h3>
          <p>No function anyone can call moves deposits. They go to the other side of the deal minus the fee, or back after the deadline.</p>
          <p className="num dim">Locked now: {money(c.escrow.locked)}{c.escrow.owed.some((o) => o.amount !== "0") ? ` · waiting to be claimed: ${money(c.escrow.owed)}` : ""}</p>
          <AddressPill address={c.escrow.address} n={6} />
        </article>
        <article>
          <span className="label">Desk fees</span>
          <h3>In the fee vault: {money(c.vault.fees)}</h3>
          <p>Nobody can withdraw them. The vault can only buy ${BRAND.token} and send it to the burn address.</p>
          <p className="num dim">Burned by the vault so far: {fmtUnits(c.vault.totalBurned, 18, 0)} ${BRAND.token}</p>
          <AddressPill address={c.vault.address} n={6} />
        </article>
        <article>
          <span className="label">Vault governor</span>
          <h3>{c.vault.governor.kind === "contract" ? "A contract" : c.vault.governor.kind === "key" ? "A single key" : "Nobody"}</h3>
          <p>{roleText(c.vault.governor, "governor")} It can queue or cancel a burn route and trigger burns. It can&apos;t move fees anywhere else.</p>
          <AddressPill address={c.vault.governor.address} n={6} />
        </article>
        <article>
          <span className="label">Keeper (runs burns)</span>
          <h3>{c.vault.keeper.kind === "contract" ? "A contract" : c.vault.keeper.kind === "key" ? "A single key" : "Nobody"}</h3>
          <p>{roleText(c.vault.keeper, "keeper")} Every burn must send at least its minimum to the burn address, or it reverts.</p>
          <AddressPill address={c.vault.keeper.address} n={6} />
        </article>
        <article>
          <span className="label">Burn route</span>
          <h3>{c.vault.route ? "Active" : "None active yet"}</h3>
          {c.vault.route && <AddressPill address={c.vault.route} n={6} />}
          {c.vault.queued ? (
            <p>Queued route {c.vault.queued.activatableNow ? "can be switched on now" : `can be switched on in ${timeLeft(new Date(c.vault.queued.eta).getTime() - now)}`} · {new Date(c.vault.queued.eta).toUTCString()}</p>
          ) : (
            <p>{c.vault.route ? "No change queued." : "Until a route is active, fees simply collect in the vault."}</p>
          )}
        </article>
        <article>
          <span className="label">At the burn address</span>
          <h3 className="num">{fmtUnits(c.burnToken.atDeadAddress, 18, 0)} ${BRAND.token}</h3>
          <p>Everything ever sent to 0x…dEaD, from any source.</p>
          <AddressPill address={c.burnToken.address} n={6} />
        </article>
        {c.relayer && (
          <article>
            <span className="label">Ghost-mode relayer</span>
            <h3 className="num">{fmtUnits(c.relayer.ethBalance, 18, 4)} ETH for gas</h3>
            <p>Pays gas for one-time wallets. It can only submit deposits those wallets signed.</p>
            <AddressPill address={c.relayer.address} n={6} />
          </article>
        )}
      </div>

      <div className="panel">
        <div className="panel-head"><span className="panel-title">Addresses on chain {c.chainId}</span></div>
        <table className="table">
          <tbody>
            {[
              ["Settlement contract", "Holds deposits, settles or refunds. No admin.", c.escrow.address],
              ["Fee vault", "Holds fees, never deposits. Can only buy and burn.", c.vault.address],
              [`$${BRAND.token}`, "The desk's own token.", c.burnToken.address],
              ["Stablecoin", "The USD pay token.", c.stable],
              ...(c.relayer ? [["Relayer", "Pays gas for Ghost-mode deposits.", c.relayer.address] as const] : []),
            ].map(([n, d, a]) => (
              <tr key={n}><td><strong>{n}</strong><div className="dim" style={{ fontSize: 13 }}>{d}</div></td><td style={{ textAlign: "right" }}><AddressPill address={a} n={6} /></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">Read from chain {c.chainId} {ago}s ago. Raw data: <a className="link" href={`${API_URL}/control`} target="_blank" rel="noreferrer noopener">/control</a>.</p>
    </section>
  );
}
