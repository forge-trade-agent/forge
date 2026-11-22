"use client";
import Link from "next/link";
import { useState } from "react";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, Terms } from "@sealdesk/sdk";
import { ExposureCheck } from "@/components/Exposure";
import { tokenOf } from "@/components/Notify";
import { ErrorNote } from "@/components/ui";
import { api } from "@/lib/desk";
import { useLinks } from "@/lib/hooks";
import type { SavedLink } from "@/lib/keys";

type Target = { oneTime: Hex; terms: Terms | null; since: string; label: string };

const HOPS: [string, string][] = [
  ["Payout address", "In Ghost mode the payment still goes somewhere. If that's your main wallet, the settled terms name it in public."],
  ["Funding", "The one-time wallet needs the tokens it delivers. A transfer from your main wallet links the two in one hop."],
  ["Second hop", "A funder that has ever sent tokens to or from your wallet links you in two hops."],
  ["Sweeping back", "Moving leftover tokens from the one-time wallet straight to your main wallet links them after the fact."],
  ["Native ETH", "ETH transfers leave no token logs. Ghost mode needs no ETH; if the wallet holds some, check who sent it."],
];

export default function ExposurePage() {
  const list = useLinks();
  const ghosts = list.filter((l) => l.kind === "quote" && l.ghostKey);
  const [target, setTarget] = useState<Target | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [manual, setManual] = useState("");
  const [manualSince, setManualSince] = useState("");

  const pick = async (l: SavedLink) => {
    setLoading(l.id);
    setError(null);
    try {
      const oneTime = privateKeyToAccount(l.ghostKey!).address.toLowerCase() as Hex;
      const token = tokenOf(l.link);
      const q = token ? await api.quote(l.id, token).catch(() => null) : null;
      setTarget({ oneTime, terms: q?.deal?.terms ?? null, since: q?.quote.createdAt ?? l.createdAt, label: `Answer ${l.id.slice(0, 8)}…` });
    } catch (e) {
      setError(e);
    } finally {
      setLoading(null);
    }
  };

  const manualOk = /^0x[0-9a-fA-F]{40}$/.test(manual.trim());

  return (
    <div className="wrap page stack" style={{ ["--g" as string]: "24px" }}>
      <div className="page-head">
        <div className="eyebrow">Ghost mode · exposure check</div>
        <h1 className="display">Does it lead back to you?</h1>
        <p>Ghost mode keeps your main wallet out of the deal. This check reads the public chain the way anyone could, and lists every hop it finds from the one-time wallet back to your wallets.</p>
      </div>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="panel">
          <div className="panel-head"><span className="panel-title">Your Ghost-mode answers</span><span className="dim mono" style={{ fontSize: 12 }}>{ghosts.length}</span></div>
          {ghosts.length === 0 ? (
            <div className="panel-pad"><span className="muted">No Ghost-mode answers saved in this browser. Answer a bid on the <Link className="link" href="/app">Terminal</Link> with Ghost mode on, or check any address below.</span></div>
          ) : (
            <ul className="notify-links">
              {ghosts.map((l) => (
                <li key={l.id} className="row between" style={{ flexWrap: "wrap", gap: 10 }}>
                  <div className="row" style={{ gap: 10 }}>
                    <span className="badge badge-info">Answer · ghost</span>
                    <span className="mono">{l.id.slice(0, 10)}…</span>
                    <span className="dim" style={{ fontSize: 12 }}>{new Date(l.createdAt).toLocaleDateString()}</span>
                  </div>
                  <button className="btn btn-sm" disabled={loading !== null} onClick={() => void pick(l)}>{loading === l.id ? "Loading…" : "Check"}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="panel-pad stack" style={{ ["--g" as string]: "10px", borderTop: "1px solid var(--line)" }}>
            <span className="label">Or any one-time wallet</span>
            <div className="notify-row">
              <input className="input mono" placeholder="0x… one-time wallet" spellCheck={false} value={manual} onChange={(e) => setManual(e.target.value)} />
              <button
                className="btn"
                disabled={!manualOk}
                onClick={() => setTarget({
                  oneTime: manual.trim().toLowerCase() as Hex,
                  terms: null,
                  since: manualSince ? new Date(manualSince).toISOString() : new Date(Date.now() - 30 * 86_400_000).toISOString(),
                  label: "Pasted address",
                })}
              >Check</button>
            </div>
            <label className="field">
              <span className="label">Created on <span className="dim" style={{ textTransform: "none" }}>optional, defaults to 30 days ago</span></span>
              <input className="input" type="date" value={manualSince} onChange={(e) => setManualSince(e.target.value)} />
            </label>
            <ErrorNote error={error} />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><span className="panel-title">What links a wallet back to you</span></div>
          <ul className="notify-events">
            {HOPS.map(([t, d]) => <li key={t}><strong>{t}</strong><span>{d}</span></li>)}
          </ul>
        </section>
      </div>

      {target && (
        <div className="stack" style={{ ["--g" as string]: "10px" }}>
          <span className="eyebrow">{target.label}{target.terms ? " · with deal terms" : " · no deal yet"}</span>
          <ExposureCheck key={target.oneTime} oneTime={target.oneTime} terms={target.terms} since={target.since} auto />
        </div>
      )}
    </div>
  );
}
