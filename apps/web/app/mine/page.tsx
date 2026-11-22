"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { decryptBackup, encryptBackup } from "@sealdesk/sdk";
import { Copy, ErrorNote, Modal } from "@/components/ui";
import { useLinks } from "@/lib/hooks";
import { links, type SavedLink } from "@/lib/keys";

export default function MinePage() {
  const list = useLinks();
  const [mode, setMode] = useState<"export" | "import" | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const entries = list.map((l) => ({
        kind: l.kind, id: l.id, link: l.link, createdAt: l.createdAt,
        ...(l.label ? { label: l.label } : {}), ...(l.side ? { side: l.side } : {}), ...(l.ghostKey ? { ghostKey: l.ghostKey } : {}),
      }));
      const out = JSON.stringify(await encryptBackup(entries, pass), null, 2);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([out], { type: "application/json" }));
      a.download = `forge-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setMsg(`Exported ${entries.length} private links.`);
      setMode(null);
      setPass("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    const f = file.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const entries = await decryptBackup(JSON.parse(await f.text()), pass);
      const merged = new Map(links.all().map((l) => [`${l.kind}:${l.id}`, l]));
      for (const e of entries) merged.set(`${e.kind}:${e.id}`, e as SavedLink);
      links.replaceAll([...merged.values()]);
      setMsg(`Imported ${entries.length} private links.`);
      setMode(null);
      setPass("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap page stack" style={{ ["--g" as string]: "16px" }}>
      <div className="page-head">
        <div className="eyebrow">My blocks</div>
        <h1 className="display">Your private links.</h1>
        <p>Saved in this browser only. The links themselves are the keys. <Link className="link" href="/notifications">Get alerts on Telegram or email →</Link></p>
      </div>
      <section className="panel panel-pad stack" style={{ ["--g" as string]: "12px" }}>
        <strong>Backup</strong>
        <span className="muted">Move your private links to another browser or device. The file is encrypted with your passphrase (Argon2id + XChaCha20-Poly1305).</span>
        <div className="row">
          <button className="btn" disabled={!list.length} onClick={() => setMode("export")}>Download backup</button>
          <button className="btn btn-ghost" onClick={() => setMode("import")}>Import backup</button>
        </div>
        <div className="warnbox">Anyone with the file and passphrase can read your answers and accept for you. Keep both like a password.</div>
        {msg && <div className="okbox">{msg}</div>}
      </section>
      <section className="panel">
        <div className="panel-head"><span className="panel-title">Saved here</span><span className="dim mono" style={{ fontSize: 12 }}>{list.length}</span></div>
        {list.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Type</th><th>Id</th><th>Created</th><th>Link</th><th /></tr></thead>
              <tbody>
                {list.map((l) => (
                  <tr key={l.kind + l.id}>
                    <td>
                      <span className={`badge ${l.kind === "rfq" ? (l.side === "sell" ? "badge-sell" : "badge-buy") : "badge-info"}`}>
                        {l.kind === "rfq" ? (l.side === "sell" ? "Listing" : "Bid") : l.ghostKey ? "Answer · ghost" : "Answer"}
                      </span>
                    </td>
                    <td className="mono">{l.id.slice(0, 10)}…</td>
                    <td className="dim">{new Date(l.createdAt).toLocaleString()}</td>
                    <td><a className="link" href={l.link}>Open →</a> <Copy text={l.link} label="Copy private link" /></td>
                    <td><button className="btn btn-sm btn-ghost" onClick={() => confirm("Remove this private link from this browser? Without a backup you lose access.") && links.remove(l.kind, l.id)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Modal open={mode !== null} onClose={() => setMode(null)} label={mode === "export" ? "Download backup" : "Import backup"}>
        <div className="stack" style={{ ["--g" as string]: "14px" }}>
          <strong style={{ fontSize: 18 }}>{mode === "export" ? "Encrypt and download" : "Import a backup"}</strong>
          {mode === "import" && <input ref={file} type="file" accept="application/json" className="input" style={{ paddingTop: 10 }} />}
          <div className="field">
            <span className="label">Passphrase (12+ characters)</span>
            <input className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
          <ErrorNote error={error} />
          <button className="btn btn-buy" disabled={busy || pass.length < 12} onClick={() => void (mode === "export" ? doExport() : doImport())}>
            {busy ? "Working… (key stretching takes a few seconds)" : mode === "export" ? "Download" : "Import"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
