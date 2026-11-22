/**
 * Wire schemas shared by the API (validation + OpenAPI), SDK and MCP server.
 * All on-chain amounts travel as decimal strings of base units.
 */
import { z } from "zod";
import { b64Length } from "./bytes.ts";

export const MAX_UINT256 = (1n << 256n) - 1n;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "invalid address")
  .transform((s) => s.toLowerCase() as `0x${string}`);

export const Hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 32 bytes hex")
  .transform((s) => s.toLowerCase() as `0x${string}`);

const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;
/** Zod 4 keeps running refinements after a failed regex, so never call BigInt on unchecked input. */
const toBig = (s: string): bigint | null => (UINT_RE.test(s) ? BigInt(s) : null);

export const Uint256 = z
  .string()
  .regex(UINT_RE, "expected a base-10 integer string")
  .refine((s) => {
    const n = toBig(s);
    return n === null || n <= MAX_UINT256;
  }, "exceeds uint256");

export const PositiveUint256 = Uint256.refine((s) => {
  const n = toBig(s);
  return n === null || n > 0n;
}, "must be > 0");

/** base64 (standard or url-safe) of an exact number of bytes. */
export const b64Bytes = (len: number | { min: number; max: number }) =>
  z
    .string()
    .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, "expected base64")
    .refine((s) => {
      const n = b64Length(s);
      return typeof len === "number" ? n === len : n >= len.min && n <= len.max;
    }, typeof len === "number" ? `expected ${len} bytes` : `expected ${len.min}-${len.max} bytes`);

export const Side = z.enum(["buy", "sell"]);
export const ReplyWindow = z.enum(["15m", "1h", "4h", "6h", "24h"]);
export const replyWindowSeconds: Record<z.infer<typeof ReplyWindow>, number> = {
  "15m": 900,
  "1h": 3600,
  "4h": 14_400,
  "6h": 21_600,
  "24h": 86_400,
};

export const RfqCreate = z.object({
  side: Side,
  token: Address,
  payToken: Address,
  amount: PositiveUint256,
  sizeUsd: z.string().regex(/^\d{1,15}(\.\d{1,6})?$/).optional(),
  note: z.string().trim().max(280).optional(),
  encPubKey: b64Bytes(32),
  replyWindow: ReplyWindow,
  allowPartial: z.boolean().default(false),
});
export type RfqCreate = z.infer<typeof RfqCreate>;

export const RfqPublic = z.object({
  id: z.string(),
  side: Side,
  token: Address,
  payToken: Address,
  amount: Uint256,
  filledAmount: Uint256,
  sizeUsd: z.string().nullable(),
  note: z.string().nullable(),
  encPubKey: z.string(),
  allowPartial: z.boolean(),
  status: z.enum(["open", "filled", "cancelled", "expired"]),
  quoteCount: z.number().int(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type RfqPublic = z.infer<typeof RfqPublic>;

export const SealedQuoteCreate = z.object({
  senderEncPubKey: b64Bytes(32),
  nonce: b64Bytes(24),
  ciphertext: b64Bytes({ min: 16, max: 4096 }),
});
export type SealedQuoteCreate = z.infer<typeof SealedQuoteCreate>;

/** Mirrors OtcEscrow.Terms field-for-field. */
export const Terms = z.object({
  buyer: Address,
  seller: Address,
  token: Address,
  amount: PositiveUint256,
  payToken: Address,
  price: PositiveUint256,
  sellerPayout: Address,
  referrer: Address,
  relayerFee: Uint256,
  deadline: z.number().int().positive(),
  salt: Hex32,
});
export type Terms = z.infer<typeof Terms>;

export const AcceptBody = z.object({
  quoteId: z.string().min(1).max(64),
  terms: Terms,
});
export type AcceptBody = z.infer<typeof AcceptBody>;

/** Plaintext of a sealed answer, after decryption in the poster's browser. Treat as hostile. */
export const SealedAnswerPlaintext = z.object({
  v: z.literal(1),
  rfqId: z.string(),
  terms: Terms,
  /** EIP-712 signature by terms.seller (bids) or terms.buyer (listings) over the Terms. */
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional(),
  note: z.string().max(280).optional(),
});
export type SealedAnswerPlaintext = z.infer<typeof SealedAnswerPlaintext>;

export const SettledReport = z.object({ txHash: Hex32 });
