/**
 * Server-side encryption at rest (notification destinations): XChaCha20-Poly1305 with a
 * 32-byte service key. Output = nonce(24) || ciphertext+tag. The column name is bound as AAD
 * so a value can't be moved to another column and still decrypt.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hexToBytes } from "@sealdesk/shared/bytes";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function keyFromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("key must be 32 bytes hex");
  return hexToBytes(hex);
}

export function encryptAtRest(key: Uint8Array, plaintext: string, aad: string): Uint8Array {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce, enc.encode(aad)).encrypt(enc.encode(plaintext));
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 24);
  return out;
}

export function decryptAtRest(key: Uint8Array, blob: Uint8Array, aad: string): string {
  if (blob.length < 24 + 16) throw new Error("ciphertext too short");
  return dec.decode(xchacha20poly1305(key, blob.subarray(0, 24), enc.encode(aad)).decrypt(blob.subarray(24)));
}
