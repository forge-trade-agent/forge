"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { subscribe, type StreamEvent } from "@sealdesk/sdk";
import { api } from "./desk";
import { API_URL } from "./config";
import { links, type SavedLink } from "./keys";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => id === seq.current && setState({ data, error: null, loading: false }),
      (error: Error) => id === seq.current && setState((s) => ({ data: s.data, error, loading: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    run();
  }, [run]);
  return { ...state, reload: run };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export type Markets = Awaited<ReturnType<typeof api.markets>>["items"];
export interface MarketItem {
  symbol: string;
  name: string;
  kind: string;
  token: `0x${string}`;
  decimals: number;
  logoUrl?: string | null;
  exchange?: string | null;
  permit?: boolean;
  verified?: boolean;
  reference: null | { delayed: boolean; price: string; prevClose: string | null; changePct: string | null; sparkline5d: [string, string][] };
  open: { bids: number; listings: number };
  /** Pool price, for tokens with no listed stock behind them. */
  dex?: { price: string; change24hPct: string | null } | null;
}

// Shared by every component on the page, refreshed after a minute so new listings and prices show
// up without a reload (the API caches the list for 30 seconds).
const MARKETS_TTL = 60_000;
let marketsP: Promise<MarketItem[]> | null = null;
let marketsAt = 0;
export function loadMarkets(): Promise<MarketItem[]> {
  if (!marketsP || Date.now() - marketsAt > MARKETS_TTL) {
    marketsAt = Date.now();
    marketsP = api.markets().then((r) => r.items as unknown as MarketItem[]);
    marketsP.catch(() => (marketsP = null));
  }
  return marketsP;
}
export function useMarkets() {
  return useAsync(loadMarkets, []);
}

/** Live events on a channel; resumes after reconnects. */
export function useStream(channel: string | null, token: string | null, onEvent: (e: StreamEvent) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!channel) return;
    const sub = subscribe({ baseUrl: API_URL, channel, ...(token ? { token } : {}), onEvent: (e) => cb.current(e) });
    return () => sub.close();
  }, [channel, token]);
}

export function useLinks(): SavedLink[] {
  const [list, setList] = useState<SavedLink[]>([]);
  useEffect(() => {
    const load = () => setList(links.all());
    load();
    window.addEventListener("sealdesk:links", load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener("sealdesk:links", load);
      window.removeEventListener("storage", load);
    };
  }, []);
  return list;
}

export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}
