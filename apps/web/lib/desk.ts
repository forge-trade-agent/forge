"use client";
import { createPublicClient, http, type PublicClient } from "viem";
import { Desk, ForgeApi, type Health, type Hex, type TokenFacts } from "@sealdesk/sdk";
import { API_URL, chain, PRELAUNCH, RPC_URL } from "./config";

export const api = new ForgeApi({ baseUrl: API_URL });

export const publicClient: PublicClient = createPublicClient({ chain, transport: http(RPC_URL), cacheTime: 1_000 }) as PublicClient;

let deskP: Promise<{ desk: Desk; health: Health }> | null = null;

/** Desk bound to this origin (private links are built against window.location.origin). */
export function getDesk() {
  if (PRELAUNCH) return Promise.reject(new Error("Trading opens when $FORGE launches."));
  if (!deskP) {
    deskP = api.health().then((health) => ({
      health,
      desk: new Desk(api, { chainId: health.chain.id, escrow: health.contracts.escrow, appOrigin: window.location.origin }),
    }));
    deskP.catch(() => {
      deskP = null;
    });
  }
  return deskP;
}

const tokenCache = new Map<string, Promise<TokenFacts>>();
export function tokenFacts(address: Hex): Promise<TokenFacts> {
  const k = address.toLowerCase();
  if (k === "0x0000000000000000000000000000000000000000") {
    return Promise.resolve({ address: k as Hex, hasCode: true, name: "Ether", symbol: "ETH", decimals: 18, totalSupply: null, permit: false });
  }
  let p = tokenCache.get(k);
  if (!p) {
    p = api.token(k as Hex).then((r) => r.token);
    tokenCache.set(k, p);
    p.catch(() => tokenCache.delete(k));
  }
  return p;
}

const erc20BalanceAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export async function balanceOf(token: Hex, owner: Hex): Promise<bigint> {
  if (/^0x0{40}$/.test(token)) return publicClient.getBalance({ address: owner });
  return publicClient.readContract({ address: token, abi: erc20BalanceAbi, functionName: "balanceOf", args: [owner] });
}
