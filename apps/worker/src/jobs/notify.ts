/**
 * Out-of-band alerts. Tails the global notify channel, resolves the capability behind each
 * event, and delivers to that capability's subscriptions.
 * Messages never contain prices, terms, links or link secrets: only "something happened, open
 * your private link".
 */
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { notificationSubscriptions, quotes, rfqs, type AnyDb } from "@sealdesk/db";
import { decryptAtRest } from "@sealdesk/crypto";
import { NOTIFY_CHANNEL, type Cache, type DeskEvent, type EventBus, type Logger } from "@sealdesk/shared";

export interface Senders {
  telegram(chatId: string, text: string): Promise<void>;
  email(to: string, subject: string, text: string): Promise<void>;
  webhook(url: string, payload: Record<string, unknown>): Promise<void>;
}

const TEXT: Record<string, string> = {
  "answer.received": "A sealed answer arrived on your block.",
  "deal.accepted": "Your answer was accepted. Check the terms and deposit before the deadline.",
  "payment.locked": "Payment is locked in the escrow. The seller can now deliver.",
  "deal.settled": "Your deal settled on-chain.",
  "deal.refunded": "Your deal was refunded after the deadline.",
  "deadline.near": "A deal deadline is less than 30 minutes away.",
  "notify.test": "Test alert: notifications for this block are on.",
};

export class NotifyDispatcher {
  private readonly db: AnyDb;
  private readonly bus: EventBus;
  private readonly cache: Cache;
  private readonly senders: Senders;
  private readonly key: Uint8Array;
  private readonly log: Logger;
  private readonly brand: string;

  constructor(deps: { db: AnyDb; bus: EventBus; cache: Cache; senders: Senders; key: Uint8Array; log: Logger; brand?: string }) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.cache = deps.cache;
    this.senders = deps.senders;
    this.key = deps.key;
    this.log = deps.log;
    this.brand = deps.brand ?? "Forge";
  }

  /** Process the next batch of notify events. Returns how many messages were sent. */
  async drain(blockMs: number): Promise<number> {
    const cursor = (await this.cache.get<number>("notify:cursor")) ?? 0;
    const events = await this.bus.read(NOTIFY_CHANNEL, cursor, blockMs);
    let sent = 0;
    for (const e of events) {
      sent += await this.deliver(e);
      await this.cache.set("notify:cursor", e.seq, 30 * 86_400);
    }
    return sent;
  }

  private async capabilityHash(channel: string): Promise<Uint8Array | null> {
    const [kind, id] = channel.split(":");
    if (kind === "rfq") {
      const [r] = await this.db.select({ h: rfqs.manageTokenHash }).from(rfqs).where(eq(rfqs.id, id!));
      return r?.h ?? null;
    }
    if (kind === "quote") {
      const [q] = await this.db.select({ h: quotes.quoteTokenHash }).from(quotes).where(eq(quotes.id, id!));
      return q?.h ?? null;
    }
    return null;
  }

  private async deliver(e: DeskEvent): Promise<number> {
    const channel = String(e.data["channel"] ?? "");
    const text = TEXT[e.type];
    if (!text) return 0;
    const h = await this.capabilityHash(channel);
    if (!h) return 0;
    const subs = await this.db.select().from(notificationSubscriptions).where(eq(notificationSubscriptions.capabilityHash, Buffer.from(h)));
    const ref = channel.split(":")[1]!.slice(0, 6);
    let sent = 0;
    for (const s of subs) {
      try {
        const dest = decryptAtRest(this.key, s.destinationEnc, `notify:${s.channel}`);
        if (s.channel === "telegram") await this.senders.telegram(dest, `${this.brand}: ${text} (ref ${ref})`);
        else if (s.channel === "email") await this.senders.email(dest, `${this.brand}: ${text}`, `${text}\n\nReference: ${ref}\nOpen your private link to see details.`);
        else await this.senders.webhook(dest, { event: e.type, ref, at: e.at });
        sent++;
      } catch (err) {
        // One bad destination never blocks the others; failures are logged without the destination.
        this.log.warn({ err: (err as Error).message, channel: s.channel, event: e.type }, "notification failed");
      }
    }
    return sent;
  }
}

// ---------------------------------------------------------------- real senders

const PRIVATE_V4 = [
  [0x0a000000, 8], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0a80000, 16],
  [0x64400000, 10], [0x00000000, 8], [0xe0000000, 4], [0xf0000000, 4],
] as const;

export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    return !PRIVATE_V4.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb")) return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return mapped ? isPublicIp(mapped[1]!) : true;
  }
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;
const dnsResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** SSRF guard: webhooks may only reach public addresses over HTTPS. */
export async function assertPublicHttps(url: string, resolve: Resolver = dnsResolver): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("webhooks must use https");
  if (u.username || u.password) throw new Error("credentials in webhook URLs are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : await resolve(host);
  if (ips.length === 0 || !ips.every(isPublicIp)) throw new Error("webhook host does not resolve to a public address");
}

export function createSenders(opts: {
  telegramToken?: string | undefined;
  smtpUrl?: string | undefined;
  webhookKey: Uint8Array;
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  mailFrom?: string;
}): Senders {
  const f = opts.fetchImpl ?? fetch;
  let transporter: { sendMail(m: Record<string, string>): Promise<unknown> } | null = null;
  return {
    async telegram(chatId, text) {
      if (!opts.telegramToken) throw new Error("telegram not configured");
      const res = await f(`https://api.telegram.org/bot${opts.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`telegram ${res.status}`);
    },
    async email(to, subject, text) {
      if (!opts.smtpUrl) throw new Error("email not configured");
      if (!transporter) {
        const nodemailer = await import("nodemailer");
        transporter = nodemailer.createTransport(opts.smtpUrl);
      }
      await transporter.sendMail({ from: opts.mailFrom ?? "alerts@forge.invalid", to, subject, text });
    },
    async webhook(url, payload) {
      await assertPublicHttps(url, opts.resolve);
      const body = JSON.stringify(payload);
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = createHmac("sha256", opts.webhookKey).update(`${ts}.${body}`).digest("hex");
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forge-timestamp": ts, "x-forge-signature": `sha256=${sig}` },
        body,
        redirect: "error", // a redirect could point at an internal address
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`webhook ${res.status}`);
    },
  };
}
