"use client";
/**
 * The token contract address (CA) the operator posts from /admin. Shown in the announcement bar,
 * the footer and the token strip. Nothing is shown until one is posted.
 */
import { useEffect } from "react";
import type { SiteCa } from "@sealdesk/sdk";
import { api } from "@/lib/desk";
import { useAsync } from "@/lib/hooks";

export const CA_EVENT = "forge:ca";

export function useSiteCa(): { ca: SiteCa | null; loading: boolean } {
  const { data, loading, reload } = useAsync(() => api.site().catch(() => ({ ca: null })), []);
  useEffect(() => {
    window.addEventListener(CA_EVENT, reload);
    return () => window.removeEventListener(CA_EVENT, reload);
  }, [reload]);
  return { ca: data?.ca ?? null, loading };
}

export function shortCa(a: string, n = 6): string {
  return a.length > n * 2 + 3 ? `${a.slice(0, n + (a.startsWith("0x") ? 2 : 0))}…${a.slice(-n)}` : a;
}
