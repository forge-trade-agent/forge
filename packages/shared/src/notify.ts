import type { DeskEventType, EventBus } from "./ports.ts";

/** Global channel the worker tails to send Telegram / email / webhook notifications. */
export const NOTIFY_CHANNEL = "notify";

/** Events worth an out-of-band notification. */
export const NOTIFIABLE: ReadonlySet<DeskEventType> = new Set([
  "answer.received",
  "deal.accepted",
  "payment.locked",
  "deal.settled",
  "deal.refunded",
  "deadline.near",
  "notify.test",
]);

/**
 * Publish to a capability channel (rfq:<id> / quote:<id>) and, for notifiable events,
 * fan out to the notify channel. Payloads never contain prices or link secrets.
 */
export async function publishDesk(bus: EventBus, channel: string, type: DeskEventType, data: Record<string, unknown>) {
  const seq = await bus.publish(channel, type, data);
  if (NOTIFIABLE.has(type) && /^(rfq|quote):/.test(channel)) {
    await bus.publish(NOTIFY_CHANNEL, type, { channel, ...data });
  }
  return seq;
}
