/**
 * Opt-in Telegram / email / webhook alerts, bound to a capability (posting or answer),
 * never to an identity. Destinations are encrypted at rest and never returned.
 */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { notificationSubscriptions, quotes, rfqs } from "@sealdesk/db";
import { encryptAtRest } from "@sealdesk/crypto";
import { AppError, ErrorCode, hashToken, NOTIFY_CHANNEL } from "@sealdesk/shared";
import type { Ctx } from "../context.ts";
import { bearer, parse, requireToken } from "../http.ts";

const Capability = z.object({ kind: z.enum(["rfq", "quote"]), id: z.string().regex(/^[0-9A-Z]{26}$/) });
const Channel = z.enum(["telegram", "email", "webhook"]);

export const Subscribe = z.discriminatedUnion("channel", [
  z.object({ capability: Capability, channel: z.literal("telegram"), destination: z.string().regex(/^-?\d{1,20}$/, "Telegram chat id") }),
  z.object({ capability: Capability, channel: z.literal("email"), destination: z.email().max(254) }),
  z.object({
    capability: Capability,
    channel: z.literal("webhook"),
    destination: z.url({ protocol: /^https$/ }).max(2048),
  }),
]);

/** Authenticates the bearer token against the posting/answer and returns the capability hash. */
async function capabilityHash(ctx: Ctx, req: Parameters<typeof bearer>[0], cap: z.infer<typeof Capability>): Promise<Buffer> {
  if (cap.kind === "rfq") {
    const [r] = await ctx.db.select({ h: rfqs.manageTokenHash }).from(rfqs).where(eq(rfqs.id, cap.id));
    if (!r) throw new AppError(ErrorCode.RFQ_NOT_FOUND, "No such posting");
    requireToken(req, r.h);
  } else {
    const [q] = await ctx.db.select({ h: quotes.quoteTokenHash }).from(quotes).where(eq(quotes.id, cap.id));
    if (!q) throw new AppError(ErrorCode.QUOTE_NOT_FOUND, "No such answer");
    requireToken(req, q.h);
  }
  return hashToken(bearer(req));
}

const ALL_CHANNELS = ["telegram", "email", "webhook"] as const;
const enabled = (ctx: Ctx) => ctx.config.notify?.channels ?? ALL_CHANNELS;

export function notificationRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post("/notifications", async (req, reply) => {
    const body = parse(Subscribe, req.body);
    if (!enabled(ctx).includes(body.channel)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, `${body.channel} alerts are not enabled on this desk`);
    }
    const h = await capabilityHash(ctx, req, body.capability);
    const destinationEnc = encryptAtRest(ctx.config.notifyKey, body.destination, `notify:${body.channel}`);
    await ctx.db
      .insert(notificationSubscriptions)
      .values({ capabilityHash: h, channel: body.channel, destinationEnc: Buffer.from(destinationEnc) })
      .onConflictDoUpdate({
        target: [notificationSubscriptions.capabilityHash, notificationSubscriptions.channel],
        set: { destinationEnc: Buffer.from(destinationEnc), verifiedAt: null },
      });
    reply.status(201);
    return { subscribed: body.channel };
  });

  app.post("/notifications/remove", async (req) => {
    const body = parse(z.object({ capability: Capability, channel: Channel }), req.body);
    const h = await capabilityHash(ctx, req, body.capability);
    await ctx.db
      .delete(notificationSubscriptions)
      .where(and(eq(notificationSubscriptions.capabilityHash, h), eq(notificationSubscriptions.channel, body.channel)));
    return { removed: body.channel };
  });

  app.get("/notifications", async (req) => {
    const cap = parse(Capability, req.query);
    const h = await capabilityHash(ctx, req, cap);
    const rows = await ctx.db
      .select({ channel: notificationSubscriptions.channel, createdAt: notificationSubscriptions.createdAt })
      .from(notificationSubscriptions)
      .where(eq(notificationSubscriptions.capabilityHash, h));
    return { items: rows.map((r) => ({ channel: r.channel, createdAt: r.createdAt.toISOString() })) };
  });

  /** Sends one test alert to every channel on this block. At most 3 per block per 10 minutes. */
  app.post("/notifications/test", async (req) => {
    const body = parse(z.object({ capability: Capability }), req.body);
    const h = await capabilityHash(ctx, req, body.capability);
    const rows = await ctx.db
      .select({ channel: notificationSubscriptions.channel })
      .from(notificationSubscriptions)
      .where(eq(notificationSubscriptions.capabilityHash, h));
    if (rows.length === 0) throw new AppError(ErrorCode.VALIDATION_FAILED, "Add a channel first");
    const r = await ctx.limiter.hit(`notify-test:${h.toString("hex")}`, 3, 10 * 60_000);
    if (!r.allowed) throw new AppError(ErrorCode.RATE_LIMITED, "Test alerts are limited to 3 every 10 minutes");
    await ctx.bus.publish(NOTIFY_CHANNEL, "notify.test", { channel: `${body.capability.kind}:${body.capability.id}` });
    return { queued: rows.map((x) => x.channel) };
  });
}
