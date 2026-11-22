import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { asc, eq } from "drizzle-orm";
import { markets, MIGRATIONS_DIR, schema, type AnyDb } from "@sealdesk/db";
import { catalogFor, parseRobinhoodAssets, syncCatalog, TESTNET_CATALOG } from "../src/jobs/catalog.ts";

// Shape copied from https://api.robinhood.com/rhj/assets (trimmed), plus rows that must be skipped.
const SAMPLE = {
  assets: [
    {
      tokenSymbol: "TSLA", tokenName: "Tesla • Robinhood Token", status: "ASSET_STATUS_ACTIVE", tokenDecimals: 18,
      logoUrl: "https://cdn.robinhood.com/ncw_assets/logos/0x322f0929c4625ed5bad873c95208d54e1c003b2d.png",
      deployments: [{ contractAddress: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", chainId: 4663 }],
    },
    {
      tokenSymbol: "SPY", tokenName: "SPDR S&P 500 ETF Trust • Robinhood Token", status: "ASSET_STATUS_ACTIVE", tokenDecimals: 18,
      deployments: [{ contractAddress: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", chainId: 4663 }],
    },
    {
      tokenSymbol: "CRM", tokenName: "Salesforce • Robinhood Token", status: "ASSET_STATUS_ACTIVE", tokenDecimals: 18,
      deployments: [{ contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44", chainId: 4663 }],
    },
    { tokenSymbol: "OLD", tokenName: "Delisted • Robinhood Token", status: "ASSET_STATUS_INACTIVE", tokenDecimals: 18, deployments: [{ contractAddress: `0x${"1".repeat(40)}`, chainId: 4663 }] },
    { tokenSymbol: "ELSE", tokenName: "Other chain • Robinhood Token", status: "ASSET_STATUS_ACTIVE", tokenDecimals: 18, deployments: [{ contractAddress: `0x${"2".repeat(40)}`, chainId: 1 }] },
    { tokenSymbol: "BAD", tokenName: "Broken", status: "ASSET_STATUS_ACTIVE", tokenDecimals: 18, deployments: [{ contractAddress: "not-an-address", chainId: 4663 }] },
  ],
};

let pg: PGlite;
let db: AnyDb;
before(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS_DIR });
  db = d as unknown as AnyDb;
});
after(() => pg.close());

test("parses the issuer list: active rows on this chain only, clean names, ETFs marked", () => {
  const list = parseRobinhoodAssets(SAMPLE);
  assert.deepEqual(list.map((e) => e.symbol), ["TSLA", "SPY", "CRM"]);
  assert.equal(list[0]!.name, "Tesla");
  assert.equal(list[0]!.token, "0x322f0929c4625ed5bad873c95208d54e1c003b2d");
  assert.equal(list[1]!.kind, "etf");
  assert.equal(list[2]!.kind, "stock");
  assert.equal(list[2]!.logoUrl, null);
});

test("sync upserts by address, keeps big names first, and is repeatable", async () => {
  const now = new Date("2026-11-19T00:00:00Z");
  const list = parseRobinhoodAssets(SAMPLE);
  assert.deepEqual(await syncCatalog(db, { chainId: 4663, entries: list, now }), { upserted: 3 });
  // A rename upstream updates the row instead of adding one.
  await syncCatalog(db, { chainId: 4663, entries: list.map((e) => (e.symbol === "CRM" ? { ...e, name: "Salesforce Inc" } : e)), now });
  const rows = await db.select().from(markets).where(eq(markets.chainId, 4663)).orderBy(asc(markets.sortOrder));
  assert.deepEqual(rows.map((r) => r.symbol), ["TSLA", "SPY", "CRM"]);
  assert.equal(rows.find((r) => r.symbol === "CRM")!.name, "Salesforce Inc");
  assert.equal(rows[0]!.underlyingSymbol, "TSLA");
  assert.equal(rows[0]!.featured, true);
});

test("testnet uses the faucet tokens; unknown chains get nothing", async () => {
  assert.equal((await catalogFor(46630)).length, TESTNET_CATALOG.length);
  assert.deepEqual(await catalogFor(31337), []);
});

test("a failed or empty fetch is an error, not an empty desk", async () => {
  const down = (async () => new Response("nope", { status: 503 })) as typeof fetch;
  await assert.rejects(catalogFor(4663, down), /HTTP 503/);
  const empty = (async () => Response.json({ assets: [] })) as typeof fetch;
  await assert.rejects(catalogFor(4663, empty), /empty/);
});
