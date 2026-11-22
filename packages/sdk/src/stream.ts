/**
 * Realtime events over SSE using fetch streaming (works in browsers and Node, and unlike
 * EventSource it can send the capability token in a header). Resumes from the last sequence
 * number after any disconnect, so no event is missed or repeated.
 */
export interface StreamEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export interface Subscription {
  close(): void;
  /** Last delivered sequence number (persist it to resume later). */
  readonly lastSeq: number;
}

export function subscribe(opts: {
  baseUrl: string;
  channel: string;
  token?: string;
  after?: number;
  onEvent: (e: StreamEvent) => void;
  onError?: (err: unknown) => void;
  fetch?: typeof fetch;
}): Subscription {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  let lastSeq = opts.after ?? 0;
  let backoff = 500;

  const run = async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await f(`${opts.baseUrl.replace(/\/$/, "")}/stream?channel=${encodeURIComponent(opts.channel)}`, {
          headers: {
            accept: "text/event-stream",
            "last-event-id": String(lastSeq),
            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          },
          signal: ctrl.signal,
        });
        if (res.status === 401 || res.status === 404) throw Object.assign(new Error(`stream refused: ${res.status}`), { fatal: true });
        if (!res.ok || !res.body) throw new Error(`stream http ${res.status}`);
        backoff = 500;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = parseFrame(frame);
            if (ev && ev.seq > lastSeq) {
              lastSeq = ev.seq;
              opts.onEvent(ev);
            }
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        opts.onError?.(err);
        if ((err as { fatal?: boolean }).fatal) return;
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
  void run();

  return {
    close: () => ctrl.abort(),
    get lastSeq() {
      return lastSeq;
    },
  };
}

export function parseFrame(frame: string): StreamEvent | null {
  let id: number | null = null;
  let type = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const [k, ...rest] = line.split(":");
    const v = rest.join(":").replace(/^ /, "");
    if (k === "id") id = Number(v);
    else if (k === "event") type = v;
    else if (k === "data") data.push(v);
  }
  if (id === null || !Number.isFinite(id) || data.length === 0) return null;
  try {
    return { seq: id, type, data: JSON.parse(data.join("\n")) as Record<string, unknown> };
  } catch {
    return null;
  }
}
