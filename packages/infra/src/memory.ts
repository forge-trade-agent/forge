/**
 * In-memory twins of the Redis adapters, with identical semantics.
 * Used by tests and by `DESK_INFRA=memory` single-process local development.
 */
import type {
  Cache,
  DeskEvent,
  DeskEventType,
  EventBus,
  Locks,
  RateLimiter,
  RateLimitResult,
  RelayQueue,
  RelayRequest,
  RelayStatus,
} from "@sealdesk/shared";

export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => x > t - windowMs);
    const allowed = list.length < limit;
    if (allowed) list.push(t);
    this.hits.set(key, list);
    return { allowed, remaining: Math.max(0, limit - list.length), resetMs: list.length ? list[0]! + windowMs - t : windowMs };
  }
}

export class MemoryEventBus implements EventBus {
  private channels = new Map<string, DeskEvent[]>();
  private waiters = new Map<string, Set<() => void>>();
  private readonly maxLen: number;
  constructor(maxLen = 1000) {
    this.maxLen = maxLen;
  }

  async publish(channel: string, type: DeskEventType, data: Record<string, unknown>): Promise<number> {
    const list = this.channels.get(channel) ?? [];
    const seq = (list.at(-1)?.seq ?? 0) + 1;
    list.push({ seq, type, data, at: new Date().toISOString() });
    if (list.length > this.maxLen) list.splice(0, list.length - this.maxLen);
    this.channels.set(channel, list);
    for (const w of this.waiters.get(channel) ?? []) w();
    return seq;
  }

  async read(channel: string, afterSeq: number, blockMs: number): Promise<DeskEvent[]> {
    const now = () => (this.channels.get(channel) ?? []).filter((e) => e.seq > afterSeq).slice(0, 100);
    const ready = now();
    if (ready.length || blockMs <= 0) return ready;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(channel) ?? new Set();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, blockMs);
      set.add(done);
      this.waiters.set(channel, set);
    });
    return now();
  }
}

export class MemoryCache implements Cache {
  private store = new Map<string, { v: string; exp: number }>();
  async get<T>(key: string): Promise<T | null> {
    const e = this.store.get(key);
    if (!e || e.exp < Date.now()) return null;
    return JSON.parse(e.v) as T;
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.store.set(key, { v: JSON.stringify(value), exp: Date.now() + ttlSeconds * 1000 });
  }
}

export class MemoryLocks implements Locks {
  private held = new Map<string, number>();
  async acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const exp = this.held.get(key);
    if (exp && exp > Date.now()) return null;
    const mine = Date.now() + ttlMs;
    this.held.set(key, mine);
    return async () => {
      if (this.held.get(key) === mine) this.held.delete(key);
    };
  }
}

export class MemoryRelayQueue implements RelayQueue {
  private queue: RelayRequest[] = [];
  private inflight = new Map<string, RelayRequest>();
  private statuses = new Map<string, RelayStatus>();
  async enqueue(req: RelayRequest): Promise<void> {
    this.queue.push(req);
    this.statuses.set(req.id, { state: "queued", updatedAt: new Date().toISOString() });
  }
  async claim(): Promise<RelayRequest | null> {
    const req = this.queue.shift() ?? null;
    if (req) this.inflight.set(req.id, req);
    return req;
  }
  async ack(id: string): Promise<void> {
    this.inflight.delete(id);
  }
  async setStatus(id: string, status: RelayStatus): Promise<void> {
    this.statuses.set(id, status);
  }
  async getStatus(id: string): Promise<RelayStatus | null> {
    return this.statuses.get(id) ?? null;
  }
  get pending(): number {
    return this.queue.length + this.inflight.size;
  }
}
