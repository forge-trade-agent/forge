/** 1:1 typed wrapper over the REST API. No crypto here: see desk.ts for the sealed flows. */
import type { RfqCreate, SealedQuoteCreate } from "@sealdesk/shared/schemas";
import { Http, type HttpOptions } from "./http.ts";
import type { DealView, Health, Hex, PermitWire, Receipt, RfqPublic, SealedQuoteView, Terms, TokenFacts } from "./types.ts";

export class ForgeApi {
  readonly http: Http;
  constructor(opts: HttpOptions) {
    this.http = new Http(opts);
  }

  health() {
    return this.http.request<Health>("GET", "/health");
  }
  listRfqs(q: { side?: "buy" | "sell"; token?: Hex; sort?: "new" | "ending" | "hot"; limit?: number } = {}) {
    return this.http.request<{ items: RfqPublic[]; counts: { open: number; buying: number; selling: number; sealed: number } }>(
      "GET", "/rfqs", { query: q },
    );
  }
  createRfq(body: Omit<RfqCreate, "allowPartial"> & { allowPartial?: boolean }) {
    return this.http.request<{ rfq: RfqPublic; manageToken: string; token: TokenFacts }>("POST", "/rfqs", { body, idempotent: true });
  }
  getRfq(id: string) {
    return this.http.request<{ rfq: RfqPublic }>("GET", `/rfqs/${encodeURIComponent(id)}`);
  }
  cancelRfq(id: string, manageToken: string) {
    return this.http.request<{ rfq: RfqPublic }>("POST", `/rfqs/${encodeURIComponent(id)}/cancel`, { token: manageToken });
  }
  sealedQuotes(id: string, manageToken: string) {
    return this.http.request<{ items: SealedQuoteView[] }>("GET", `/rfqs/${encodeURIComponent(id)}/quotes`, { token: manageToken });
  }
  sendQuote(id: string, body: SealedQuoteCreate) {
    return this.http.request<{ quoteId: string; quoteToken: string }>("POST", `/rfqs/${encodeURIComponent(id)}/quotes`, { body, idempotent: true });
  }
  accept(id: string, manageToken: string, quoteId: string, terms: Terms) {
    return this.http.request<{ deal: DealView }>("POST", `/rfqs/${encodeURIComponent(id)}/accept`, {
      token: manageToken, body: { quoteId, terms }, idempotent: true,
    });
  }
  deals(id: string, manageToken: string) {
    return this.http.request<{ items: DealView[] }>("GET", `/rfqs/${encodeURIComponent(id)}/deals`, { token: manageToken });
  }
  quote(quoteId: string, quoteToken: string) {
    return this.http.request<{ quote: { id: string; status: string; createdAt: string; acceptedAt: string | null }; rfq: RfqPublic; deal: DealView | null }>(
      "GET", `/quotes/${encodeURIComponent(quoteId)}`, { token: quoteToken },
    );
  }
  reportSettled(rfqId: string, txHash: Hex) {
    return this.http.request<{ deal: DealView }>("POST", `/rfqs/${encodeURIComponent(rfqId)}/settled`, { body: { txHash } });
  }
  receipt(txHash: Hex) {
    return this.http.request<Receipt>("GET", `/receipts/${txHash}`);
  }
  relayInfo() {
    return this.http.request<{ enabled: boolean; relayer: Hex | null; minFeeBps: number; chainId: number; escrow: Hex }>("GET", "/relay");
  }
  relayDeposit(body: { terms: Terms; permit: PermitWire | null; authDeadline: string; signature: Hex }) {
    return this.http.request<{ requestId: string; dealId: Hex; state: "queued" }>("POST", "/relay/deposit", { body, idempotent: true });
  }
  relayStatus(requestId: string) {
    return this.http.request<{ requestId: string; state: "queued" | "submitted" | "mined" | "failed"; txHash?: Hex; error?: string }>(
      "GET", `/relay/requests/${encodeURIComponent(requestId)}`,
    );
  }
  token(address: Hex) {
    return this.http.request<{ token: TokenFacts }>("GET", `/token/${address}`);
  }
  tokenMarket(address: Hex) {
    return this.http.request<{ priceUsd: string; marketCapUsd: string | null; liquidityUsd: string | null; asOf: string }>(
      "GET", `/token/${address}/market`,
    );
  }
  markets() {
    return this.http.request<{ items: { symbol: string; name: string; kind: string; token: Hex; decimals: number }[] }>("GET", "/markets");
  }
  chart(symbol: string, range: "1D" | "5D" | "1M" | "6M" | "1Y" = "1D") {
    return this.http.request<{
      interval: "5m" | "15m" | "1h" | "1d";
      asOf: string | null;
      candles: { time: number; open: number; high: number; low: number; close: number; volume?: number | null }[];
    }>(
      "GET", `/markets/${encodeURIComponent(symbol)}/chart`, { query: { range } },
    );
  }
  stats() {
    return this.http.request<Record<string, unknown>>("GET", "/stats");
  }
  referrals(address: Hex) {
    return this.http.request<{ totals: { payToken: Hex; deals: number; earned: string }[] }>("GET", `/referrals/${address}`);
  }
  subscribeNotifications(cap: { kind: "rfq" | "quote"; id: string }, token: string, channel: NotifyChannel, destination: string) {
    return this.http.request<{ subscribed: string }>("POST", "/notifications", { token, body: { capability: cap, channel, destination } });
  }
  /** Channels on a block or answer. Destinations are never returned. */
  listNotifications(cap: { kind: "rfq" | "quote"; id: string }, token: string) {
    return this.http.request<{ items: { channel: NotifyChannel; createdAt: string }[] }>("GET", "/notifications", { token, query: cap });
  }
  removeNotification(cap: { kind: "rfq" | "quote"; id: string }, token: string, channel: NotifyChannel) {
    return this.http.request<{ removed: string }>("POST", "/notifications/remove", { token, body: { capability: cap, channel } });
  }
  testNotification(cap: { kind: "rfq" | "quote"; id: string }, token: string) {
    return this.http.request<{ queued: NotifyChannel[] }>("POST", "/notifications/test", { token, body: { capability: cap } });
  }
  /** Public site settings: the token CA the operator posted, or null. */
  site() {
    return this.http.request<{ ca: SiteCa | null }>("GET", "/site");
  }
  adminSession(adminToken: string) {
    return this.http.request<{ ok: true }>("GET", "/admin/session", { token: adminToken });
  }
  setCa(adminToken: string, body: { address: string; network?: string; link?: string }) {
    return this.http.request<{ ca: SiteCa }>("PUT", "/admin/ca", { token: adminToken, body });
  }
  clearCa(adminToken: string) {
    return this.http.request<{ ca: null }>("DELETE", "/admin/ca", { token: adminToken });
  }
}

export interface SiteCa {
  address: string;
  network?: string;
  link?: string;
  updatedAt: string;
}

export type NotifyChannel = "telegram" | "email" | "webhook";
