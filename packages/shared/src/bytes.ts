/** Byte encodings that work identically in browsers and Node (no Buffer). */

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Accepts standard or URL-safe base64, with or without padding. Throws on invalid input. */
export function fromB64(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "===".slice((std.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const toB64Url = (b: Uint8Array): string => toB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64Url = fromB64;

/** Decoded length of base64 without allocating; -1 if malformed. */
export function b64Length(s: string): number {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) return -1;
  const body = s.replace(/=+$/, "");
  if (body.length % 4 === 1) return -1;
  return Math.floor((body.length * 3) / 4);
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
