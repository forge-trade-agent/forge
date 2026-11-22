/** OpenAPI 3.1 document generated from the same Zod schemas the routes validate with. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AcceptBody, AppError, ErrorCode, RfqCreate, RfqPublic, SealedQuoteCreate, SettledReport, Terms } from "@sealdesk/shared";
import type { Ctx } from "../context.ts";
import { Subscribe } from "./notifications.ts";
import { RelayDepositBody } from "./relay.ts";

const js = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any", target: "draft-2020-12" });

type Op = { summary: string; auth?: "manage" | "quote"; body?: string; idempotent?: boolean; tags: string[] };
const OPS: Record<string, Record<string, Op>> = {
  "/health": { get: { summary: "Server config and dependency health", tags: ["meta"] } },
  "/rfqs": {
    get: { summary: "Open bids and listings (public view, never prices)", tags: ["desk"] },
    post: { summary: "Post a bid (side=buy) or listing (side=sell); returns a manage token once", body: "RfqCreate", idempotent: true, tags: ["desk"] },
  },
  "/rfqs/{id}": { get: { summary: "One posting (public view)", tags: ["desk"] } },
  "/rfqs/{id}/cancel": { post: { summary: "Cancel your posting", auth: "manage", tags: ["desk"] } },
  "/rfqs/{id}/quotes": {
    get: { summary: "Sealed answers on your posting (ciphertext)", auth: "manage", tags: ["desk"] },
    post: { summary: "Send a sealed answer; returns a quote token once", body: "SealedQuoteCreate", idempotent: true, tags: ["desk"] },
  },
  "/rfqs/{id}/accept": { post: { summary: "Accept one answer and fix the deal terms", auth: "manage", body: "AcceptBody", idempotent: true, tags: ["deals"] } },
  "/rfqs/{id}/deal": { get: { summary: "Latest accepted deal", auth: "manage", tags: ["deals"] } },
  "/rfqs/{id}/deals": { get: { summary: "Every deal on a posting (partial fills)", auth: "manage", tags: ["deals"] } },
  "/rfqs/{id}/settled": { post: { summary: "Report the settlement tx; verified on-chain first", body: "SettledReport", tags: ["deals"] } },
  "/quotes/{id}": { get: { summary: "Your answer's status; terms once accepted", auth: "quote", tags: ["deals"] } },
  "/deals/{dealId}/receipt": { get: { summary: "Settlement tx of a deal, once reported", tags: ["deals"] } },
  "/receipts/{tx}": { get: { summary: "Public receipt rebuilt from the settlement transaction", tags: ["deals"] } },
  "/relay": { get: { summary: "Relayer address and minimum fee", tags: ["ghost"] } },
  "/relay/deposit": { post: { summary: "Ghost mode: queue a relayed delivery", body: "RelayDepositBody", idempotent: true, tags: ["ghost"] } },
  "/relay/requests/{id}": { get: { summary: "Relay request status", tags: ["ghost"] } },
  "/token/{address}": { get: { summary: "ERC-20 facts read on-chain", tags: ["market"] } },
  "/token/{address}/market": { get: { summary: "DEX snapshot (reference only)", tags: ["market"] } },
  "/price/{token}": { get: { summary: "Latest DEX price (reference only)", tags: ["market"] } },
  "/markets": { get: { summary: "Featured markets with delayed reference prices and open blocks", tags: ["market"] } },
  "/markets/{symbol}/chart": { get: { summary: "OHLC candles of the reference listing (delayed)", tags: ["market"] } },
  "/burn": { get: { summary: "Buy-and-burn vault state: route, queued route + ETA, burned totals", tags: ["stats"] } },
  "/control": { get: { summary: "Live control panel read from the chain: escrow, fee vault roles, burn route, balances, relayer", tags: ["stats"] } },
  "/stats": { get: { summary: "Desk totals checked against the escrow", tags: ["stats"] } },
  "/referrals/{address}": { get: { summary: "Referred deals and earnings", tags: ["stats"] } },
  "/notifications": {
    get: { summary: "Channels subscribed for a posting or answer", tags: ["realtime"] },
    post: { summary: "Subscribe Telegram, email or webhook alerts to a posting or answer", body: "Subscribe", tags: ["realtime"] },
  },
  "/notifications/remove": { post: { summary: "Unsubscribe a channel", tags: ["realtime"] } },
  "/notifications/test": { post: { summary: "Send one test alert to every channel on a posting or answer (3 per 10 min)", tags: ["realtime"] } },
  "/sdk/forge.mjs": { get: { summary: "Bundled JavaScript SDK (ES module); SHA-256 in x-content-sha256", tags: ["meta"] } },
  "/sdk/forge.mjs.sha256": { get: { summary: "SHA-256 of the SDK bundle", tags: ["meta"] } },
  "/mcp/forge-mcp.mjs": { get: { summary: "Single-file MCP server for AI agents (run with node 22+); SHA-256 in x-content-sha256", tags: ["meta"] } },
  "/mcp/forge-mcp.mjs.sha256": { get: { summary: "SHA-256 of the MCP server bundle", tags: ["meta"] } },
  "/site": { get: { summary: "Public site settings: the token contract address (CA) set by the operator", tags: ["meta"] } },
  "/stream": { get: { summary: "Server-Sent Events: desk, rfq:<id> (manage token), quote:<id> (quote token)", tags: ["realtime"] } },
};

export function buildOpenApi(ctx: Ctx) {
  const schemas = {
    RfqCreate: js(RfqCreate),
    RfqPublic: js(RfqPublic),
    SealedQuoteCreate: js(SealedQuoteCreate),
    Terms: js(Terms),
    AcceptBody: js(AcceptBody),
    SettledReport: js(SettledReport),
    RelayDepositBody: js(RelayDepositBody),
    Subscribe: js(Subscribe),
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string", enum: Object.values(ErrorCode) },
            message: { type: "string" },
            requestId: { type: "string" },
            problems: { type: "array", items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } } },
          },
        },
      },
    },
  };

  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, methods] of Object.entries(OPS)) {
    paths[path] = {};
    for (const [method, op] of Object.entries(methods)) {
      const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
      if (op.idempotent) params.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } });
      paths[path]![method] = {
        summary: op.summary,
        tags: op.tags,
        parameters: params,
        ...(op.auth ? { security: [{ [op.auth === "manage" ? "manageToken" : "quoteToken"]: [] }] } : {}),
        ...(op.body
          ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${op.body}` } } } } }
          : {}),
        responses: {
          "200": { description: "OK" },
          default: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Forge API",
      version: ctx.config.version,
      description:
        "Private OTC block trades. No accounts: creating a posting or answer returns a capability token; send it as " +
        "`Authorization: Bearer <token>`. Answers are sealed client-side; the server stores ciphertext only. " +
        "Settlement happens on-chain in the OtcEscrow contract.",
    },
    servers: [{ url: ctx.config.publicUrl }],
    components: {
      schemas,
      securitySchemes: {
        manageToken: { type: "http", scheme: "bearer", description: "Capability token returned by POST /rfqs" },
        quoteToken: { type: "http", scheme: "bearer", description: "Capability token returned by POST /rfqs/{id}/quotes" },
      },
    },
    paths,
  };
}

const SDK_BUNDLE = fileURLToPath(new URL("../../../../packages/sdk/dist/forge.mjs", import.meta.url));
const MCP_BUNDLE = fileURLToPath(new URL("../../../../packages/mcp/dist/forge-mcp.mjs", import.meta.url));

export function openApiRoutes(app: FastifyInstance, ctx: Ctx) {
  const doc = buildOpenApi(ctx);
  app.get("/openapi.json", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return doc;
  });

  // Bundled browser/Node SDK (built by `npm run build -w @sealdesk/sdk`) and the single-file MCP
  // server (built by `npm run build -w @sealdesk/mcp`). Each is served with its SHA-256 so it can be
  // checked before running.
  const serve = (route: string, file: string, envPath: string, what: string) => {
    let cached: { body: Buffer; sha256: string } | null = null;
    const load = async () => {
      if (!cached) {
        try {
          const body = await readFile(process.env[envPath] ?? file);
          cached = { body, sha256: createHash("sha256").update(body).digest("hex") };
        } catch {
          throw new AppError(ErrorCode.NOT_FOUND, `${what} is not built on this server`);
        }
      }
      return cached;
    };
    app.get(route, async (_req, reply) => {
      const b = await load();
      reply.header("content-type", "text/javascript; charset=utf-8");
      reply.header("cache-control", "public, max-age=3600");
      reply.header("x-content-sha256", b.sha256);
      reply.header("access-control-allow-origin", "*");
      return reply.send(b.body);
    });
    app.get(`${route}.sha256`, async (_req, reply) => {
      const b = await load();
      reply.header("content-type", "text/plain; charset=utf-8");
      reply.header("access-control-allow-origin", "*");
      return reply.send(`${b.sha256}  ${route.split("/").pop()}\n`);
    });
  };
  serve("/sdk/forge.mjs", SDK_BUNDLE, "SDK_BUNDLE_PATH", "SDK bundle");
  serve("/mcp/forge-mcp.mjs", MCP_BUNDLE, "MCP_BUNDLE_PATH", "MCP server bundle");
}
