"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CHANNEL_LABEL, DestinationForm, EVENTS, NotifyPanel, tokenOf, useNotifyConfig } from "@/components/Notify";
import { ErrorNote } from "@/components/ui";
import { api } from "@/lib/desk";
import { useLinks } from "@/lib/hooks";
import type { SavedLink } from "@/lib/keys";

function kindLabel(l: SavedLink) {
  if (l.kind === "quote") return l.ghostKey ? "Answer · ghost" : "Answer";
  return l.side === "sell" ? "Listing" : "Bid";
}

export default function NotificationsPage() {
  const list = useLinks();
  const cfg = useNotifyConfig();
  const usable = list.filter((l) => tokenOf(l.link));
  const [on, setOn] = useState<Record<string, string[] | null>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  // Which channels each saved link has, one request per link.
  const keys = usable.map((l) => l.kind + l.id).join(",");
  useEffect(() => {
    let live = true;
    void Promise.all(
      usable.map(async (l) => {
        try {
          const r = await api.listNotifications({ kind: l.kind, id: l.id }, tokenOf(l.link)!);
          return [l.kind + l.id, r.items.map((i) => CHANNEL_LABEL[i.channel])] as const;
        } catch {
          return [l.kind + l.id, null] as const; // expired, cancelled long ago, or from another desk
        }
      }),
    ).then((rows) => live && setOn(Object.fromEntries(rows)));
    return () => {
      live = false;
    };
  }, [keys, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bulk-add only to links the desk still knows.
  const live = usable.filter((l) => Array.isArray(on[l.kind + l.id]));

  const addAll = async (channel: Parameters<typeof api.subscribeNotifications>[2], dest: string) => {
    setBusy(true);
    setError(null);
    setMsg(null);
    let ok = 0;
    let lastErr: unknown = null;
    for (const l of live) {
      try {
        await api.subscribeNotifications({ kind: l.kind, id: l.id }, tokenOf(l.link)!, channel, dest);
        ok++;
      } catch (e) {
        lastErr = e;
      }
    }
    setMsg(`${CHANNEL_LABEL[channel]} alerts on for ${ok} of ${live.length} private links.`);
    if (lastErr) setError(lastErr);
    setTick((t) => t + 1);
    setBusy(false);
  };

  return (
    <div className="wrap page stack" style={{ ["--g" as string]: "24px" }}>
      <div className="page-head">
        <div className="eyebrow">Alerts</div>
        <h1 className="display">Know when it moves.</h1>
        <p>Get a Telegram message, an email or a webhook when someone answers your block or a deal changes step. No account: each alert is tied to one private link.</p>
      </div>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="panel">
          <div className="panel-head"><span className="panel-title">Add to every block in this browser</span><span className="dim mono" style={{ fontSize: 12 }}>{live.length}</span></div>
          <div className="panel-pad stack" style={{ ["--g" as string]: "14px" }}>
            {usable.length === 0 ? (
              <span className="muted">No private links saved here yet. <Link className="link" href="/otc">Post a block</Link> or answer one on the <Link className="link" href="/app">Terminal</Link>, then come back.</span>
            ) : cfg && live.length ? (
              <DestinationForm cfg={cfg} busy={busy} cta={`Turn on for ${live.length}`} onSubmit={(c, d) => void addAll(c, d)} />
            ) : cfg && Object.keys(on).length ? <span className="muted">None of the links saved here are on this desk any more.</span> : <span className="dim">Loading…</span>}
            <span className="hint">New blocks don&apos;t inherit this: turn alerts on from the block&apos;s own page, or come back here.</span>
            {msg && <div className="okbox">{msg}</div>}
            <ErrorNote error={error} />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><span className="panel-title">What you get alerts for</span></div>
          <ul className="notify-events">
            {EVENTS.map(([t, d]) => <li key={t}><strong>{t}</strong><span>{d}</span></li>)}
          </ul>
          <p className="hint" style={{ padding: "0 16px 16px", margin: 0 }}>Each message carries a short reference, never the price, the terms or the link. Destinations are encrypted on our server and never shown back, not even to you.</p>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><span className="panel-title">Per block</span><Link className="link" href="/mine" style={{ fontSize: 12 }}>My blocks →</Link></div>
        {usable.length === 0 ? <div className="empty">Nothing yet.</div> : (
          <ul className="notify-links">
            {usable.map((l) => {
              const k = l.kind + l.id;
              const ch = on[k];
              return (
                <li key={k}>
                  <div className="row between" style={{ flexWrap: "wrap", gap: 10 }}>
                    <div className="row" style={{ gap: 10 }}>
                      <span className={`badge ${l.kind === "rfq" ? (l.side === "sell" ? "badge-sell" : "badge-buy") : "badge-info"}`}>{kindLabel(l)}</span>
                      <span className="mono">{l.label ?? `${l.id.slice(0, 10)}…`}</span>
                      <span className="dim" style={{ fontSize: 12 }}>{new Date(l.createdAt).toLocaleDateString()}</span>
                    </div>
                    <div className="row" style={{ gap: 10 }}>
                      <span className={ch && ch.length ? "up mono" : "dim mono"} style={{ fontSize: 12 }}>{ch === undefined ? "…" : ch === null ? "not on this desk" : ch.length ? ch.join(" · ") : "off"}</span>
                      {ch !== null && <button className="btn btn-sm" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>{open === k ? "Close" : "Manage"}</button>}
                    </div>
                  </div>
                  {open === k && (
                    <div style={{ marginTop: 14 }}>
                      <NotifyPanel cap={{ kind: l.kind, id: l.id }} token={tokenOf(l.link)!} flat onChange={() => setTick((t) => t + 1)} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
