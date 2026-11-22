import { defineChain } from "viem";

export const BRAND = {
  name: "Forge",
  token: "FORGE",
  tagline: "Private OTC block trades",
  x: "https://x.com/forge_trade",
  xHandle: "@forge_trade",
  github: "https://github.com/forge-trade-agent/forge",
} as const;

/** Pre-launch: the site is up before the contracts are deployed. Trading pages show a "soon" card. */
export const PRELAUNCH = process.env["NEXT_PUBLIC_PRELAUNCH"] === "1";
export const API_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://127.0.0.1:8787";
export const RPC_URL = process.env["NEXT_PUBLIC_RPC_URL"] ?? "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env["NEXT_PUBLIC_CHAIN_ID"] ?? 4663);
export const CHAIN_NAME = process.env["NEXT_PUBLIC_CHAIN_NAME"] ?? "Robinhood Chain";
export const EXPLORER_URL = process.env["NEXT_PUBLIC_EXPLORER_URL"] ?? "";
/** Development only: a local burner wallet and a faucet on the dev stack. Never enabled in production builds. */
export const DEV_BURNER = process.env["NEXT_PUBLIC_DEV_BURNER"] === "1";
export const DEV_FAUCET_URL = process.env["NEXT_PUBLIC_DEV_FAUCET_URL"] ?? "";

export const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_NAME,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  ...(EXPLORER_URL ? { blockExplorers: { default: { name: "Explorer", url: EXPLORER_URL } } } : {}),
});

export const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const explorerTx = (h: string) => (EXPLORER_URL ? `${EXPLORER_URL}/tx/${h}` : null);
export const explorerAddr = (a: string) => (EXPLORER_URL ? `${EXPLORER_URL}/address/${a}` : null);
