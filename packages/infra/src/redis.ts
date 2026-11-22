/**
 * Redis-backed adapters. All multi-step operations are single Lua scripts (atomic).
 */
import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
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

type Call = (cmd: string, ...args: (string | number)[]) => Promise<unknown>;
const call = (r: Redis): Call => (cmd, ...args) => r.call(cmd, ...args.map(String));

// ---------------------------------------------------------------- rate limiter
const SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
local allowed = 0
if count < limit then
  redis.call('ZADD', key, now, member)
  count = count + 1
  allowed = 1
end
redis.call('PEXPIRE', key, window)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local reset = window
if oldest[2] then reset = tonumber(oldest[2]) + window - now end
return {allowed, limit - count, reset}
`;

export class RedisRateLimiter implements RateLimiter {
  private readonly call: Call;
  private readonly prefix: string;
  constructor(redis: Redis, prefix = "rl:") {
    this.call = call(redis);
    this.prefix = prefix;
  }
  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const member = `${Date.now()}-${randomBytes(6).toString("hex")}`;
    const [allowed, remaining, reset] = (await this.call(
      "EVAL", SLIDING_WINDOW, 1, this.prefix + key, Date.now(), windowMs, limit, member,
    )) as [number, number, number];
    return { allowed: allowed === 1, remaining: Math.max(0, remaining), resetMs: Math.max(0, reset) };
  }
}

// ---------------------------------------------------------------- event bus
// Stream entry ids are "<seq>-0" so clients can resume with a plain integer.
const PUBLISH = `
local seq = redis.call('INCR', KEYS[2])
redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[1], seq .. '-0', 'type', ARGV[2], 'data', ARGV[3], 'at', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return seq
`;

export class RedisEventBus implements EventBus {
  private readonly call: Call;
  /** Blocking reads need their own connection so they don't stall other commands. */
  private readonly blockingCall: Call;
  private readonly maxLen: number;
  private readonly ttlSeconds: number;
  constructor(redis: Redis, blocking: Redis, maxLen = 1000, ttlSeconds = 14 * 86_400) {
    this.call = call(redis);
    this.blockingCall = call(blocking);
    this.maxLen = maxLen;
    this.ttlSeconds = ttlSeconds;
  }
  async publish(channel: string, type: DeskEventType, data: Record<string, unknown>): Promise<number> {
    return Number(
      await this.call(
        "EVAL", PUBLISH, 2, `ev:${channel}`, `evseq:${channel}`,
        this.maxLen, type, JSON.stringify(data), new Date().toISOString(), this.ttlSeconds,
      ),
    );
  }
  async read(channel: string, afterSeq: number, blockMs: number): Promise<DeskEvent[]> {
    const args: (string | number)[] = ["COUNT", 100];
    if (blockMs > 0) args.push("BLOCK", blockMs);
    const res = (await this.blockingCall("XREAD", ...args, "STREAMS", `ev:${channel}`, `${afterSeq}-0`)) as
      | [string, [string, string[]][]][]
      | null;
    if (!res) return [];
    return res[0]![1].map(([id, fields]) => {
      const f: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
      return {
        seq: Number(id.split("-")[0]),
        type: f["type"] as DeskEventType,
        data: JSON.parse(f["data"] ?? "{}") as Record<string, unknown>,
        at: f["at"] ?? "",
      };
    });
  }
}

// ---------------------------------------------------------------- cache
export class RedisCache implements Cache {
  private readonly redis: Redis;
  private readonly prefix: string;
  constructor(redis: Redis, prefix = "c:") {
    this.redis = redis;
    this.prefix = prefix;
  }
  async get<T>(key: string): Promise<T | null> {
    const v = await this.redis.get(this.prefix + key);
    return v === null ? null : (JSON.parse(v) as T);
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.prefix + key, JSON.stringify(value), "EX", ttlSeconds);
  }
}

// ---------------------------------------------------------------- locks (single-instance Redlock)
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end
`;

export class RedisLocks implements Locks {
  private readonly call: Call;
  private readonly redis: Redis;
  private readonly prefix: string;
  constructor(redis: Redis, prefix = "lock:") {
    this.call = call(redis);
    this.redis = redis;
    this.prefix = prefix;
  }
  async acquire(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const token = randomBytes(16).toString("hex");
    const ok = await this.redis.set(this.prefix + key, token, "PX", ttlMs, "NX");
    if (ok !== "OK") return null;
    return async () => {
      await this.call("EVAL", RELEASE, 1, this.prefix + key, token);
    };
  }
}

// ---------------------------------------------------------------- relay queue
export class RedisRelayQueue implements RelayQueue {
  private readonly call: Call;
  private readonly blockingCall: Call;
  private groupReady = false;
  private readonly stream: string;
  private readonly group: string;
  private readonly reclaimIdleMs: number;
  constructor(redis: Redis, blocking: Redis, stream = "relay:requests", group = "relayers", reclaimIdleMs = 120_000) {
    this.call = call(redis);
    this.blockingCall = call(blocking);
    this.stream = stream;
    this.group = group;
    this.reclaimIdleMs = reclaimIdleMs;
  }

  private async ensureGroup() {
    if (this.groupReady) return;
    try {
      await this.call("XGROUP", "CREATE", this.stream, this.group, "0", "MKSTREAM");
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
    this.groupReady = true;
  }

  async enqueue(req: RelayRequest): Promise<void> {
    await this.ensureGroup();
    await this.call("XADD", this.stream, "MAXLEN", "~", 100_000, "*", "id", req.id, "body", JSON.stringify(req));
    await this.setStatus(req.id, { state: "queued", updatedAt: new Date().toISOString() });
  }

  async claim(consumer: string, blockMs: number): Promise<RelayRequest | null> {
    await this.ensureGroup();
    // First, take over anything a crashed consumer left pending for too long.
    const auto = (await this.call(
      "XAUTOCLAIM", this.stream, this.group, consumer, this.reclaimIdleMs, "0-0", "COUNT", 1,
    )) as [string, [string, string[]][] | null, unknown?];
    const reclaimed = auto?.[1]?.[0];
    if (reclaimed) return this.decode(reclaimed);

    const args: (string | number)[] = ["GROUP", this.group, consumer, "COUNT", 1];
    if (blockMs > 0) args.push("BLOCK", blockMs);
    const res = (await this.blockingCall("XREADGROUP", ...args, "STREAMS", this.stream, ">")) as
      | [string, [string, string[]][]][]
      | null;
    const entry = res?.[0]?.[1]?.[0];
    return entry ? this.decode(entry) : null;
  }

  private entryIds = new Map<string, string>();
  private decode([entryId, fields]: [string, string[]]): RelayRequest {
    const f: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
    const req = JSON.parse(f["body"]!) as RelayRequest;
    this.entryIds.set(req.id, entryId);
    return req;
  }

  async ack(id: string): Promise<void> {
    const entryId = this.entryIds.get(id);
    if (!entryId) return;
    await this.call("XACK", this.stream, this.group, entryId);
    await this.call("XDEL", this.stream, entryId);
    this.entryIds.delete(id);
  }

  async setStatus(id: string, status: RelayStatus): Promise<void> {
    await this.call("SET", `relay:status:${id}`, JSON.stringify(status), "EX", 7 * 86_400);
  }

  async getStatus(id: string): Promise<RelayStatus | null> {
    const v = (await this.call("GET", `relay:status:${id}`)) as string | null;
    return v ? (JSON.parse(v) as RelayStatus) : null;
  }
}
