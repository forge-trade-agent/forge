"use client";
/**
 * Private links saved in this browser only. The links themselves are the keys: whoever has one can
 * read the answers (rfq) or follow the deal (quote). Ghost-mode one-time wallet keys are stored with
 * their answer. Every access is wrapped: storage can be blocked or empty.
 */
import type { Hex } from "@sealdesk/sdk";

export interface SavedLink {
  kind: "rfq" | "quote";
  id: string;
  link: string;
  label?: string;
  side?: "buy" | "sell";
  /** Ghost mode: private key of the one-time wallet that signed this answer. */
  ghostKey?: Hex;
  createdAt: string;
}

const KEY = "sealdesk.links.v1";
const REF_KEY = "sealdesk.ref.v1";

function read(): SavedLink[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedLink[]) : [];
  } catch {
    return [];
  }
}

function write(list: SavedLink[]): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    window.dispatchEvent(new Event("sealdesk:links"));
    return true;
  } catch {
    return false;
  }
}

export const links = {
  all: read,
  save(l: SavedLink): boolean {
    return write([l, ...read().filter((x) => !(x.kind === l.kind && x.id === l.id))]);
  },
  get(kind: "rfq" | "quote", id: string) {
    return read().find((x) => x.kind === kind && x.id === id);
  },
  remove(kind: "rfq" | "quote", id: string) {
    return write(read().filter((x) => !(x.kind === kind && x.id === id)));
  },
  replaceAll(list: SavedLink[]) {
    return write(list);
  },
};

/** Referral: the latest ?ref= link a visitor opened wins. */
export const referral = {
  capture(search: string) {
    try {
      const r = new URLSearchParams(search).get("ref");
      if (r && /^0x[0-9a-fA-F]{40}$/.test(r)) window.localStorage.setItem(REF_KEY, r.toLowerCase());
    } catch {
      /* storage blocked */
    }
  },
  get(): Hex | null {
    try {
      return (window.localStorage.getItem(REF_KEY) as Hex | null) ?? null;
    } catch {
      return null;
    }
  },
};

/** Parse the URL fragment of a private link page: #k=<secret>&t=<token>. */
export function fragment(): { k: string | null; t: string | null } {
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return { k: p.get("k"), t: p.get("t") };
}
