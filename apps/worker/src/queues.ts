/** Scheduled jobs (cron, UTC). Notifications run as a continuous loop, not a queue. */
export const QUEUES = {
  expirySweep: { name: "expiry-sweep", every: "* * * * *" },
  deadlineAlerts: { name: "deadline-alerts", every: "*/5 * * * *" },
  dexSnapshots: { name: "dex-snapshots", every: "*/2 * * * *" },
  referencePrices: { name: "reference-prices", every: "*/5 * * * *" },
  burnTracker: { name: "burn-tracker", every: "*/10 * * * *" },
  controlPanel: { name: "control-panel", every: "* * * * *" },
  ledgerReconcile: { name: "ledger-reconcile", every: "17 3 * * *" },
  idempotencyGc: { name: "idempotency-gc", every: "0 * * * *" },
  /** Market list from the issuer (Robinhood) every 6 hours; also run once at start. */
  marketCatalog: { name: "market-catalog", every: "23 */6 * * *" },
} as const;

export type QueueKey = keyof typeof QUEUES;
