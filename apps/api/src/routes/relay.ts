/**
 * Ghost mode: a one-time wallet signs a Deliver authorization (and a permit); the relayer
 * submits the delivery and pays gas, earning terms.relayerFee from the seller's proceeds.
 * The API only validates and queues; the relayer service re-validates and simulates before sending.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dealIdOf, recoverDeliverSigner } from "@sealdesk/crypto";
import { AppError, ErrorCode, Hex32, newId, Terms, Uint256, type Hex, type RelayRequest } from "@sealdesk/shared";
import { eq } from "drizzle-orm";
import { deals } from "@sealdesk/db";
import type { Ctx } from "../context.ts";
import { idempotent, limit, parse, unhex } from "../http.ts";

const Sig = z.string().regex(/^0x[0-9a-fA-F]{130}$/, "65-byte signature");
const Permit = z.object({
  value: Uint256,
  deadline: Uint256,
  v: z.number().int().min(27).max(28),
  r: Hex32,
  s: Hex32,
});
export const RelayDepositBody = z.object({
  terms: Terms,
  permit: Permit.nullable(),
  authDeadline: Uint256,
  signature: Sig,
});

export function relayRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/relay", async () => ({
    enabled: ctx.config.relayer !== null,
    relayer: ctx.config.relayer,
    minFeeBps: ctx.config.relayerMinFeeBps,
    chainId: ctx.config.chainId,
    escrow: ctx.config.escrow,
  }));

  app.post("/relay/deposit", async (req, reply) => {
    await limit(ctx, req, reply, "relay");
    const relayer = ctx.config.relayer;
    if (!relayer) throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, "Relayer is not enabled on this desk");

    return idempotent(ctx, req, reply, "relay.deposit", async () => {
      const body = parse(RelayDepositBody, req.body);
      const t = body.terms;
      const nowS = BigInt(Math.floor(ctx.now().getTime() / 1000));
      const authDeadline = BigInt(body.authDeadline);
      if (authDeadline <= nowS) throw new AppError(ErrorCode.SIG_INVALID, "Authorization already expired");
      if (BigInt(t.deadline) <= nowS) throw new AppError(ErrorCode.TERMS_MISMATCH, "Deal deadline has passed");

      const minFee = (BigInt(t.price) * BigInt(ctx.config.relayerMinFeeBps)) / 10_000n;
      if (BigInt(t.relayerFee) < minFee) {
        throw new AppError(ErrorCode.RELAY_FEE_TOO_LOW, `relayerFee must be at least ${minFee} (${ctx.config.relayerMinFeeBps} bps)`);
      }

      const dealId = dealIdOf(t);
      const [known] = await ctx.db.select({ id: deals.dealId }).from(deals).where(eq(deals.dealId, unhex(dealId)));
      if (!known) throw new AppError(ErrorCode.DEAL_NOT_FOUND, "Only deals accepted on this desk can be relayed");
      const signer = await recoverDeliverSigner(ctx.config.chainId, ctx.config.escrow, dealId, relayer, authDeadline, body.signature as Hex);
      if (!signer || signer.toLowerCase() !== t.seller) {
        throw new AppError(ErrorCode.SIG_INVALID, "Deliver authorization is not signed by terms.seller for this relayer");
      }
      const onChain = await ctx.chain.dealStatus(dealId);
      if (onChain !== "payment_locked") {
        throw new AppError(ErrorCode.TERMS_MISMATCH, `Deal is ${onChain} on-chain; payment must be locked first`);
      }

      const request: RelayRequest = {
        id: newId(),
        dealId,
        terms: t,
        permit: body.permit as RelayRequest["permit"],
        authDeadline: body.authDeadline,
        signature: body.signature as Hex,
        receivedAt: ctx.now().toISOString(),
      };
      await ctx.relay.enqueue(request);
      return { status: 202, body: { requestId: request.id, dealId, state: "queued" as const } };
    });
  });

  app.get<{ Params: { id: string } }>("/relay/requests/:id", async (req) => {
    const s = await ctx.relay.getStatus(req.params.id);
    if (!s) throw new AppError(ErrorCode.NOT_FOUND, "No such relay request");
    return { requestId: req.params.id, ...s };
  });
}
