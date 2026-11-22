import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32 without padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

/** 128-bit random public id (26 chars). Not a secret. */
export function newId(): string {
  return base32(randomBytes(16));
}

/**
 * 256-bit capability token. Returned once to the client, stored only as SHA-256.
 * Format: "sd_" + base64url(32 bytes) so leaked tokens are easy to grep for.
 */
export function newCapabilityToken(): { token: string; hash: Buffer } {
  const token = `sd_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

const TOKEN_RE = /^sd_[A-Za-z0-9_-]{43}$/;
export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Constant-time comparison of a presented token against a stored hash. */
export function tokenMatches(token: string, storedHash: Uint8Array): boolean {
  if (!isWellFormedToken(token)) return false;
  const h = hashToken(token);
  return h.length === storedHash.length && timingSafeEqual(h, storedHash);
}
