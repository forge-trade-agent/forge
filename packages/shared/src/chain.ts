import { createPublicClient, defineChain, fallback, http, type Chain, type PublicClient } from "viem";

export interface ChainConfig {
  CHAIN_ID: number;
  CHAIN_NAME: string;
  RPC_URLS: string[];
  EXPLORER_URL?: string | undefined;
}

export function chainFromEnv(env: ChainConfig): Chain {
  return defineChain({
    id: env.CHAIN_ID,
    name: env.CHAIN_NAME,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: env.RPC_URLS } },
    ...(env.EXPLORER_URL ? { blockExplorers: { default: { name: "Explorer", url: env.EXPLORER_URL } } } : {}),
  });
}

/** Public client with ranked fallback across every configured RPC. */
export function publicClientFromEnv(env: ChainConfig): PublicClient {
  const chain = chainFromEnv(env);
  return createPublicClient({
    chain,
    transport: fallback(
      env.RPC_URLS.map((url) => http(url, { timeout: 10_000, retryCount: 2 })),
      { rank: { interval: 60_000 } },
    ),
  });
}
