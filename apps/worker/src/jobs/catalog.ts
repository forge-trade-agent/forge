/**
 * The market list, from the issuer instead of by hand.
 *  - Mainnet (4663): Robinhood's own asset list, https://api.robinhood.com/rhj/assets, which gives each
 *    Robinhood Stock Token's symbol, name, contract, decimals and logo. A token with the same ticker at
 *    another address is not a Robinhood Stock Token, so only these addresses are listed.
 *  - Testnet (46630): the five test stock tokens Robinhood's faucet hands out (one issuer, checked on
 *    the explorer). There is no public list for testnet.
 * The sync upserts by contract address, never deletes (open blocks may still point at a market), and
 * keeps the big names at the top in a fixed order.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { markets, type AnyDb } from "@sealdesk/db";
import type { Hex } from "@sealdesk/shared";

export const ROBINHOOD_ASSETS_URL = "https://api.robinhood.com/rhj/assets";
export const MAINNET_CHAIN_ID = 4663;
export const TESTNET_CHAIN_ID = 46630;

export interface CatalogEntry {
  symbol: string;
  name: string;
  kind: "stock" | "etf";
  token: Hex;
  decimals: number;
  logoUrl: string | null;
}

/** Listed first, in this order. Everything else follows alphabetically. */
export const TOP_ORDER = [
  "TSLA", "NVDA", "AAPL", "AMZN", "META", "MSFT", "GOOGL", "SPY", "QQQ", "COIN", "AMD", "NFLX", "PLTR", "AVGO",
  "MSTR", "ORCL", "TSM", "JPM", "V", "COST", "UBER", "SHOP", "CRWD", "NET", "LLY", "XOM", "GLD", "SLV",
];

/** Exchange-traded funds in the Robinhood list (the API does not mark them). */
const ETFS = new Set(["SPY", "QQQ", "VTI", "SCHD", "SGOV", "SHY", "BND", "GLD", "SLV", "USO", "GDX", "SMH", "SOXX", "XLK", "INDA", "EWT", "EWY", "SPMO"]);

const Asset = z.object({
  tokenSymbol: z.string().min(1).max(16),
  tokenName: z.string().min(1).max(160),
  status: z.string(),
  tokenDecimals: z.number().int().min(0).max(36),
  logoUrl: z.string().url().nullish(),
  deployments: z.array(z.object({ contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chainId: z.number().int() })),
});
const Assets = z.object({ assets: z.array(z.unknown()) });

/** "Tesla • Robinhood Token" -> "Tesla" */
const cleanName = (n: string) => n.replace(/\s*•\s*Robinhood Token\s*$/i, "").trim();

/** Parses Robinhood's asset list into entries for one chain. Malformed or inactive rows are skipped. */
export function parseRobinhoodAssets(json: unknown, chainId = MAINNET_CHAIN_ID): CatalogEntry[] {
  const { assets } = Assets.parse(json);
  const out: CatalogEntry[] = [];
  for (const raw of assets) {
    const r = Asset.safeParse(raw);
    if (!r.success || r.data.status !== "ASSET_STATUS_ACTIVE") continue;
    const dep = r.data.deployments.find((d) => d.chainId === chainId);
    if (!dep) continue;
    const symbol = r.data.tokenSymbol.toUpperCase();
    out.push({
      symbol,
      name: cleanName(r.data.tokenName),
      kind: ETFS.has(symbol) ? "etf" : "stock",
      token: dep.contractAddress.toLowerCase() as Hex,
      decimals: r.data.tokenDecimals,
      logoUrl: r.data.logoUrl ?? null,
    });
  }
  return out;
}

export async function fetchRobinhoodCatalog(fetchImpl: typeof fetch = fetch, chainId = MAINNET_CHAIN_ID): Promise<CatalogEntry[]> {
  const res = await fetchImpl(ROBINHOOD_ASSETS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Robinhood asset list: HTTP ${res.status}`);
  const list = parseRobinhoodAssets(await res.json(), chainId);
  if (list.length === 0) throw new Error("Robinhood asset list is empty");
  return list;
}

/** Robinhood Chain testnet: the faucet's test stock tokens (issuer 0x2DD5…e5Da, implementation "Stock"). */
export const TESTNET_CATALOG: CatalogEntry[] = [
  { symbol: "TSLA", name: "Tesla", kind: "stock", token: "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e", decimals: 18, logoUrl: null },
  { symbol: "AMZN", name: "Amazon", kind: "stock", token: "0x5884ad2f920c162cfbbacc88c9c51aa75ec09e02", decimals: 18, logoUrl: null },
  { symbol: "PLTR", name: "Palantir Technologies", kind: "stock", token: "0x1fbe1a0e43594b3455993b5de5fd0a7a266298d0", decimals: 18, logoUrl: null },
  { symbol: "NFLX", name: "Netflix", kind: "stock", token: "0x3b8262a63d25f0477c4dde23f83cfe22cb768c93", decimals: 18, logoUrl: null },
  { symbol: "AMD", name: "AMD", kind: "stock", token: "0x71178bac73cbeb415514eb542a8995b82669778d", decimals: 18, logoUrl: null },
];

/** The list for a chain: fetched for mainnet, fixed for testnet, none elsewhere. */
export async function catalogFor(chainId: number, fetchImpl: typeof fetch = fetch): Promise<CatalogEntry[]> {
  if (chainId === MAINNET_CHAIN_ID) return fetchRobinhoodCatalog(fetchImpl);
  if (chainId === TESTNET_CHAIN_ID) return TESTNET_CATALOG;
  return [];
}

export function sortOrderOf(symbol: string, alphaIndex: number): number {
  const i = TOP_ORDER.indexOf(symbol);
  return i >= 0 ? i + 1 : 100 + alphaIndex;
}

/** Upserts the list into `markets`. Returns how many rows were written. */
export async function syncCatalog(db: AnyDb, opts: { chainId: number; entries: CatalogEntry[]; now: Date }): Promise<{ upserted: number }> {
  const alpha = [...opts.entries].sort((a, b) => a.symbol.localeCompare(b.symbol));
  let n = 0;
  for (const [i, e] of alpha.entries()) {
    const values = {
      chainId: opts.chainId,
      symbol: e.symbol,
      name: e.name,
      kind: e.kind,
      tokenAddress: e.token,
      decimals: e.decimals,
      logoUrl: e.logoUrl,
      underlyingSymbol: e.symbol,
      exchange: null,
      permitSupported: false,
      featured: TOP_ORDER.includes(e.symbol),
      sortOrder: sortOrderOf(e.symbol, i),
      verifiedAt: opts.now,
    };
    await db
      .insert(markets)
      .values(values)
      .onConflictDoUpdate({
        target: [markets.chainId, markets.tokenAddress],
        set: {
          symbol: sql`excluded.symbol`, name: sql`excluded.name`, kind: sql`excluded.kind`, decimals: sql`excluded.decimals`,
          logoUrl: sql`excluded.logo_url`, underlyingSymbol: sql`excluded.underlying_symbol`, featured: sql`excluded.featured`,
          sortOrder: sql`excluded.sort_order`, verifiedAt: sql`excluded.verified_at`,
        },
      });
    n++;
  }
  return { upserted: n };
}
