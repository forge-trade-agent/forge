#!/usr/bin/env node
/**
 * forge-mcp — stdio MCP server. Configure via environment:
 *   FORGE_API_URL      desk API (required)
 *   FORGE_APP_URL      web origin for links (default: API URL)
 *   FORGE_RPC_URL      chain RPC (required)
 *   FORGE_PRIVATE_KEY  0x... wallet key; stays in this process, never sent anywhere
 *   FORGE_HOME         keystore directory (default ~/.forge)
 *   FORGE_MAX_PRICE_ETH / FORGE_MAX_PRICE_USD   optional per-deal caps in base units
 * stdout carries the MCP protocol; all logs go to stderr.
 *
 *   forge-mcp autopilot <rules.json>   answer open blocks by your rules (dry run unless "live": true)
 */
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Desk } from "@sealdesk/sdk";
import { homedir } from "node:os";
import path from "node:path";
import { Autopilot, loadConfig } from "./autopilot.ts";
import { Keystore } from "./keystore.ts";
import { createMcpServer } from "./server.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`forge-mcp: ${name} is required`);
    process.exit(1);
  }
  return v;
}

const apiUrl = need("FORGE_API_URL");
const rpcUrl = need("FORGE_RPC_URL");
const pk = need("FORGE_PRIVATE_KEY");
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("forge-mcp: FORGE_PRIVATE_KEY must be 0x + 64 hex chars");
  process.exit(1);
}

const desk = await Desk.connect({ baseUrl: apiUrl }, process.env["FORGE_APP_URL"] ?? apiUrl);
const health = await desk.api.health();
const chain = defineChain({
  id: health.chain.id,
  name: health.chain.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const pub = createPublicClient({ chain, transport: http(rpcUrl) });
if ((await pub.getChainId()) !== health.chain.id) {
  console.error(`forge-mcp: RPC chain id differs from the desk's (${health.chain.id})`);
  process.exit(1);
}
const wallet = createWalletClient({ account: privateKeyToAccount(pk as `0x${string}`), chain, transport: http(rpcUrl) });

const maxPrice: Record<string, bigint> = {};
if (process.env["FORGE_MAX_PRICE_ETH"]) maxPrice["0x0000000000000000000000000000000000000000"] = BigInt(process.env["FORGE_MAX_PRICE_ETH"]);
if (process.env["FORGE_MAX_PRICE_USD"]) maxPrice[health.contracts.stable] = BigInt(process.env["FORGE_MAX_PRICE_USD"]);

const keystore = new Keystore();

if (process.argv[2] === "autopilot") {
  // Autopilot: answer open blocks by the rules in a JSON file, then complete accepted deals.
  const rulesFile = process.argv[3];
  if (!rulesFile) {
    console.error("usage: forge-mcp autopilot <rules.json>");
    process.exit(1);
  }
  let cfg;
  try {
    cfg = await loadConfig(rulesFile);
  } catch (err) {
    console.error(`forge-mcp: ${(err as Error).message}`);
    process.exit(1);
  }
  const home = process.env["FORGE_HOME"] ?? path.join(homedir(), ".forge");
  const ap = new Autopilot(
    { desk, pub, wallet, keystore, stable: health.contracts.stable, stateFile: path.join(home, "autopilot.json"), log: (l) => console.error(`${new Date().toISOString()} ${l}`) },
    cfg,
  );
  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());
  await ap.run(stop.signal);
} else {
  const server = createMcpServer({ desk, pub, wallet, keystore, stable: health.contracts.stable, platformToken: health.contracts.platformToken, maxPrice });
  await server.connect(new StdioServerTransport());
  console.error(`forge-mcp ready: wallet ${wallet.account.address} on chain ${health.chain.id}`);
}
