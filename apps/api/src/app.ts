import Fastify, { type FastifyBaseLogger } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { ZodError } from "zod";
import { AppError, ErrorCode, newId } from "@sealdesk/shared";
import type { Ctx } from "./context.ts";
import { clientIp } from "./http.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { openApiRoutes } from "./routes/openapi.ts";
import { publicRoutes } from "./routes/public.ts";
import { siteRoutes } from "./routes/site.ts";
import { relayRoutes } from "./routes/relay.ts";
import { rfqRoutes } from "./routes/rfqs.ts";
import { streamRoutes } from "./routes/stream.ts";

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp(ctx: Ctx, opts: { streamHeartbeatMs?: number } = {}) {
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : newId();
    },
    bodyLimit: 64 * 1024,
    trustProxy: true,
  });

  await app.register(helmet, {
    // The private link's secret lives in the URL fragment; never leak the URL via Referer.
    referrerPolicy: { policy: "no-referrer" },
    contentSecurityPolicy: false, // JSON API; the web app sets its own CSP
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  await app.register(cors, {
    origin: ctx.config.corsOrigins.length ? ctx.config.corsOrigins : false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "idempotency-key", "x-request-id", "last-event-id"],
    exposedHeaders: ["x-request-id", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "retry-after", "idempotent-replayed"],
    maxAge: 600,
  });

  // Global per-IP limit on top of the per-endpoint buckets.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS" || req.url === "/health") return;
    const { limit, windowMs } = ctx.config.limits.global;
    const r = await ctx.limiter.hit(`global:${clientIp(req)}`, limit, windowMs);
    if (!r.allowed) {
      reply.header("retry-after", Math.ceil(r.resetMs / 1000));
      throw new AppError(ErrorCode.RATE_LIMITED, "Too many requests");
    }
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, "request failed");
      return reply.status(err.status).send(err.toBody(req.id));
    }
    if (err instanceof ZodError) {
      const problems = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      const e = new AppError(ErrorCode.VALIDATION_FAILED, "Request validation failed", problems);
      return reply.status(e.status).send(e.toBody(req.id));
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = status === 429 ? ErrorCode.RATE_LIMITED : status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_FAILED;
      return reply.status(status).send(new AppError(code, (err as Error).message).toBody(req.id));
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send(new AppError(ErrorCode.INTERNAL, "Internal error").toBody(req.id));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(new AppError(ErrorCode.NOT_FOUND, `No route ${req.method} ${req.url.split("?")[0]}`).toBody(req.id));
  });

  app.get("/health", async (_req, reply) => {
    const [db, redis] = await Promise.all([ctx.checks.db().catch(() => false), ctx.checks.redis().catch(() => false)]);
    const ok = db && redis;
    reply.status(ok ? 200 : 503);
    return {
      ok,
      version: ctx.config.version,
      checks: { db, redis },
      chain: { id: ctx.config.chainId, name: ctx.config.chainName, rpc: ctx.config.rpcUrl },
      contracts: {
        escrow: ctx.config.escrow,
        feeVault: ctx.config.vault,
        stable: ctx.config.stable,
        platformToken: ctx.config.platformToken,
      },
      relayer: ctx.config.relayer,
      notifications: ctx.config.notify ?? { channels: ["telegram", "email", "webhook"], telegramBot: null },
    };
  });

  rfqRoutes(app, ctx);
  relayRoutes(app, ctx);
  notificationRoutes(app, ctx);
  publicRoutes(app, ctx);
  siteRoutes(app, ctx);
  streamRoutes(app, ctx, opts.streamHeartbeatMs ? { heartbeatMs: opts.streamHeartbeatMs } : {});
  openApiRoutes(app, ctx);
  return app;
}
