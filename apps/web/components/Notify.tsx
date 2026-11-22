"use client";
/**
 * Telegram / email / webhook alerts for one private link. Bound to the link's token, never to an
 * account. Alerts only say that something happened; the details stay behind the private link.
 */
import { useCallback, useEffect, useState } from "react";
import type { NotifyChannel } from "@sealdesk/sdk";
import { ErrorNote, Segmented } from "@/components/ui";
import { api, getDesk } from "@/lib/desk";

export type Cap = { kind: "rfq" | "quote"; id: string };

export const CHANNEL_LABEL: Record<NotifyChannel, string> = { telegram: "Telegram", email: "Email", webhook: "Webhook" };

export const EVENTS: [string, string][] = [
  ["Answer received", "A sealed answer arrived on your block."],
  ["Answer accepted", "The poster picked your answer: check the terms and deposit."],
  ["Payment locked", "The buyer paid into the escrow; the seller can deliver."],
  ["Deadline near", "Less than 30 minutes left on a deal."],
  ["Settled", "The swap went through on-chain."],
  ["Refunded", "The deadline passed and deposits went back."],
];

export interface NotifyConfig { channels: NotifyChannel[]; telegramBot: string | null }

/** Channels this desk can deliver, from /health. */
export function useNotifyConfig(): NotifyConfig | null {
  const [cfg, setCfg] = useState<NotifyConfig | null>(null);
  useEffect(() => {
    getDesk().then(
      ({ health }) => setCfg(health.notifications ?? { channels: ["telegram", "email", "webhook"], telegramBot: null }),
      () => setCfg({ channels: [], telegramBot: null }),
    );
  }, []);
  return cfg;
}

