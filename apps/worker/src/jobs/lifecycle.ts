/** Time-driven state changes: expiring postings/answers/deals and deadline warnings. */
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { deals, idempotencyKeys, quotes, rfqs, type AnyDb } from "@sealdesk/db";
import { publishDesk, type Cache, type EventBus } from "@sealdesk/shared";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

/** Close postings whose reply window passed, their unanswered answers, and accepted deals nobody paid. */
export async function sweepExpired(db: AnyDb, bus: EventBus, now: Date) {
  const expiredRfqs = await db
    .update(rfqs)
    .set({ status: "expired", closedAt: now })
    .where(and(eq(rfqs.status, "open"), lte(rfqs.expiresAt, now)))
    .returning({ id: rfqs.id });

  const expiredQuotes = await db
    .update(quotes)
    .set({ status: "expired" })
    .where(and(eq(quotes.status, "sealed"), inArray(quotes.rfqId, db.select({ id: rfqs.id }).from(rfqs).where(sql`${rfqs.status} <> 'open'`))))
    .returning({ id: quotes.id });

  // Accepted but never paid: after the deal deadline payment can no longer be locked.
  const expiredDeals = await db
    .update(deals)
    .set({ status: "expired" })
    .where(and(eq(deals.status, "accepted"), lte(deals.deadline, now)))
    .returning({ dealId: deals.dealId, rfqId: deals.rfqId, quoteId: deals.quoteId });

  for (const r of expiredRfqs) await bus.publish(`rfq:${r.id}`, "rfq.closed", { reason: "expired" });
  for (const d of expiredDeals) {
    await bus.publish(`rfq:${d.rfqId}`, "rfq.closed", { reason: "deal-expired", dealId: hex(d.dealId) });
  }
  return { rfqs: expiredRfqs.length, quotes: expiredQuotes.length, deals: expiredDeals.length };
}

/** Warn both sides once when a locked deal is close to its deadline (seller must deliver, or buyer can refund after). */
export async function alertDeadlines(db: AnyDb, bus: EventBus, cache: Cache, now: Date, windowMs = 30 * 60_000) {
  const soon = await db
    .select({ dealId: deals.dealId, rfqId: deals.rfqId, quoteId: deals.quoteId, deadline: deals.deadline })
    .from(deals)
    .where(and(eq(deals.status, "payment_locked"), gt(deals.deadline, now), lte(deals.deadline, new Date(now.getTime() + windowMs))));
  let sent = 0;
  for (const d of soon) {
    const id = hex(d.dealId);
    const key = `alerted:deadline:${id}`;
    if (await cache.get(key)) continue;
    const data = { dealId: id, deadline: d.deadline.toISOString() };
    await publishDesk(bus, `rfq:${d.rfqId}`, "deadline.near", data);
    await publishDesk(bus, `quote:${d.quoteId}`, "deadline.near", data);
    await cache.set(key, true, Math.ceil(windowMs / 1000) * 2);
    sent++;
  }
  return { alerted: sent };
}

export async function gcIdempotency(db: AnyDb, now: Date) {
  const gone = await db.delete(idempotencyKeys).where(lte(idempotencyKeys.expiresAt, now)).returning({ k: idempotencyKeys.key });
  return { deleted: gone.length };
}
