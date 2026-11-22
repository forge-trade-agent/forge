/**
 * Ports: the narrow interfaces services depend on. Implementations live in @sealdesk/infra
 * (Redis, viem) and have in-memory twins for tests and local development.
 */
import type { Terms } from "./schemas.ts";

export type Hex = `0x${string}`;

// ---------------------------------------------------------------- rate limiting
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}
export interface RateLimiter {
  /** Sliding window: at most `limit` hits per `windowMs` for `key`. */
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

// ---------------------------------------------------------------- realtime events
export interface DeskEvent {
  seq: number;
  type: DeskEventType;
  data: Record<string, unknown>;
  at: string;
}
export type DeskEventType =
  | "answer.received"
  | "deal.accepted"
  | "payment.locked"
  | "deal.settled"
  | "deal.refunded"
  | "deadline.near"
  | "rfq.closed"
  | "relay.updated"
  | "rfq.created"
  | "notify.test";

export interface EventBus {
  /** Append to a channel; returns the event's sequence number (1, 2, 3, ... per channel). */
  publish(channel: string, type: DeskEventType, data: Record<string, unknown>): Promise<number>;
  /** Events with seq > afterSeq, waiting up to blockMs for the first one. */
  read(channel: string, afterSeq: number, blockMs: number): Promise<DeskEvent[]>;
}

// ---------------------------------------------------------------- cache
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

// ---------------------------------------------------------------- locks
export interface Locks {
  /** Returns a release function, or null if the lock is held elsewhere. */
  acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
}

// ---------------------------------------------------------------- relay queue
export interface PermitWire {
  value: string;
  deadline: string;
  v: number;
  r: Hex;
  s: Hex;
}
export interface RelayRequest {
  id: string;
  dealId: Hex;
  terms: Terms;
  permit: PermitWire | null;
  authDeadline: string;
  signature: Hex;
  receivedAt: string;
}
export type RelayState = "queued" | "submitted" | "mined" | "failed";
export interface RelayStatus {
  state: RelayState;
  txHash?: Hex;
  error?: string;
  updatedAt: string;
}
export interface RelayQueue {
  enqueue(req: RelayRequest): Promise<void>;
  /** Next request for this consumer (including ones abandoned by crashed consumers), or null. */
  claim(consumer: string, blockMs: number): Promise<RelayRequest | null>;
  ack(id: string): Promise<void>;
  setStatus(id: string, status: RelayStatus): Promise<void>;
  getStatus(id: string): Promise<RelayStatus | null>;
}

// ---------------------------------------------------------------- chain
export interface TokenFacts {
  address: Hex;
  hasCode: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  permit: boolean;
}

export type OnChainDealStatus = "none" | "payment_locked" | "settled" | "refunded";

export interface SettlementProof {
  txHash: Hex;
  blockNumber: bigint;
  timestamp: number;
  escrow: Hex;
  dealId: Hex;
  buyer: Hex;
  seller: Hex;
  token: Hex;
  amount: bigint;
  payToken: Hex;
  price: bigint;
  fee: bigint;
  referrerFee: bigint;
  relayerFee: bigint;
  relayer: Hex;
}

export interface ChainReader {
  readonly chainId: number;
  readonly escrow: Hex;
  tokenFacts(address: Hex): Promise<TokenFacts>;
  dealStatus(dealId: Hex): Promise<OnChainDealStatus>;
  /** Parses a mined, successful tx for an OtcEscrow Settled event. null if not a settlement. */
  settlementFromTx(txHash: Hex): Promise<SettlementProof | null>;
  balanceOf(token: Hex, owner: Hex): Promise<bigint>;
}
