/**
 * One-off: fill or refresh the market list from the issuer, for the chain in CHAIN_ID.
 *   DATABASE_URL=postgres://… CHAIN_ID=4663 node scripts/sync-markets.ts
 * The worker does the same every 6 hours; this is for a fresh database before the worker runs.
 */
import { createDb } from "@sealdesk/db";
import { catalogFor, syncCatalog } from "../apps/worker/src/jobs/catalog.ts";

const url = process.env["DATABASE_URL"];
const chainId = Number(process.env["CHAIN_ID"] ?? 4663);
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const entries = await catalogFor(chainId);
if (entries.length === 0) {
  console.error(`No market list for chain ${chainId} (supported: 4663 mainnet, 46630 testnet)`);
  process.exit(1);
}
const h = createDb(url, { max: 1, applicationName: "forge-sync-markets" });
try {
  const r = await syncCatalog(h.db, { chainId, entries, now: new Date() });
  console.log(`chain ${chainId}: ${r.upserted} markets synced (${entries.slice(0, 8).map((e) => e.symbol).join(", ")}, …)`);
} finally {
  await h.close();
}
