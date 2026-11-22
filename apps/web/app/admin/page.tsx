"use client";
/**
 * Operator page: post or remove the token's contract address (CA) shown across the site.
 * Unlocked with the ADMIN_TOKEN set on the API. The token stays in this tab only (sessionStorage).
 */
import { useEffect, useState, type FormEvent } from "react";
import { CA_EVENT, useSiteCa } from "@/components/SiteCa";
import { Copy, ErrorNote } from "@/components/ui";
import { BRAND, CHAIN_NAME } from "@/lib/config";
import { api } from "@/lib/desk";

const KEY = "forge.admin.v1";
const EVM = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function readToken(): string {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}
function writeToken(t: string | null) {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* private mode: the token simply isn't remembered */
  }
}

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null); // unlocked token
  const [draft, setDraft] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Re-use a token from this tab after a refresh.
  useEffect(() => {
    const t = readToken();
    if (!t) return;
    api.adminSession(t).then(() => setToken(t), () => writeToken(null));
  }, []);

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setError(null);
    try {
      await api.adminSession(draft.trim());
      writeToken(draft.trim());
      setToken(draft.trim());
      setDraft("");
    } catch (err) {
      setError(err);
    } finally {
      setChecking(false);
    }
  };

  const lock = () => {
    writeToken(null);
    setToken(null);
  };

  return (
    <div className="wrap page stack" style={{ ["--g" as string]: "24px", maxWidth: 760 }}>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="display">Token address</h1>
        <p>Post the ${BRAND.token} contract address (CA). It shows in the bar at the top of every page, in the footer and on the token strip. Until you post one, the site says &ldquo;Coming soon&rdquo;.</p>
      </div>

      {token ? (
        <CaEditor token={token} onLock={lock} />
      ) : (
        <section className="panel">
          <div className="panel-head"><span className="panel-title">Unlock</span></div>
          <form className="panel-pad stack" style={{ ["--g" as string]: "12px" }} onSubmit={unlock}>
            <label className="stack" style={{ ["--g" as string]: "6px" }}>
              <span className="label">Admin token</span>
              <input className="input" type="password" autoComplete="current-password" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="ADMIN_TOKEN from the API's environment" />
            </label>
            <ErrorNote error={error} />
            <div className="row">
              <button className="btn btn-buy" disabled={!draft.trim() || checking}>{checking ? "Checking…" : "Unlock"}</button>
            </div>
            <p className="hint">The token is kept in this tab only and is forgotten when you close it. Eight wrong tries lock this address out for 15 minutes.</p>
          </form>
        </section>
      )}
    </div>
  );
}

function CaEditor({ token, onLock }: { token: string; onLock: () => void }) {
  const { ca, loading } = useSiteCa();
  const [address, setAddress] = useState("");
  const [network, setNetwork] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Start the form from what is live.
  useEffect(() => {
    if (!ca) return;
    setAddress(ca.address);
    setNetwork(ca.network ?? "");
    setLink(ca.link ?? "");
  }, [ca]);

  const addr = address.trim();
  const valid = EVM.test(addr) || BASE58.test(addr);
  const linkOk = !link.trim() || /^https:\/\/\S+$/.test(link.trim());

  const done = (text: string) => {
    setMsg(text);
    window.dispatchEvent(new Event(CA_EVENT));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setError(null);
    setMsg(null);
    try {
      await api.setCa(token, { address: addr, ...(network.trim() ? { network: network.trim() } : {}), ...(link.trim() ? { link: link.trim() } : {}) });
      done("Posted. Every page shows the new CA within a few seconds.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy("clear");
    setError(null);
    setMsg(null);
    try {
      await api.clearCa(token);
      setAddress("");
      setNetwork("");
      setLink("");
      setConfirmClear(false);
      done("Removed. The site shows “Coming soon” again.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Live now</span>
          <button className="btn btn-sm btn-ghost" onClick={onLock}>Lock</button>
        </div>
        <div className="panel-pad stack" style={{ ["--g" as string]: "8px" }}>
          {loading && !ca ? (
            <span className="dim">Reading…</span>
          ) : ca ? (
            <>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <code className="num" style={{ overflowWrap: "anywhere" }}>{ca.address}</code>
                <Copy text={ca.address} label="Copy CA" />
              </div>
              <span className="hint">
                {ca.network ? `${ca.network} · ` : ""}updated {new Date(ca.updatedAt).toLocaleString()}
                {ca.link ? <> · <a className="link" href={ca.link} target="_blank" rel="noreferrer noopener">link ↗</a></> : null}
              </span>
            </>
          ) : (
            <span className="dim">No CA posted. The site shows &ldquo;Coming soon&rdquo;.</span>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><span className="panel-title">{ca ? "Change the CA" : "Post the CA"}</span></div>
        <form className="panel-pad stack" style={{ ["--g" as string]: "14px" }} onSubmit={save}>
          <label className="stack" style={{ ["--g" as string]: "6px" }}>
            <span className="label">Contract address</span>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x… or a Solana address" spellCheck={false} autoComplete="off" />
            {addr && !valid && <span className="err">That doesn&rsquo;t look like an EVM (0x + 40 hex) or Solana address.</span>}
          </label>
          <div className="grid-2">
            <label className="stack" style={{ ["--g" as string]: "6px" }}>
              <span className="label">Network (optional)</span>
              <input className="input" value={network} maxLength={40} onChange={(e) => setNetwork(e.target.value)} placeholder={CHAIN_NAME} />
            </label>
            <label className="stack" style={{ ["--g" as string]: "6px" }}>
              <span className="label">Chart or swap link (optional)</span>
              <input className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" spellCheck={false} />
              {!linkOk && <span className="err">Use a full https:// link.</span>}
            </label>
          </div>
          <div className="warnbox">Check the address twice before posting. People will copy it to buy ${BRAND.token}; a wrong CA sends them to someone else&rsquo;s token.</div>
          <ErrorNote error={error} />
          {msg && <div className="okbox" role="status">{msg}</div>}
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-buy" disabled={!valid || !linkOk || busy !== null}>{busy === "save" ? "Posting…" : ca ? "Update CA" : "Post CA"}</button>
            {ca && !confirmClear && <button type="button" className="btn btn-sell" onClick={() => setConfirmClear(true)} disabled={busy !== null}>Remove CA</button>}
            {ca && confirmClear && (
              <>
                <button type="button" className="btn btn-sell" onClick={clear} disabled={busy !== null}>{busy === "clear" ? "Removing…" : "Yes, remove it"}</button>
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmClear(false)}>Cancel</button>
              </>
            )}
          </div>
        </form>
      </section>
    </>
  );
}
