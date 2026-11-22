/**
 * Postings (bids and listings), sealed answers, acceptance and deals.
 * The server never sees a price before acceptance: answers are stored as ciphertext.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { dealEvents, deals, quotes, rfqs } from "@sealdesk/db";
import { dealIdOf } from "@sealdesk/crypto";
import {
  AcceptBody,
  Address,
  AppError,
  ErrorCode,
  newCapabilityToken,
  newId,
  publishDesk,
  replyWindowSeconds,
  RfqCreate,
  SealedQuoteCreate,
  SettledReport,
  ZERO_ADDRESS,
  type Hex,
  type Terms,
} from "@sealdesk/shared";
import type { Ctx } from "../context.ts";
import { b64, hex, idempotent, iso, limit, parse, requireToken, unhex } from "../http.ts";

type RfqRow = typeof rfqs.$inferSelect;
type DealRow = typeof deals.$inferSelect;

const MIN_DEAL_WINDOW_S = 10 * 60;
const MAX_DEAL_WINDOW_S = 30 * 86_400;

function effectiveStatus(r: RfqRow, now: Date): RfqRow["status"] {
  return r.status === "open" && r.expiresAt <= now ? "expired" : r.status;
}

export function publicRfq(r: RfqRow, now: Date) {
  return {
    id: r.id,
    side: r.side,
    token: r.tokenAddress,
    payToken: r.payToken,
    amount: r.amount,
    filledAmount: r.filledAmount,
    sizeUsd: r.sizeUsd,
    note: r.note,
    encPubKey: b64(r.encPubKey)!,
    allowPartial: r.allowPartial,
    status: effectiveStatus(r, now),
    quoteCount: r.quoteCount,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  };
}

export function dealView(d: DealRow) {
  const terms: Terms = {
    buyer: d.buyer as Hex,
    seller: d.seller as Hex,
    token: d.tokenAddress as Hex,
    amount: d.amount,
    payToken: d.payToken as Hex,
    price: d.price,
    sellerPayout: d.sellerPayout as Hex,
    referrer: (d.referrer ?? ZERO_ADDRESS) as Hex,
    relayerFee: d.relayerFee,
    deadline: Math.floor(d.deadline.getTime() / 1000),
    salt: hex(d.salt)!,
  };
  return {
    dealId: hex(d.dealId)!,
    rfqId: d.rfqId,
    quoteId: d.quoteId,
    escrow: d.escrowAddress,
    chainId: d.chainId,
    terms,
    status: d.status,
    acceptedAt: d.acceptedAt.toISOString(),
    paymentLockedAt: iso(d.paymentLockedAt),
    settledAt: iso(d.settledAt),
    settleTx: hex(d.settleTx),
    refundedAt: iso(d.refundedAt),
    refundTx: hex(d.refundTx),
    fee: d.fee,
    referrerFee: d.referrerFee,
    relayer: d.relayer,
  };
}

async function loadRfq(ctx: Ctx, id: string): Promise<RfqRow> {
  const [row] = await ctx.db.select().from(rfqs).where(eq(rfqs.id, id));
  if (!row) throw new AppError(ErrorCode.RFQ_NOT_FOUND, "No such posting");
  return row;
}

const ListQuery = z.object({
  side: z.enum(["buy", "sell"]).optional(),
  token: Address.optional(),
  sort: z.enum(["new", "ending", "hot"]).default("new"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime().optional(),
});

export function rfqRoutes(app: FastifyInstance, ctx: Ctx) {
  // ------------------------------------------------------------------ list open postings
  app.get("/rfqs", async (req) => {
    const q = parse(ListQuery, req.query);
    const now = ctx.now();
    const where: SQL[] = [eq(rfqs.status, "open"), gt(rfqs.expiresAt, now), eq(rfqs.chainId, ctx.config.chainId)];
    if (q.side) where.push(eq(rfqs.side, q.side));
    if (q.token) where.push(eq(rfqs.tokenAddress, q.token));
    if (q.before) where.push(lt(rfqs.createdAt, new Date(q.before)));
    const order =
      q.sort === "ending" ? [asc(rfqs.expiresAt)] : q.sort === "hot" ? [desc(rfqs.quoteCount), desc(rfqs.createdAt)] : [desc(rfqs.createdAt)];
    const rows = await ctx.db.select().from(rfqs).where(and(...where)).orderBy(...order).limit(q.limit);
    const counts = await ctx.db
      .select({
        open: sql<number>`count(*)::int`,
        buying: sql<number>`count(*) filter (where ${rfqs.side} = 'buy')::int`,
        selling: sql<number>`count(*) filter (where ${rfqs.side} = 'sell')::int`,
        sealed: sql<number>`coalesce(sum(${rfqs.quoteCount}), 0)::int`,
      })
      .from(rfqs)
      .where(and(eq(rfqs.status, "open"), gt(rfqs.expiresAt, now), eq(rfqs.chainId, ctx.config.chainId)));
    return { items: rows.map((r) => publicRfq(r, now)), counts: counts[0] };
  });

  // ------------------------------------------------------------------ create posting
  app.post("/rfqs", async (req, reply) => {
    await limit(ctx, req, reply, "createRfq");
    return idempotent(ctx, req, reply, "rfq.create", async () => {
      const body = parse(RfqCreate, req.body);
      // Same rule as the escrow: ETH, the stablecoin, or the platform token (flat fee, burned).
      if (body.payToken !== ZERO_ADDRESS && body.payToken !== ctx.config.stable && body.payToken !== ctx.config.platformToken) {
        throw new AppError(ErrorCode.UNSUPPORTED_PAY_TOKEN, "Pay with ETH, the desk stablecoin or the platform token");
      }
      if (body.token === body.payToken) throw new AppError(ErrorCode.VALIDATION_FAILED, "token and payToken must differ");
      const facts = await tokenFactsCached(ctx, body.token);
      if (!facts.hasCode) throw new AppError(ErrorCode.TOKEN_NOT_CONTRACT, "Token address has no contract code");

      const now = ctx.now();
      const { token, hash } = newCapabilityToken();
      const [row] = await ctx.db
        .insert(rfqs)
        .values({
          id: newId(),
          chainId: ctx.config.chainId,
          side: body.side,
          tokenAddress: body.token,
          payToken: body.payToken,
          amount: body.amount,
          sizeUsd: body.sizeUsd ?? null,
          note: body.note ?? null,
          encPubKey: Buffer.from(body.encPubKey, "base64"),
          manageTokenHash: hash,
          allowPartial: body.allowPartial,
          createdAt: now,
          expiresAt: new Date(now.getTime() + replyWindowSeconds[body.replyWindow] * 1000),
        })
        .returning();
      const view = publicRfq(row!, now);
      await ctx.bus.publish("desk", "rfq.created", { rfq: view });
      return { status: 201, body: { rfq: view, manageToken: token, token: facts } };
    });
  });

  // ------------------------------------------------------------------ one posting (public view)
  app.get<{ Params: { id: string } }>("/rfqs/:id", async (req) => {
    return { rfq: publicRfq(await loadRfq(ctx, req.params.id), ctx.now()) };
  });

  // ------------------------------------------------------------------ cancel
  app.post<{ Params: { id: string } }>("/rfqs/:id/cancel", async (req) => {
    const r = await loadRfq(ctx, req.params.id);
    requireToken(req, r.manageTokenHash);
    if (r.status !== "open") throw new AppError(ErrorCode.RFQ_CLOSED, `Posting is ${r.status}`);
    const now = ctx.now();
    const [row] = await ctx.db
      .update(rfqs)
      .set({ status: "cancelled", closedAt: now })
      .where(and(eq(rfqs.id, r.id), eq(rfqs.status, "open")))
      .returning();
    await publishDesk(ctx.bus, `rfq:${r.id}`, "rfq.closed", { reason: "cancelled" });
    return { rfq: publicRfq(row!, now) };
  });

  // ------------------------------------------------------------------ sealed answers on my posting
  app.get<{ Params: { id: string } }>("/rfqs/:id/quotes", async (req) => {
    const r = await loadRfq(ctx, req.params.id);
    requireToken(req, r.manageTokenHash);
    const rows = await ctx.db.select().from(quotes).where(eq(quotes.rfqId, r.id)).orderBy(asc(quotes.createdAt));
    return {
      items: rows.map((q) => ({
        id: q.id,
        status: q.status,
        createdAt: q.createdAt.toISOString(),
        sealed: { senderEncPubKey: b64(q.senderEncPubKey), nonce: b64(q.nonce), ciphertext: b64(q.ciphertext) },
      })),
    };
  });

  // ------------------------------------------------------------------ send a sealed answer
  app.post<{ Params: { id: string } }>("/rfqs/:id/quotes", async (req, reply) => {
    await limit(ctx, req, reply, "createQuote");
    return idempotent(ctx, req, reply, `quote.create:${req.params.id}`, async () => {
      const body = parse(SealedQuoteCreate, req.body);
      const r = await loadRfq(ctx, req.params.id);
      const now = ctx.now();
      const status = effectiveStatus(r, now);
      if (status === "expired") throw new AppError(ErrorCode.RFQ_EXPIRED, "Reply window has closed");
      if (status !== "open") throw new AppError(ErrorCode.RFQ_CLOSED, `Posting is ${status}`);

      const { token, hash } = newCapabilityToken();
      const id = newId();
      await ctx.db.transaction(async (tx) => {
        await tx.insert(quotes).values({
          id,
          rfqId: r.id,
          senderEncPubKey: Buffer.from(body.senderEncPubKey, "base64"),
          nonce: Buffer.from(body.nonce, "base64"),
          ciphertext: Buffer.from(body.ciphertext, "base64"),
          quoteTokenHash: hash,
          createdAt: now,
        });
        await tx.update(rfqs).set({ quoteCount: sql`${rfqs.quoteCount} + 1` }).where(eq(rfqs.id, r.id));
      });
      await publishDesk(ctx.bus, `rfq:${r.id}`, "answer.received", { quoteId: id });
      return { status: 201, body: { quoteId: id, quoteToken: token } };
    });
  });

  // ------------------------------------------------------------------ accept one answer
  app.post<{ Params: { id: string } }>("/rfqs/:id/accept", async (req, reply) => {
    const pre = await loadRfq(ctx, req.params.id);
    requireToken(req, pre.manageTokenHash);
    return idempotent(ctx, req, reply, `rfq.accept:${pre.id}`, async () => {
      const body = parse(AcceptBody, req.body);
      const t = body.terms;
      const now = ctx.now();
      const nowS = Math.floor(now.getTime() / 1000);
      if (t.deadline < nowS + MIN_DEAL_WINDOW_S || t.deadline > nowS + MAX_DEAL_WINDOW_S) {
        throw new AppError(ErrorCode.TERMS_MISMATCH, "Deal deadline must be between 10 minutes and 30 days from now");
      }
      if (t.buyer === t.seller) throw new AppError(ErrorCode.TERMS_MISMATCH, "Buyer and seller must differ");
      if (t.referrer !== ZERO_ADDRESS && [t.buyer, t.seller, t.sellerPayout].includes(t.referrer)) {
        throw new AppError(ErrorCode.TERMS_MISMATCH, "Referrer can't be a party to the deal");
      }
      const dealId = dealIdOf(t);

      const deal = await ctx.db.transaction(async (tx) => {
        // Row lock: concurrent accepts on a partially-filled posting serialise here.
        const [r] = await tx.select().from(rfqs).where(eq(rfqs.id, pre.id)).for("update");
        if (!r) throw new AppError(ErrorCode.RFQ_NOT_FOUND, "No such posting");
        if (r.status !== "open") throw new AppError(ErrorCode.RFQ_CLOSED, `Posting is ${r.status}`);
        if (t.token !== r.tokenAddress || t.payToken !== r.payToken) {
          throw new AppError(ErrorCode.TERMS_MISMATCH, "Terms don't match the posting's token or pay token");
        }
        const remaining = BigInt(r.amount) - BigInt(r.filledAmount);
        const amount = BigInt(t.amount);
        if (r.allowPartial ? amount > remaining : amount !== remaining) {
          throw new AppError(ErrorCode.TERMS_MISMATCH, r.allowPartial ? "Size exceeds what is left" : "Size must equal the posting");
        }

        const [q] = await tx.select().from(quotes).where(and(eq(quotes.id, body.quoteId), eq(quotes.rfqId, r.id))).for("update");
        if (!q) throw new AppError(ErrorCode.QUOTE_NOT_FOUND, "No such answer on this posting");
        if (q.status !== "sealed") throw new AppError(ErrorCode.QUOTE_ALREADY_ACCEPTED, `Answer is ${q.status}`);

        const [d] = await tx
          .insert(deals)
          .values({
            dealId: unhex(dealId),
            chainId: ctx.config.chainId,
            escrowAddress: ctx.config.escrow,
            rfqId: r.id,
            quoteId: q.id,
            buyer: t.buyer,
            seller: t.seller,
            tokenAddress: t.token,
            amount: t.amount,
            payToken: t.payToken,
            price: t.price,
            sellerPayout: t.sellerPayout,
            referrer: t.referrer === ZERO_ADDRESS ? null : t.referrer,
            relayerFee: t.relayerFee,
            deadline: new Date(t.deadline * 1000),
            salt: unhex(t.salt),
            acceptedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (!d) throw new AppError(ErrorCode.TERMS_MISMATCH, "A deal with identical terms already exists; use a new salt");

        await tx.update(quotes).set({ status: "accepted", acceptedAt: now }).where(eq(quotes.id, q.id));
        const filled = BigInt(r.filledAmount) + amount;
        const full = filled === BigInt(r.amount);
        await tx
          .update(rfqs)
          .set({ filledAmount: filled.toString(), ...(full ? { status: "filled" as const, closedAt: now } : {}) })
          .where(eq(rfqs.id, r.id));
        await tx.insert(dealEvents).values({ dealId: d.dealId, kind: "accepted", source: "api", payload: { quoteId: q.id } });
        return d;
      });

      const view = dealView(deal);
      await publishDesk(ctx.bus, `quote:${deal.quoteId}`, "deal.accepted", { dealId: view.dealId, terms: view.terms });
      await publishDesk(ctx.bus, `rfq:${deal.rfqId}`, "deal.accepted", { dealId: view.dealId });
      return { status: 201, body: { deal: view } };
    });
  });

  // ------------------------------------------------------------------ my deals
  app.get<{ Params: { id: string } }>("/rfqs/:id/deals", async (req) => {
    const r = await loadRfq(ctx, req.params.id);
    requireToken(req, r.manageTokenHash);
    const rows = await ctx.db.select().from(deals).where(eq(deals.rfqId, r.id)).orderBy(asc(deals.acceptedAt));
    return { items: rows.map(dealView) };
  });

  app.get<{ Params: { id: string } }>("/rfqs/:id/deal", async (req) => {
    const r = await loadRfq(ctx, req.params.id);
    requireToken(req, r.manageTokenHash);
    const [row] = await ctx.db.select().from(deals).where(eq(deals.rfqId, r.id)).orderBy(desc(deals.acceptedAt)).limit(1);
    if (!row) throw new AppError(ErrorCode.DEAL_NOT_FOUND, "Nothing accepted yet");
    return { deal: dealView(row) };
  });

  // ------------------------------------------------------------------ answer status (answerer side)
  app.get<{ Params: { id: string } }>("/quotes/:id", async (req) => {
    const [q] = await ctx.db.select().from(quotes).where(eq(quotes.id, req.params.id));
    if (!q) throw new AppError(ErrorCode.QUOTE_NOT_FOUND, "No such answer");
    requireToken(req, q.quoteTokenHash);
    const r = await loadRfq(ctx, q.rfqId);
    const [d] = await ctx.db.select().from(deals).where(eq(deals.quoteId, q.id));
    return {
      quote: { id: q.id, status: q.status, createdAt: q.createdAt.toISOString(), acceptedAt: iso(q.acceptedAt) },
      rfq: publicRfq(r, ctx.now()),
      deal: d ? dealView(d) : null,
    };
  });

  // ------------------------------------------------------------------ report settlement (no token)
  app.post<{ Params: { id: string } }>("/rfqs/:id/settled", async (req) => {
    const { txHash } = parse(SettledReport, req.body);
    const r = await loadRfq(ctx, req.params.id);
    const proof = await ctx.chain.settlementFromTx(txHash);
    if (!proof) throw new AppError(ErrorCode.TX_NOT_SETTLEMENT, "Transaction is not a successful settlement on the desk escrow");
    const [d] = await ctx.db
      .select()
      .from(deals)
      .where(and(eq(deals.dealId, unhex(proof.dealId)), eq(deals.rfqId, r.id)));
    if (!d) throw new AppError(ErrorCode.TX_NOT_SETTLEMENT, "Settlement does not belong to this posting");

    if (d.status !== "settled") {
      const at = new Date(proof.timestamp * 1000);
      await ctx.db.transaction(async (tx) => {
        if (d.status === "accepted") {
          await tx.update(deals).set({ status: "payment_locked", paymentLockedAt: at }).where(eq(deals.dealId, d.dealId));
        }
        await tx
          .update(deals)
          .set({
            status: "settled",
            settledAt: at,
            settleTx: unhex(proof.txHash),
            settleBlock: proof.blockNumber,
            fee: proof.fee.toString(),
            referrerFee: proof.referrerFee.toString(),
            relayer: /^0x0{40}$/.test(proof.relayer) ? null : proof.relayer,
          })
          .where(eq(deals.dealId, d.dealId));
        await tx.insert(dealEvents).values({ dealId: d.dealId, kind: "settled.reported", source: "api", payload: { txHash } });
      });
      await publishDesk(ctx.bus, `rfq:${r.id}`, "deal.settled", { dealId: proof.dealId, txHash });
      await publishDesk(ctx.bus, `quote:${d.quoteId}`, "deal.settled", { dealId: proof.dealId, txHash });
    }
    const [fresh] = await ctx.db.select().from(deals).where(eq(deals.dealId, d.dealId));
    return { deal: dealView(fresh!) };
  });

  // ------------------------------------------------------------------ settlement tx of a deal (public)
  app.get<{ Params: { dealId: string } }>("/deals/:dealId/receipt", async (req) => {
    const id = parse(z.string().regex(/^0x[0-9a-fA-F]{64}$/), req.params.dealId);
    const [d] = await ctx.db.select().from(deals).where(eq(deals.dealId, unhex(id)));
    if (!d || !d.settleTx) throw new AppError(ErrorCode.DEAL_NOT_FOUND, "No reported settlement for this deal");
    return { dealId: id.toLowerCase(), txHash: hex(d.settleTx), receipt: `${ctx.config.publicUrl}/receipts/${hex(d.settleTx)}` };
  });
}

export async function tokenFactsCached(ctx: Ctx, address: Hex) {
  const key = `token:${ctx.config.chainId}:${address}`;
  const hit = await ctx.cache.get<Awaited<ReturnType<Ctx["chain"]["tokenFacts"]>>>(key);
  if (hit) return hit;
  const facts = await ctx.chain.tokenFacts(address);
  await ctx.cache.set(key, facts, facts.hasCode ? 3600 : 60);
  return facts;
}
