"use client";
import { use } from "react";
import type { Hex } from "@sealdesk/sdk";
import { payLabel, useTokenPair } from "@/components/desk";
import { AddressPill, Copy, ErrorNote, Skeleton, TokenAvatar } from "@/components/ui";
import { api } from "@/lib/desk";
import { explorerTx } from "@/lib/config";
import { fmtUnits, short, unitPrice } from "@/lib/format";
import { useAsync } from "@/lib/hooks";

export default function ReceiptPage({ params }: { params: Promise<{ tx: string }> }) {
  const { tx } = use(params);
  const { data: r, error } = useAsync(() => api.receipt(tx as Hex), [tx]);
  const { t, p } = useTokenPair(r?.token ?? null, r?.payToken ?? null);
  if (error) return <div className="wrap page"><ErrorNote error={error} /></div>;
  if (!r) return <div className="wrap page"><Skeleton h={320} /></div>;
  const td = t?.decimals ?? 18, pd = p?.decimals ?? 18, ps = payLabel(r.payToken, p);
  const rows: [string, React.ReactNode][] = [
    ["Amount", `${fmtUnits(r.amount, td, 6)} ${t?.symbol ?? ""}`],
    ["Price", `${fmtUnits(r.price, pd, 6)} ${ps}`],
    ["Unit price", `${unitPrice(r.price, r.amount, td, pd)} ${ps}`],
    ["Buyer", <AddressPill key="b" address={r.buyer} n={6} />],
    ["Seller", <AddressPill key="s" address={r.seller} n={6} />],
    ["Seller received", `${fmtUnits(r.sellerProceeds, pd, 6)} ${ps}`],
    ["Fee to buy-and-burn vault", `${fmtUnits(r.fees.vault, pd, 6)} ${ps}`],
    ["Referrer share", `${fmtUnits(r.fees.referrer, pd, 6)} ${ps}`],
    ["Relayer fee", `${fmtUnits(r.fees.relayer, pd, 6)} ${ps}${r.relayer ? ` → ${short(r.relayer)}` : ""}`],
    ["Block", r.block],
    ["Settled", new Date(r.settledAt).toLocaleString()],
    ["Deal id", <span key="d" className="addr">{short(r.dealId, 8)} <Copy text={r.dealId} /></span>],
  ];
  return (
    <div className="wrap page" style={{ maxWidth: 760 }}>
      <div className="panel">
        <div className="panel-pad stack" style={{ ["--g" as string]: "14px", borderBottom: "1px solid var(--line)" }}>
          <div className="eyebrow">Settlement receipt · rebuilt from the chain</div>
          <div className="row">
            <TokenAvatar symbol={t?.symbol ?? "?"} size="lg" />
            <div>
              <h1 style={{ margin: 0, fontSize: 28 }}>
                {fmtUnits(r.amount, td, 4)} {t?.symbol} for {fmtUnits(r.price, pd, 2)} {ps}
              </h1>
              <div className="dim">Both legs swapped in one contract transaction.</div>
            </div>
          </div>
          <div className="codebox">
            <code>{r.txHash}</code>
            <Copy text={r.txHash} />
            {explorerTx(r.txHash) && <a className="link" href={explorerTx(r.txHash)!} target="_blank" rel="noreferrer noopener">Explorer ↗</a>}
          </div>
        </div>
        <table className="table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="label" style={{ width: 220 }}>{k}</td>
                <td className="num">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ marginTop: 14 }}>Anyone can rebuild this page from transaction {short(r.txHash, 6)}; nothing here comes from our database.</p>
    </div>
  );
}
