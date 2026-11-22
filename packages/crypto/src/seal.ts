/**
 * Sealed answers: X25519 + XSalsa20-Poly1305 (NaCl box) with an ephemeral sender key.
 * The recipient's secret key only ever lives in the private link's URL fragment / local storage.
 */
import nacl from "tweetnacl";
import { SealedAnswerPlaintext, type SealedQuoteCreate } from "@sealdesk/shared/schemas";
import { fromB64, fromB64Url, toB64, toB64Url } from "@sealdesk/shared/bytes";

export { fromB64, fromB64Url, toB64, toB64Url };

export const MAX_PLAINTEXT_BYTES = 4096 - nacl.box.overheadLength;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface SealedBox {
  senderEncPubKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });


export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== nacl.box.secretKeyLength) throw new Error("secret key must be 32 bytes");
  return nacl.box.keyPair.fromSecretKey(secretKey);
}

export function seal(plaintext: Uint8Array, recipientPublicKey: Uint8Array): SealedBox {
  if (recipientPublicKey.length !== nacl.box.publicKeyLength) throw new Error("recipient key must be 32 bytes");
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error("plaintext too large");
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(plaintext, nonce, recipientPublicKey, eph.secretKey);
  eph.secretKey.fill(0);
  return { senderEncPubKey: eph.publicKey, nonce, ciphertext };
}

/** Returns null on any authentication failure (tampered, wrong key, wrong nonce). */
export function open(box: SealedBox, recipientSecretKey: Uint8Array): Uint8Array | null {
  if (box.nonce.length !== nacl.box.nonceLength || box.senderEncPubKey.length !== nacl.box.publicKeyLength) {
    return null;
  }
  return nacl.box.open(box.ciphertext, box.nonce, box.senderEncPubKey, recipientSecretKey);
}

/** Seal a structured answer and return the exact body for POST /rfqs/{id}/quotes. */
export function sealAnswer(answer: SealedAnswerPlaintext, recipientPublicKey: Uint8Array): SealedQuoteCreate {
  const parsed = SealedAnswerPlaintext.parse(answer);
  const box = seal(enc.encode(JSON.stringify(parsed)), recipientPublicKey);
  return { senderEncPubKey: toB64(box.senderEncPubKey), nonce: toB64(box.nonce), ciphertext: toB64(box.ciphertext) };
}

export type OpenedAnswer =
  | { ok: true; answer: SealedAnswerPlaintext }
  | { ok: false; reason: "decrypt_failed" | "not_utf8" | "not_json" | "invalid_shape"; detail?: string };

/** Decrypt and strictly validate a sealed answer. Everything inside is attacker-controlled. */
export function openAnswer(wire: SealedQuoteCreate, recipientSecretKey: Uint8Array): OpenedAnswer {
  const plain = open(
    { senderEncPubKey: fromB64(wire.senderEncPubKey), nonce: fromB64(wire.nonce), ciphertext: fromB64(wire.ciphertext) },
    recipientSecretKey,
  );
  if (!plain) return { ok: false, reason: "decrypt_failed" };
  let text: string;
  try {
    text = dec.decode(plain);
  } catch {
    return { ok: false, reason: "not_utf8" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const parsed = SealedAnswerPlaintext.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_shape", detail: parsed.error.issues.map((i) => i.path.join(".")).join(",") };
  }
  return { ok: true, answer: parsed.data };
}

/** Private link: /rfq/<id>#k=<base64url secret>&t=<capability token>. Fragment never reaches servers. */
export function buildPrivateLink(origin: string, kind: "rfq" | "quote", id: string, secretKey: Uint8Array | null, token: string): string {
  const params = new URLSearchParams();
  if (secretKey) params.set("k", toB64Url(secretKey));
  params.set("t", token);
  return `${origin.replace(/\/$/, "")}/${kind}/${encodeURIComponent(id)}#${params.toString()}`;
}

export function parsePrivateLink(link: string): { kind: "rfq" | "quote"; id: string; secretKey: Uint8Array | null; token: string } {
  const url = new URL(link);
  const m = /^\/(rfq|quote)\/([^/]+)$/.exec(url.pathname);
  if (!m) throw new Error("not a private link");
  const frag = new URLSearchParams(url.hash.replace(/^#/, ""));
  const token = frag.get("t");
  if (!token) throw new Error("private link has no token");
  const k = frag.get("k");
  const secretKey = k ? fromB64Url(k) : null;
  if (secretKey && secretKey.length !== 32) throw new Error("private link key must be 32 bytes");
  return { kind: m[1] as "rfq" | "quote", id: decodeURIComponent(m[2]!), secretKey, token };
}
