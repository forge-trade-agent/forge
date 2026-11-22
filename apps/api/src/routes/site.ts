/**
 * Site settings the operator sets from /admin. Today: the token's contract address (CA) shown in
 * the announcement bar. Reads are public; writes need the operator token (ADMIN_TOKEN).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { siteSettings } from "@sealdesk/db";
import { timingSafeEqual } from "node:crypto";
import { AppError, ErrorCode, hashToken } from "@sealdesk/shared";
import type { Ctx } from "../context.ts";
import { bearer, clientIp, parse } from "../http.ts";

const EVM = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const CaInput = z.object({
  address: z.string().trim().refine((a) => EVM.test(a) || BASE58.test(a), "Paste an EVM (0x…) or Solana address"),
  /** Where the token lives, shown next to the CA (e.g. "Robinhood Chain", "Solana"). */
  network: z.string().trim().max(40).optional(),
  /** Optional link (chart or swap page) opened from the bar. */
  link: z.url({ protocol: /^https$/ }).max(512).optional(),
});
export type Ca = z.infer<typeof CaInput> & { updatedAt: string };

const KEY_CA = "token_ca";
/** Wrong-token attempts allowed per IP per 15 minutes. */
const FAILS = 8;
const FAIL_WINDOW = 15 * 60_000;

async function requireAdmin(ctx: Ctx, req: FastifyRequest): Promise<void> {
  const h = ctx.config.adminTokenHash;
  if (!h) throw new AppError(ErrorCode.NOT_FOUND, "Admin is not enabled on this desk");
  const key = `admin-fail:${clientIp(req)}`;
  const token = bearer(req);
  const got = hashToken(token);
  if (got.length === h.length && timingSafeEqual(got, h)) return;
  const r = await ctx.limiter.hit(key, FAILS, FAIL_WINDOW);
  if (!r.allowed) throw new AppError(ErrorCode.RATE_LIMITED, "Too many wrong tokens. Try again in 15 minutes");
  throw new AppError(ErrorCode.UNAUTHORIZED, "Wrong admin token");
}

async function readCa(ctx: Ctx): Promise<Ca | null> {
  const [row] = await ctx.db.select().from(siteSettings).where(eq(siteSettings.key, KEY_CA));
  if (!row) return null;
  return { ...(row.value as z.infer<typeof CaInput>), updatedAt: row.updatedAt.toISOString() };
}

export function siteRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/site", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=15");
    return { ca: await readCa(ctx) };
  });

  /** Lets the admin page check a token before showing the form. */
  app.get("/admin/session", async (req) => {
    await requireAdmin(ctx, req);
    return { ok: true };
  });

  app.put("/admin/ca", async (req) => {
    await requireAdmin(ctx, req);
    const body = parse(CaInput, req.body);
    const value = { address: body.address, ...(body.network ? { network: body.network } : {}), ...(body.link ? { link: body.link } : {}) };
    const now = ctx.now();
    await ctx.db
      .insert(siteSettings)
      .values({ key: KEY_CA, value, updatedAt: now })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: now } });
    ctx.log.info({ address: body.address }, "token CA updated");
    return { ca: await readCa(ctx) };
  });

  app.delete("/admin/ca", async (req) => {
    await requireAdmin(ctx, req);
    await ctx.db.delete(siteSettings).where(eq(siteSettings.key, KEY_CA));
    ctx.log.info("token CA cleared");
    return { ca: null };
  });
}
