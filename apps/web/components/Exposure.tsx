"use client";
/**
 * Exposure check UI: runs the SDK's check in this browser, against the chain RPC, and shows which
 * public hops link a Ghost-mode one-time wallet back to your wallets.
 */
import { useEffect, useState } from "react";
import { checkExposure, viemExposureReader, type ExposureReport, type Hex, type Terms } from "@sealdesk/sdk";
import { AddressPill, ErrorNote } from "@/components/ui";
import { explorerTx } from "@/lib/config";
import { getDesk, publicClient } from "@/lib/desk";
import { useWallet } from "@/lib/wallet";

const MINE_KEY = "sealdesk.mine.v1";
const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/** Extra wallets you call yours, remembered in this browser only. */
function useMyWallets(): [string, (v: string) => void] {
  const [v, setV] = useState("");
  useEffect(() => {
    try {
      setV(window.localStorage.getItem(MINE_KEY) ?? "");
    } catch {
      /* storage blocked */
    }
  }, []);
  return [v, (next) => {
    setV(next);
    try {
      window.localStorage.setItem(MINE_KEY, next);
    } catch {
      /* storage blocked */
    }
  }];
}

export function parseAddrs(s: string): Hex[] {
  return [...new Set(s.split(/[\s,;]+/).map((x) => x.trim()).filter(isAddr).map((x) => x.toLowerCase() as Hex))];
}

const VERDICT: Record<ExposureReport["level"], { label: string; tone: string; line: string }> = {
  exposed: { label: "Linked", tone: "badge-sell", line: "A single public hop connects this one-time wallet to your wallet." },
  weak: { label: "Weak link", tone: "badge-warn", line: "Two public hops connect it to your wallet. Harder to spot, still findable." },
  clean: { label: "No link found", tone: "badge-buy", line: "Nothing in token transfers or the deal terms points back to your wallets." },
};

const SEV: Record<ExposureReport["findings"][number]["severity"], [string, string]> = {
  direct: ["badge-sell", "direct"],
  indirect: ["badge-warn", "2 hops"],
  info: ["badge-info", "note"],
  ok: ["badge-dim", "ok"],
};

export function ExposureCheck({ oneTime, terms, since, auto }: { oneTime: Hex; terms?: Terms | null | undefined; since: string; auto?: boolean }) {
  const w = useWallet();
  const [extra, setExtra] = useMyWallets();
  const [report, setReport] = useState<ExposureReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mine = [...new Set([...(w.address ? [w.address.toLowerCase() as Hex] : []), ...parseAddrs(extra)])];

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { health } = await getDesk();
      const ignore = [health.contracts.escrow, health.contracts.feeVault, ...(health.relayer ? [health.relayer] : [])];
      setReport(await checkExposure(viemExposureReader(publicClient), { oneTime, terms: terms ?? null, mine, since: new Date(since), ignore }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (auto) void run();
  }, [auto, oneTime]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = report ? VERDICT[report.level] : null;
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Exposure check</span>
        {v ? <span className={`badge ${v.tone}`}>{v.label}</span> : <span className="dim mono" style={{ fontSize: 12 }}>not run</span>}
      </div>
      <div className="panel-pad stack" style={{ ["--g" as string]: "14px" }}>
        <div className="exp-who">
          <div className="stack" style={{ ["--g" as string]: "6px" }}>
            <span className="label">One-time wallet</span>
            <AddressPill address={oneTime} n={6} />
          </div>
          <div className="stack" style={{ ["--g" as string]: "6px" }}>
            <span className="label">Your wallets</span>
            <span className="muted" style={{ fontSize: 13 }}>
              {w.address ? <>Connected: <AddressPill address={w.address} n={4} copy={false} /></> : "No wallet connected"}
              {parseAddrs(extra).length ? ` + ${parseAddrs(extra).length} added` : ""}
            </span>
          </div>
        </div>
        <label className="field">
          <span className="label">Other wallets of yours <span className="dim" style={{ textTransform: "none" }}>optional, one per line, kept in this browser</span></span>
          <textarea className="textarea mono" rows={2} spellCheck={false} placeholder="0x…" value={extra} onChange={(e) => setExtra(e.target.value)} style={{ fontSize: 12 }} />
        </label>
        <div className="row between" style={{ flexWrap: "wrap" }}>
          <span className="hint">Reads public chain data from this browser. Your addresses aren&apos;t sent to the desk.</span>
          <button className="btn btn-sm" disabled={busy} onClick={() => void run()}>{busy ? "Checking…" : report ? "Check again" : "Run check"}</button>
        </div>
        <ErrorNote error={error} />
        {report && v && (
          <>
            <div className={report.level === "exposed" ? "errbox" : report.level === "weak" ? "warnbox" : "okbox"}>{v.line}</div>
            <ul className="exp-list">
              {report.findings.map((f, i) => {
                const [tone, tag] = SEV[f.severity];
                const link = f.tx ? explorerTx(f.tx) : null;
                return (
                  <li key={i}>
                    <span className={`badge ${tone}`}>{tag}</span>
                    <div className="stack" style={{ ["--g" as string]: "6px", minWidth: 0 }}>
                      <strong>{f.title}</strong>
                      <span className="muted" style={{ fontSize: 13 }}>{f.detail}</span>
                      {f.path && (
                        <div className="exp-path" aria-label="Public path">
                          {f.path.map((a, j) => (
                            <span key={a + j} className="exp-hop">
                              {j > 0 && <span className="dim">→</span>}
                              <span className={`mono ${j === 0 ? "exp-you" : j === f.path!.length - 1 ? "exp-one" : ""}`}>{j === 0 ? "you " : j === f.path!.length - 1 ? "one-time " : ""}{a.slice(0, 6)}…{a.slice(-4)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {f.tx && (link ? <a className="link mono" style={{ fontSize: 12 }} href={link} target="_blank" rel="noreferrer">tx {f.tx.slice(0, 10)}… ↗</a> : <span className="dim mono" style={{ fontSize: 12 }}>tx {f.tx.slice(0, 10)}…</span>)}
                    </div>
                  </li>
                );
              })}
            </ul>
            <span className="hint">
              Scanned blocks {report.scanned.fromBlock}–{report.scanned.toBlock} for the one-time wallet and the last {report.scanned.lookbackDays} days for links to your wallets{report.scanned.partial ? " (partly: the RPC limited the range)" : ""}. Not covered: native ETH transfers, exchange accounts, timing and amount patterns.
            </span>
          </>
        )}
      </div>
    </section>
  );
}
