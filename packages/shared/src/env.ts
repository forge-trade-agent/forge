import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address")
  .transform((s) => s.toLowerCase() as `0x${string}`);

const hex32Key = z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 32 bytes of hex");

const csvUrls = z
  .string()
  .transform((s) => s.split(",").map((u) => u.trim()).filter(Boolean))
  .pipe(z.array(z.url()).min(1));

const csv = z.string().transform((s) => s.split(",").map((u) => u.trim()).filter(Boolean));

const common = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  CHAIN_NAME: z.string().min(1).default("Robinhood Chain"),
  RPC_URLS: csvUrls,
  EXPLORER_URL: z.url().optional(),
  ESCROW_ADDRESS: address,
  VAULT_ADDRESS: address,
  STABLE_ADDRESS: address,
  PLATFORM_TOKEN_ADDRESS: address,
  ESCROW_DEPLOY_BLOCK: z.coerce.bigint().nonnegative().default(0n),
  STABLE_DECIMALS: z.coerce.number().int().min(0).max(36).default(6),
});

const api = common.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  API_PUBLIC_URL: z.url(),
  CORS_ORIGINS: csv.default([]),
  NOTIFY_ENCRYPTION_KEY: hex32Key,
  /** Public address of the Ghost-mode relayer (its key lives only in the relayer service). */
  RELAYER_ADDRESS: address.optional(),
  RELAYER_MIN_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(10),
  /** Alert channels the worker can deliver (match TELEGRAM_BOT_TOKEN / SMTP_URL on the worker). */
  NOTIFY_CHANNELS: csv.pipe(z.array(z.enum(["telegram", "email", "webhook"]))).default(["webhook"]),
  /** Public @username of the alerts bot, shown so people can start a chat with it. */
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).optional(),
  /** Operator token for /admin (posting the token CA). Unset = admin routes off. Use 32+ random chars. */
  ADMIN_TOKEN: z.string().min(24).optional(),
});

const indexer = common.extend({
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).max(1000).default(12),
  INDEXER_BATCH_BLOCKS: z.coerce.number().int().min(1).max(50_000).default(2000),
  INDEXER_POLL_MS: z.coerce.number().int().min(250).default(2000),
});

const relayer = common.extend({
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key"),
  RELAYER_MIN_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(10),
  RELAYER_MAX_GAS_GWEI: z.coerce.number().positive().default(50),
});

const worker = common.extend({
  NOTIFY_ENCRYPTION_KEY: hex32Key,
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  SMTP_URL: z.string().optional(),
  /** DexScreener chain slug for reference DEX prices. */
  DEXSCREENER_CHAIN: z.string().regex(/^[a-z0-9-]+$/).default("robinhood"),
  /** Optional: enables delayed reference candles of the underlying listings. */
  ALPHAVANTAGE_API_KEY: z.string().optional(),
  /** Public address of the Ghost-mode relayer, shown with its gas balance on the Security page. */
  RELAYER_ADDRESS: address.optional(),
});

export const envSchemas = { api, indexer, relayer, worker } as const;
export type ServiceName = keyof typeof envSchemas;
export type Env<S extends ServiceName> = z.infer<(typeof envSchemas)[S]>;

/** Parse and validate env for a service. Fails fast with every problem listed (secrets never echoed). */
export function loadEnv<S extends ServiceName>(service: S, source: NodeJS.ProcessEnv = process.env): Env<S> {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = envSchemas[service].safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment for ${service}:\n${lines.join("\n")}`);
  }
  return parsed.data as Env<S>;
}