/** The access token inside a private link (#k=…&t=…). */
export function tokenOf(link: string): string | null {
  try {
    return new URLSearchParams(new URL(link).hash.replace(/^#/, "")).get("t");
  } catch {
    return null;
  }
}

export function validDestination(channel: NotifyChannel, v: string): string | null {
  const s = v.trim();
  if (!s) return "Required";
  if (channel === "telegram" && !/^-?\d{1,20}$/.test(s)) return "A Telegram chat id is a number, like 123456789";
  if (channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "Enter an email address";
  if (channel === "webhook") {
    try {
      if (new URL(s).protocol !== "https:") return "Webhooks must use https://";
    } catch {
      return "Enter a full https:// URL";
    }
  }
  return null;
}

const PLACEHOLDER: Record<NotifyChannel, string> = {
  telegram: "Chat id, e.g. 123456789",
  email: "you@example.com",
  webhook: "https://your-server.example/hooks/desk",
};

/** Channel picker + destination field. Shared by the per-link panel and "add to every block". */
export function DestinationForm({
  cfg, busy, cta, onSubmit,
}: { cfg: NotifyConfig; busy: boolean; cta: string; onSubmit: (channel: NotifyChannel, destination: string) => void }) {
  const [channel, setChannel] = useState<NotifyChannel>(cfg.channels[0] ?? "telegram");
  const [dest, setDest] = useState("");
  const [touched, setTouched] = useState(false);
  const problem = validDestination(channel, dest);
  if (cfg.channels.length === 0) return <div className="warnbox">Alerts are switched off on this desk.</div>;
  return (
    <form
      className="stack"
      style={{ ["--g" as string]: "10px" }}
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (problem) return;
        onSubmit(channel, dest.trim());
        setDest("");
        setTouched(false);
      }}
    >
      <Segmented label="Alert channel" value={channel} onChange={(c) => { setChannel(c); setDest(""); setTouched(false); }} options={cfg.channels.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />
      <div className="notify-row">
        <input
          className={`input${touched && problem ? " invalid" : ""}`}
          aria-label={`${CHANNEL_LABEL[channel]} destination`}
          inputMode={channel === "telegram" ? "numeric" : channel === "email" ? "email" : "url"}
          placeholder={PLACEHOLDER[channel]}
          value={dest}
          onChange={(e) => setDest(e.target.value)}
          onBlur={() => setTouched(true)}
        />
        <button className="btn btn-buy" type="submit" disabled={busy}>{busy ? "Saving…" : cta}</button>
      </div>
      {touched && problem && dest && <span className="hint" style={{ color: "var(--sell)" }}>{problem}</span>}
      <ChannelHelp channel={channel} bot={cfg.telegramBot} />
    </form>
  );
}

function ChannelHelp({ channel, bot }: { channel: NotifyChannel; bot: string | null }) {
  if (channel === "telegram") {
    return (
      <span className="hint">
        {bot ? <>Open <a className="link" href={`https://t.me/${bot}`} target="_blank" rel="noreferrer">@{bot}</a> and press Start so it can message you. </> : "Start a chat with the desk's alert bot so it can message you. "}
        Your chat id is the number <a className="link" href="https://t.me/userinfobot" target="_blank" rel="noreferrer">@userinfobot</a> replies with.
      </span>
    );
  }
  if (channel === "email") return <span className="hint">One line per event, no prices or links. Check spam the first time.</span>;
  return <span className="hint">We POST <code>{`{"event","ref","at"}`}</code> as JSON. Public https only; redirects are refused.</span>;
}

/** Alerts for one private link: what's on, add a channel, remove one, send a test. */
export function NotifyPanel({ cap, token, flat, onChange }: { cap: Cap; token: string; flat?: boolean; onChange?: () => void }) {
  const cfg = useNotifyConfig();
  const [items, setItems] = useState<{ channel: NotifyChannel; createdAt: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.listNotifications(cap, token)).items);
    } catch (e) {
      setError(e);
      setItems([]);
    }
  }, [cap.kind, cap.id, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => void load(), [load]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      setMsg(await fn());
      await load();
      onChange?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className="stack" style={{ ["--g" as string]: "14px" }}>
      {items === null ? <span className="dim">Loading…</span> : items.length === 0 ? (
        <span className="muted">No alerts on this {cap.kind === "rfq" ? "block" : "answer"} yet. You&apos;ll only see news when you open the link.</span>
      ) : (
        <ul className="notify-list">
          {items.map((i) => (
            <li key={i.channel}>
              <span className="badge badge-buy">{CHANNEL_LABEL[i.channel]}</span>
              <span className="dim" style={{ fontSize: 12 }}>on since {new Date(i.createdAt).toLocaleDateString()}</span>
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void run(async () => {
                await api.removeNotification(cap, token, i.channel);
                return `${CHANNEL_LABEL[i.channel]} alerts removed.`;
              })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {cfg && (
        <DestinationForm
          cfg={cfg}
          busy={busy}
          cta={items?.length ? "Add / replace" : "Turn on"}
          onSubmit={(channel, d) => void run(async () => {
            await api.subscribeNotifications(cap, token, channel, d);
            return `${CHANNEL_LABEL[channel]} alerts are on. Send a test to check it arrives.`;
          })}
        />
      )}
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <span className="hint">Alerts say what happened, never the price, the terms or your link. The address is stored encrypted.</span>
        <button className="btn btn-sm" disabled={busy || !items?.length} onClick={() => void run(async () => {
          const r = await api.testNotification(cap, token);
          return `Test alert sent to ${r.queued.map((c) => CHANNEL_LABEL[c]).join(", ")}.`;
        })}>Send test alert</button>
      </div>
      {msg && <div className="okbox">{msg}</div>}
      <ErrorNote error={error} />
    </div>
  );

  if (flat) return body;
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Alerts</span>
        <span className="dim mono" style={{ fontSize: 12 }}>{items?.length ? items.map((i) => CHANNEL_LABEL[i.channel]).join(" · ") : "off"}</span>
      </div>
      <div className="panel-pad">{body}</div>
    </section>
  );
}
