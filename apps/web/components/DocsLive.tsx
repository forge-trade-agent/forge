"use client";
/** Live parts of the Docs page: headline facts and the contract table, read from this desk's API. */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Hex } from "@sealdesk/sdk";
import { API_URL, BRAND } from "@/lib/config";
import { api } from "@/lib/desk";
import { useMarkets } from "@/lib/hooks";
import { useHealth } from "./chrome";
import { AddressPill } from "./ui";

interface Role { address: Hex; kind: "contract" | "key" | "none" }
interface Control { escrow: { maxFeeBps: number }; vault: { governor: Role; keeper: Role; routeDelaySec: number } }

function useControl() {
  const [c, setC] = useState<Control | null>(null);
  useEffect(() => { api.http.request<Control>("GET", "/control").then(setC, () => setC(null)); }, []);
  return c;
}

export function DocsFacts() {
  const { data: markets } = useMarkets();
  const c = useControl();
  return (
    <div className="docs-facts">
      <div className="ctile"><span className="label">Markets</span><strong>{markets?.length ?? "…"}</strong><span className="dim">listed, plus any ERC-20 by address</span></div>
      <div className="ctile"><span className="label">Max fee</span><strong>{c ? `${(c.escrow.maxFeeBps / 100).toFixed(1)}%` : "2.5%"}</strong><span className="dim">hard cap in the contract</span></div>
      <div className="ctile"><span className="label">Admin keys</span><strong>0</strong><span className="dim">on the escrow: no pause, no upgrade</span><Link className="link" href="#admin">Why 0? →</Link></div>
      <div className="ctile"><span className="label">Settlement</span><strong>1 tx</strong><span className="dim">both sides swap at once, or neither</span></div>
    </div>
  );
}

export function DocsStart() {
  const { data: markets } = useMarkets();
  return (
    <div className="docs-start">
      {[
        ["01", "Bid to buy", "Set a size in USD and pick a token. Sellers answer with sealed prices.", "/otc", "Place a bid →"],
        ["02", "Sell privately", "List a token amount. Buyers answer with sealed prices.", "/otc?side=sell", "List a block →"],
        ["03", "Browse markets", `${markets?.length ?? "All"} markets with reference prices and what is open on the desk.`, "/markets", "Markets →"],
        ["04", "Plug in an agent", "An MCP server and an SDK let an AI agent work the desk with its own keys.", "/developers", "Developers →"],
      ].map(([n, t, d, href, cta]) => (
        <Link key={n} href={href!} className="docs-card">
          <span className="eyebrow">{n}</span><strong>{t}</strong><span className="muted">{d}</span><span className="link">{cta}</span>
        </Link>
      ))}
    </div>
  );
}

export function DocsContracts() {
  const { data: h } = useHealth();
  const c = useControl();
  if (!h) return <p className="muted">Reading the deployment…</p>;
  const roleText = (r?: Role) => (!r ? "…" : r.kind === "contract" ? "a contract (for example a multisig Safe)" : r.kind === "key" ? "a single key" : "nobody");
  const rows: [string, string, Hex][] = [
    ["Settlement escrow", "Holds both sides of a deal and swaps them in one transaction. No owner, admin key, pause or upgrade.", h.contracts.escrow],
    ["Fee vault", `Receives the protocol fee. It can only spend it on buying $${BRAND.token} and sending it to the burn address.`, h.contracts.feeVault],
    ["Vault governor", `Can queue a new burn route (it waits ${c ? Math.round(c.vault.routeDelaySec / 3600) : 48}h in public) and run burns. Held by ${roleText(c?.vault.governor)}.`, c?.vault.governor.address ?? ("0x0000000000000000000000000000000000000000" as Hex)],
    ["Vault keeper", `Can trigger burns, nothing else. Held by ${roleText(c?.vault.keeper)}.`, c?.vault.keeper.address ?? ("0x0000000000000000000000000000000000000000" as Hex)],
    ...(h.relayer ? [["Relayer", "Pays gas for Ghost-mode deliveries. Can only submit a delivery the seller signed for that deal and that relayer.", h.relayer] as [string, string, Hex]] : []),
    ["USD pay token", "The stablecoin deals can be paid in. Fixed in the escrow at deploy.", h.contracts.stable],
    [`$${BRAND.token}`, "The desk's own token. Not needed to trade.", h.contracts.platformToken],
  ];
  return (
    <>
      <p>Everything that holds or moves money, on {h.chain.name} (chain id {h.chain.id}).</p>
      <table className="table">
        <thead><tr><th>What</th><th>Role</th><th style={{ textAlign: "right" }}>Address</th></tr></thead>
        <tbody>{rows.map(([n, d, a]) => <tr key={n}><td><strong>{n}</strong></td><td className="muted" style={{ fontSize: 14 }}>{d}</td><td style={{ textAlign: "right" }}><AddressPill address={a} /></td></tr>)}</tbody>
      </table>
      <p className="hint">The live view of these roles, refreshed from the chain, is on the <Link className="link" href="/security">Security page</Link>. Raw data: <a className="link" href={`${API_URL}/health`} target="_blank" rel="noreferrer noopener">/health</a> and <a className="link" href={`${API_URL}/control`} target="_blank" rel="noreferrer noopener">/control</a>.</p>
    </>
  );
}
