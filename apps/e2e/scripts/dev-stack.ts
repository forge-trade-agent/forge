/**
 * Local development stack for the web app (NOT for production):
 *   anvil forked from Robinhood Chain mainnet (4663) + Forge contracts + API on :8787 +
 *   indexer/relayer/worker loops + dev faucet on :8788, then writes apps/web/.env.local.
 * Markets are Robinhood's own Stock Token list (real contracts on the fork) and prices come from their
 * real DEX pools. Only $FORGE is a local stand-in, because it has not launched yet.
 * Needs internet. FORK_URL overrides the RPC (the public one is rate-limited).
 *
 *   node apps/e2e/scripts/dev-stack.ts
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markets } from "@sealdesk/db";
import type { Hex } from "@sealdesk/shared";
import { Desk } from "@sealdesk/sdk";
import { sweepExpired } from "../../worker/src/jobs/lifecycle.ts";
import { fetchRobinhoodCatalog, syncCatalog } from "../../worker/src/jobs/catalog.ts";
import { AlphaVantageProvider, refreshReferencePrices, snapshotDex } from "../../worker/src/jobs/market.ts";
import { trackBurn, trackControl, ViemContractsReader } from "../../worker/src/jobs/onchain.ts";
import { NotifyDispatcher } from "../../worker/src/jobs/notify.ts";
import { findAnvil, startStack } from "../test/stack.ts";

const API_PORT = 8787;
const FAUCET_PORT = 8788;
const ANVIL_PORT = 8545;
const WEB_ORIGIN = process.env["WEB_ORIGIN"] ?? "http://localhost:3000";

const anvil = findAnvil();
if (!anvil) {
  console.error("anvil not found: install Foundry or set ANVIL_BIN");
  process.exit(1);
}

// Operator token for /admin on this dev stack: made once, kept in apps/e2e/.dev-admin-token (never commit it).
const adminFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.dev-admin-token");
const adminToken = existsSync(adminFile) ? readFileSync(adminFile, "utf8").trim() : randomBytes(24).toString("base64url");
if (!existsSync(adminFile)) writeFileSync(adminFile, `${adminToken}\n`, { mode: 0o600 });

// ---------------------------------------------------------------- real markets on a mainnet fork
const FORK_URL = process.env["FORK_URL"] ?? "https://rpc.mainnet.chain.robinhood.com";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Hex; // Paxos USDG on Robinhood Chain
console.log(`fetching Robinhood's stock token list and forking ${FORK_URL} …`);
const catalog = await fetchRobinhoodCatalog();
const tslaEntry = catalog.find((e) => e.symbol === "TSLA");
if (!tslaEntry) throw new Error("TSLA missing from Robinhood's list");

/** An address holding `token` on the fork: the deepest Uniswap v2/v3 pool DexScreener knows. */
const holders = new Map<string, Hex | null>();
async function holderOf(token: Hex): Promise<Hex | null> {
  const k = token.toLowerCase();
  if (holders.has(k)) return holders.get(k)!;
  let found: Hex | null = null;
  try {
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${k}`, { signal: AbortSignal.timeout(15_000) });
    const pairs = r.ok ? ((await r.json()) as { pairAddress: string; liquidity?: { usd?: number } }[]) : [];
    const pools = pairs.filter((p) => /^0x[0-9a-fA-F]{40}$/.test(p.pairAddress)).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    found = (pools[0]?.pairAddress.toLowerCase() as Hex | undefined) ?? null;
  } catch {
    found = null;
  }
  holders.set(k, found);
  return found;
}

const s = await startStack(anvil, {
  corsOrigins: [WEB_ORIGIN, "http://127.0.0.1:3000"], apiPort: API_PORT, anvilPort: ANVIL_PORT, adminToken,
  fork: { url: FORK_URL, usd: USDG, tsla: tslaEntry.token, holderOf },
});
console.log(`admin: http://localhost:3000/admin (token in ${adminFile})`);

// ---------------------------------------------------------------- markets
// Robinhood's list, exactly as the worker syncs it in production.
const synced = await syncCatalog(s.db, { chainId: 4663, entries: catalog, now: new Date() });
// The desk's own token, listed first. A local stand-in until $FORGE launches; it has no pool,
// so the site shows "not launched".
await s.db.insert(markets).values({ chainId: 4663, symbol: "FORGE", name: "Forge", kind: "token", tokenAddress: s.seal, decimals: 18, exchange: "Not launched", permitSupported: true, featured: true, sortOrder: 0, verifiedAt: new Date() });

// Real prices from the real pools (DexScreener), now and every 2 minutes.
const refreshPrices = () =>
  snapshotDex(s.db, { chainId: 4663, slug: "robinhood", extraTokens: [], now: new Date() }).catch((err: Error) => console.error("[prices]", err.message));
const priced = await refreshPrices();
setInterval(refreshPrices, 120_000);
// Delayed listing candles for the charts need an Alpha Vantage key (free tier is enough to try).
const av = process.env["ALPHAVANTAGE_API_KEY"];
if (av) {
  const provider = new AlphaVantageProvider(av);
  const refreshCandles = () => refreshReferencePrices(s.db, s.ctx.cache, provider, 4663).catch((err: Error) => console.error("[candles]", err.message));
  void refreshCandles();
  setInterval(refreshCandles, 300_000);
}

// ---------------------------------------------------------------- background loops
const reader = new ViemContractsReader(s.pub, s.escrow, s.vault);
// Alerts are printed here instead of sent: no bot token or mail server in local dev.
const mask = (d: string) => (d.length > 6 ? `${d.slice(0, 3)}…${d.slice(-3)}` : "…");
const notifier = new NotifyDispatcher({
  db: s.db, bus: s.bus, cache: s.ctx.cache, key: new Uint8Array(32).fill(1), log: { warn: (o: unknown, m: string) => console.error("[notify]", m, o) } as never,
  senders: {
    telegram: async (chat, text) => console.error(`[notify] telegram → ${mask(chat)}: ${text}`),
    email: async (to, subject) => console.error(`[notify] email → ${mask(to)}: ${subject}`),
    webhook: async (url, payload) => console.error(`[notify] webhook → ${new URL(url).host}: ${JSON.stringify(payload)}`),
  },
});
const loop = async () => {
  try {
    await s.indexAll();
    while ((await s.relayer.processNext("dev", 0)) !== null) {
      /* drain relay queue */
    }
    await sweepExpired(s.db, s.bus, new Date());
    await notifier.drain(0);
    await trackBurn(reader, s.ctx.cache, { chainId: 4663, vault: s.vault, platformToken: s.seal, assets: ["0x0000000000000000000000000000000000000000", s.usd], now: new Date() });
    await trackControl(s.pub, s.ctx.cache, { chainId: 4663, escrow: s.escrow, vault: s.vault, stable: s.usd, platformToken: s.seal, relayer: s.relayerAddress, now: new Date() });
  } catch (err) {
    console.error("[dev-stack loop]", (err as Error).message);
  }
  setTimeout(loop, 1500);
};
void loop();

// ---------------------------------------------------------------- dev faucet (local only)
// Real tokens are borrowed from pools on the fork (local only, nothing leaves this machine).
const FAUCET_TOKENS = ["TSLA", "NVDA", "AAPL", "AMZN", "META", "MSFT", "GOOGL", "SPY", "QQQ", "COIN"];
createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", WEB_ORIGIN);
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return void res.end();
  if (req.method !== "POST" || req.url !== "/fund") return void res.writeHead(404).end();
  let body = "";
  for await (const c of req) body += c;
  const { address, eth = true } = JSON.parse(body || "{}") as { address?: string; eth?: boolean };
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return void res.writeHead(400).end("bad address");
  const a = address.toLowerCase() as Hex;
  if (eth) await s.rpc("anvil_setBalance", [a, "0x8ac7230489e80000"]); // 10 ETH (Ghost-mode wallets get tokens only)
  const got: string[] = [];
  const give = async (sym: string, token: Hex, amount: bigint) => {
    try {
      await s.mint(token, a, amount);
      got.push(sym);
    } catch {
      /* no pool to borrow from: skip this one */
    }
  };
  await give("USDG", s.usd, 50_000n * 10n ** 6n);
  await give("FORGE", s.seal, 1_000_000n * 10n ** 18n);
  for (const e of catalog.filter((x) => FAUCET_TOKENS.includes(x.symbol))) await give(e.symbol, e.token, 10n * 10n ** 18n);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ funded: a, tokens: got }));
}).listen(FAUCET_PORT, "127.0.0.1");

// ---------------------------------------------------------------- web env
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/.env.local");
writeFileSync(
  envFile,
  [
    `NEXT_PUBLIC_API_URL=http://127.0.0.1:${API_PORT}`,
    `NEXT_PUBLIC_RPC_URL=${s.url}`,
    `NEXT_PUBLIC_CHAIN_ID=4663`,
    `NEXT_PUBLIC_CHAIN_NAME=Robinhood Chain (local fork)`,
    `NEXT_PUBLIC_DEV_FAUCET_URL=http://127.0.0.1:${FAUCET_PORT}`,
    `NEXT_PUBLIC_DEV_BURNER=1`,
    "",
  ].join("\n"),
);

console.log(`
dev stack ready
  chain   ${s.url} (id 4663, fork of ${FORK_URL})
  api     ${s.apiUrl}
  faucet  http://127.0.0.1:${FAUCET_PORT}/fund
  escrow  ${s.escrow}
  vault   ${s.vault}
  USDG    ${s.usd}
  markets ${synced.upserted} Robinhood Stock Tokens + FORGE (local) · ${priced && "written" in priced ? priced.written : 0} priced from DEX pools
  wrote   ${envFile}
`);

const stop = async () => {
  await s.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
