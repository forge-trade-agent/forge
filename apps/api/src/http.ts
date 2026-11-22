import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, lt } from "drizzle-orm";
import type { z } from "zod";
import { idempotencyKeys } from "@sealdesk/db";
import { AppError, ErrorCode, tokenMatches } from "@sealdesk/shared";
import type { Ctx } from "./context.ts";

/** Parse with a Zod schema; failures become a 400 with every problem listed. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      "Request validation failed",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

export function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) throw new AppError(ErrorCode.UNAUTHORIZED, "Missing capability token");
  return h.slice(7).trim();
}

export function requireToken(req: FastifyRequest, storedHash: Uint8Array): void {
  if (!tokenMatches(bearer(req), storedHash)) throw new AppError(ErrorCode.UNAUTHORIZED, "Invalid capability token");
}

export const b64 = (u: Uint8Array | null | undefined): string | null => (u ? Buffer.from(u).toString("base64") : null);
export const hex = (u: Uint8Array | null | undefined): `0x${string}` | null =>
  u ? (`0x${Buffer.from(u).toString("hex")}` as const) : null;
export const unhex = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function clientIp(req: FastifyRequest): string {
  return req.ip || "unknown";
}

/** Per-IP sliding-window limit for a named bucket. */
export async function limit(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, bucket: keyof Ctx["config"]["limits"]) {
  const { limit: max, windowMs } = ctx.config.limits[bucket];
  const r = await ctx.limiter.hit(`${bucket}:${clientIp(req)}`, max, windowMs);
  reply.header("ratelimit-limit", max);
  reply.header("ratelimit-remaining", r.remaining);
  reply.header("ratelimit-reset", Math.ceil(r.resetMs / 1000));
  if (!r.allowed) {
    reply.header("retry-after", Math.ceil(r.resetMs / 1000));
    throw new AppError(ErrorCode.RATE_LIMITED, "Too many requests");
  }
}

/**
 * Idempotency-Key handling for POST endpoints.
 * - First request with a key runs the handler and stores the response.
 * - A retry with the same key and same body replays the stored response.
 * - The same key with a different body is a 409.
 */
export async function idempotent<T>(
  ctx: Ctx,
  req: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  handler: () => Promise<{ status: number; body: T }>,
): Promise<T> {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8 || key.length > 128) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "Idempotency-Key header (8-128 chars) is required", [
      { path: "headers.idempotency-key", message: "required" },
    ]);
  }
  const requestHash = createHash("sha256").update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`).digest();
  const now = ctx.now();

  await ctx.db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key), lt(idempotencyKeys.expiresAt, now)));

  const inserted = await ctx.db
    .insert(idempotencyKeys)
    .values({ scope, key, requestHash, expiresAt: new Date(now.getTime() + 24 * 3600_000) })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });

  if (inserted.length === 0) {
    const [existing] = await ctx.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    if (!existing || !Buffer.from(existing.requestHash).equals(requestHash)) {
      throw new AppError(ErrorCode.IDEMPOTENCY_CONFLICT, "Idempotency-Key was already used with a different request");
    }
    if (existing.responseStatus === null) {
      throw new AppError(ErrorCode.IDEMPOTENCY_CONFLICT, "A request with this Idempotency-Key is still in progress");
    }
    reply.header("idempotent-replayed", "true");
    reply.status(existing.responseStatus);
    return existing.responseBody as T;
  }

  try {
    const { status, body } = await handler();
    await ctx.db
      .update(idempotencyKeys)
      .set({ responseStatus: status, responseBody: body as object })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    reply.status(status);
    return body;
  } catch (err) {
    // Failed requests release the key so the client can retry with the same key.
    await ctx.db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    throw err;
  }
}
