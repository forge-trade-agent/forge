import type { AnyDb } from "@sealdesk/db";
import type { Cache, ChainReader, EventBus, Hex, Logger, RateLimiter, RelayQueue } from "@sealdesk/shared";

export interface DeskConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  escrow: Hex;
  vault: Hex;
  stable: Hex;
  platformToken: Hex;
  /** Public address of the Ghost-mode relayer; null disables /relay/deposit. */
  relayer: Hex | null;
  relayerMinFeeBps: number;
  /** 32-byte key for encrypting notification destinations at rest. */
  notifyKey: Uint8Array;
  /** Alert channels the worker can deliver; defaults to all three. */
  notify?: { channels: ("telegram" | "email" | "webhook")[]; telegramBot: string | null };
  /** SHA-256 of the operator token for /admin routes; null or absent turns /admin off. */
  adminTokenHash?: Uint8Array | null;
  publicUrl: string;
  corsOrigins: string[];
  version: string;
  /** Per-IP limits. */
  limits: {
    global: { limit: number; windowMs: number };
    createRfq: { limit: number; windowMs: number };
    createQuote: { limit: number; windowMs: number };
    relay: { limit: number; windowMs: number };
  };
}

export const DEFAULT_LIMITS: DeskConfig["limits"] = {
  global: { limit: 600, windowMs: 60_000 },
  createRfq: { limit: 20, windowMs: 10 * 60_000 },
  createQuote: { limit: 60, windowMs: 10 * 60_000 },
  relay: { limit: 30, windowMs: 10 * 60_000 },
};

export interface Ctx {
  db: AnyDb;
  chain: ChainReader;
  bus: EventBus;
  limiter: RateLimiter;
  cache: Cache;
  relay: RelayQueue;
  log: Logger;
  config: DeskConfig;
  checks: { db: () => Promise<boolean>; redis: () => Promise<boolean> };
  now: () => Date;
}
