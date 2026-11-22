/**
 * Server-Sent Events gateway.
 *   GET /stream?channel=desk              public feed of new postings
 *   GET /stream?channel=rfq:<id>          answers, accepts, settlements on my posting (manage token)
 *   GET /stream?channel=quote:<id>        accept/settle on my answer (quote token)
 * Every event carries a per-channel sequence number as the SSE id; reconnect with
 * Last-Event-ID (or ?after=) to resume without gaps. Heartbeats every 15s.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { quotes, rfqs } from "@sealdesk/db";
import { AppError, ErrorCode } from "@sealdesk/shared";
import type { Ctx } from "../context.ts";
import { parse, requireToken } from "../http.ts";

const Query = z.object({
  channel: z.string().regex(/^(desk|rfq:[0-9A-Z]{26}|quote:[0-9A-Z]{26})$/),
  after: z.coerce.number().int().min(0).optional(),
});

const HEARTBEAT_MS = 15_000;
const DRAIN_TIMEOUT_MS = 10_000;

export function streamRoutes(app: FastifyInstance, ctx: Ctx, opts: { heartbeatMs?: number } = {}) {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;

  app.get("/stream", async (req, reply) => {
    const q = parse(Query, req.query);
    const [kind, id] = q.channel.split(":") as [string, string | undefined];
    if (kind === "rfq") {
      const [r] = await ctx.db.select({ h: rfqs.manageTokenHash }).from(rfqs).where(eq(rfqs.id, id!));
      if (!r) throw new AppError(ErrorCode.RFQ_NOT_FOUND, "No such posting");
      requireToken(req, r.h);
    } else if (kind === "quote") {
      const [qq] = await ctx.db.select({ h: quotes.quoteTokenHash }).from(quotes).where(eq(quotes.id, id!));
      if (!qq) throw new AppError(ErrorCode.QUOTE_NOT_FOUND, "No such answer");
      requireToken(req, qq.h);
    }

    const lastEventId = Number(req.headers["last-event-id"]);
    let seq = Number.isFinite(lastEventId) && lastEventId >= 0 ? lastEventId : (q.after ?? 0);

    reply.hijack();
    const raw = reply.raw;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = String(v);
    raw.writeHead(200, {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let open = true;
    req.raw.on("close", () => {
      open = false;
    });

    const write = async (chunk: string): Promise<boolean> => {
      if (!open) return false;
      if (raw.write(chunk)) return true;
      // Backpressure: wait for drain, drop slow consumers.
      const drained = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS);
        raw.once("drain", () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      if (!drained) open = false;
      return drained;
    };

    await write(`retry: 3000\n: connected ${q.channel} after ${seq}\n\n`);
    while (open) {
      let events;
      try {
        events = await ctx.bus.read(q.channel, seq, heartbeatMs);
      } catch (err) {
        req.log.warn({ err }, "event bus read failed");
        break;
      }
      if (!open) break;
      if (events.length === 0) {
        if (!(await write(`: ping ${Date.now()}\n\n`))) break;
        continue;
      }
      for (const e of events) {
        if (!(await write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`))) break;
        seq = e.seq;
      }
    }
    raw.end();
  });
}
