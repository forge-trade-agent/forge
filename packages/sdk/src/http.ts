/** Minimal, typed HTTP layer: error envelope, idempotency keys, retries for safe cases. */
import type { ErrorCode } from "@sealdesk/shared/errors";

export class ForgeError extends Error {
  readonly code: ErrorCode | "NETWORK";
  readonly status: number;
  readonly requestId: string | undefined;
  readonly problems: { path: string; message: string }[] | undefined;
  constructor(
    code: ErrorCode | "NETWORK",
    message: string,
    status: number,
    requestId?: string,
    problems?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ForgeError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.problems = problems;
  }
}

export interface HttpOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Attempts for network errors and 5xx on GETs and idempotent POSTs (default 3). */
  retries?: number;
  timeoutMs?: number;
}

export function newIdempotencyKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `sdk-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export class Http {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;

  constructor(o: HttpOptions) {
    this.base = o.baseUrl.replace(/\/$/, "");
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.retries = o.retries ?? 3;
    this.timeoutMs = o.timeoutMs ?? 20_000;
  }

  url(path: string): string {
    return this.base + path;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { body?: unknown; token?: string; idempotent?: boolean; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const qs = opts.query
      ? "?" + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined).map(([k, v]): [string, string] => [k, String(v)])).toString()
      : "";
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    // The same key is reused across retries so a retried create can never run twice.
    if (opts.idempotent) headers["idempotency-key"] = newIdempotencyKey();
    const canRetry = method === "GET" || opts.idempotent === true;

    let lastErr: unknown;
    for (let attempt = 0; attempt < (canRetry ? this.retries : 1); attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      let res: Response;
      try {
        res = await this.f(this.url(path) + qs, {
          method,
          headers,
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastErr = new ForgeError("NETWORK", (err as Error).message, 0);
        continue;
      }
      const text = await res.text();
      const json = text ? (JSON.parse(text) as unknown) : null;
      if (res.ok) return json as T;
      const e = (json as { error?: { code: ErrorCode; message: string; requestId?: string; problems?: { path: string; message: string }[] } })?.error;
      const err = new ForgeError(e?.code ?? "INTERNAL", e?.message ?? res.statusText, res.status, e?.requestId, e?.problems);
      if (res.status >= 500 && canRetry) {
        lastErr = err;
        continue;
      }
      throw err;
    }
    throw lastErr;
  }
}
