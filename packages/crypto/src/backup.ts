/**
 * Export / import of private links: passphrase -> Argon2id -> XChaCha20-Poly1305.
 * The file holds the keys to every block, so it is encrypted even at rest on the user's disk.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { z } from "zod";
import { fromB64, toB64 } from "@sealdesk/shared/bytes";

export const BackupEntry = z.object({
  kind: z.enum(["rfq", "quote"]),
  id: z.string().min(1).max(64),
  link: z.url(),
  label: z.string().max(120).optional(),
  side: z.enum(["buy", "sell"]).optional(),
  /** Ghost mode: one-time wallet key that signed this answer. */
  ghostKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  createdAt: z.iso.datetime(),
});
export type BackupEntry = z.infer<typeof BackupEntry>;

const BackupFile = z.object({
  format: z.literal("sealdesk-backup"),
  v: z.literal(1),
  kdf: z.object({
    alg: z.literal("argon2id"),
    t: z.number().int().min(1).max(10),
    m: z.number().int().min(8).max(1 << 21),
    p: z.number().int().min(1).max(4),
    salt: z.string(),
  }),
  nonce: z.string(),
  ciphertext: z.string(),
});
export type BackupFile = z.infer<typeof BackupFile>;

/** RFC 9106 second recommended option: t=3, m=64 MiB, p=1. */
export const DEFAULT_KDF = { t: 3, m: 65_536, p: 1 } as const;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = toB64;
const unb64 = fromB64;

export async function encryptBackup(
  entries: BackupEntry[],
  passphrase: string,
  kdf: { t: number; m: number; p: number } = DEFAULT_KDF,
): Promise<BackupFile> {
  if (passphrase.length < 12) throw new Error("passphrase must be at least 12 characters");
  const body = z.array(BackupEntry).parse(entries);
  const salt = randomBytes(16);
  const key = await argon2idAsync(enc.encode(passphrase), salt, { ...kdf, dkLen: 32 });
  const nonce = randomBytes(24);
  const header = enc.encode(`sealdesk-backup:v1:${kdf.t}:${kdf.m}:${kdf.p}`);
  const ciphertext = xchacha20poly1305(key, nonce, header).encrypt(enc.encode(JSON.stringify(body)));
  key.fill(0);
  return {
    format: "sealdesk-backup",
    v: 1,
    kdf: { alg: "argon2id", ...kdf, salt: b64(salt) },
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
  };
}

export async function decryptBackup(file: unknown, passphrase: string): Promise<BackupEntry[]> {
  const f = BackupFile.parse(file);
  const key = await argon2idAsync(enc.encode(passphrase), unb64(f.kdf.salt), {
    t: f.kdf.t,
    m: f.kdf.m,
    p: f.kdf.p,
    dkLen: 32,
  });
  const header = enc.encode(`sealdesk-backup:v1:${f.kdf.t}:${f.kdf.m}:${f.kdf.p}`);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(key, unb64(f.nonce), header).decrypt(unb64(f.ciphertext));
  } catch {
    throw new Error("wrong passphrase or corrupted backup");
  } finally {
    key.fill(0);
  }
  return z.array(BackupEntry).parse(JSON.parse(dec.decode(plain)));
}
