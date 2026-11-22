"use client";
/**
 * Wallet connection without a framework: any injected EIP-1193 wallet, plus (development only)
 * a local burner wallet funded by the dev stack's faucet. Keys of injected wallets never touch
 * this app; the burner exists only when NEXT_PUBLIC_DEV_BURNER=1 against a local chain.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, custom, http, numberToHex, type Account, type Chain, type EIP1193Provider, type Transport, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex, TypedSigner } from "@sealdesk/sdk";
import { signerFromWallet } from "@sealdesk/sdk";
import { chain, CHAIN_ID, DEV_BURNER, DEV_FAUCET_URL, RPC_URL } from "./config";

export type Wallet = WalletClient<Transport, Chain, Account>;

interface WalletCtx {
  address: Hex | null;
  kind: "injected" | "burner" | null;
  wallet: Wallet | null;
  signer: TypedSigner | null;
  connecting: boolean;
  error: string | null;
  hasInjected: boolean;
  connect(kind?: "injected" | "burner"): Promise<void>;
  disconnect(): void;
  /** Dev stack only: fund an address with ETH and test tokens. */
  fund(address?: Hex, opts?: { eth?: boolean }): Promise<void>;
}

const Ctx = createContext<WalletCtx | null>(null);
const BURNER_KEY = "sealdesk.dev-burner.v1";

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { on?: (e: string, f: (...a: unknown[]) => void) => void; removeListener?: (e: string, f: (...a: unknown[]) => void) => void };
  }
}

async function ensureChain(p: EIP1193Provider) {
  const id = Number(await p.request({ method: "eth_chainId" }));
  if (id === CHAIN_ID) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(CHAIN_ID) }] });
  } catch {
    await p.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: numberToHex(CHAIN_ID), chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [RPC_URL] }],
    });
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Hex | null>(null);
  const [kind, setKind] = useState<"injected" | "burner" | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [signer, setSigner] = useState<TypedSigner | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasInjected, setHasInjected] = useState(false);

  useEffect(() => setHasInjected(typeof window !== "undefined" && !!window.ethereum), []);

  const useBurner = useCallback(() => {
    let pk: Hex | null = null;
    try {
      pk = window.localStorage.getItem(BURNER_KEY) as Hex | null;
      if (!pk) {
        pk = generatePrivateKey();
        window.localStorage.setItem(BURNER_KEY, pk);
      }
    } catch {
      pk = generatePrivateKey();
    }
    const account = privateKeyToAccount(pk);
    const w = createWalletClient({ account, chain, transport: http(RPC_URL) });
    setWallet(w);
    setSigner(account);
    setAddress(account.address.toLowerCase() as Hex);
    setKind("burner");
  }, []);

  const connect = useCallback(
    async (k: "injected" | "burner" = DEV_BURNER && !window.ethereum ? "burner" : "injected") => {
      setError(null);
      setConnecting(true);
      try {
        if (k === "burner") {
          if (!DEV_BURNER) throw new Error("Burner wallet is only available on the local dev stack");
          useBurner();
          return;
        }
        const p = window.ethereum;
        if (!p) throw new Error("No browser wallet found. Install one, then reload.");
        const [acct] = (await p.request({ method: "eth_requestAccounts" })) as Hex[];
        if (!acct) throw new Error("Wallet returned no account");
        await ensureChain(p);
        const w = createWalletClient({ account: acct, chain, transport: custom(p) });
        setWallet(w as Wallet);
        setSigner(signerFromWallet(w as never));
        setAddress(acct.toLowerCase() as Hex);
        setKind("injected");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setConnecting(false);
      }
    },
    [useBurner],
  );

  const disconnect = useCallback(() => {
    setAddress(null);
    setWallet(null);
    setSigner(null);
    setKind(null);
  }, []);

  // Follow account / chain changes in injected wallets.
  useEffect(() => {
    const p = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!p?.on || kind !== "injected") return;
    const onAccounts = (...a: unknown[]) => {
      const list = a[0] as string[];
      if (!list?.length) disconnect();
      else void connect("injected");
    };
    const onChain = () => void connect("injected");
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [kind, connect, disconnect]);

  const fund = useCallback(
    async (to?: Hex, opts: { eth?: boolean } = {}) => {
      if (!DEV_FAUCET_URL) throw new Error("No dev faucet configured");
      const target = to ?? address;
      if (!target) throw new Error("Connect a wallet first");
      const r = await fetch(`${DEV_FAUCET_URL}/fund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: target, eth: opts.eth ?? true }),
      });
      if (!r.ok) throw new Error(`faucet: ${r.status}`);
    },
    [address],
  );

  const value = useMemo(
    () => ({ address, kind, wallet, signer, connecting, error, hasInjected, connect, disconnect, fund }),
    [address, kind, wallet, signer, connecting, error, hasInjected, connect, disconnect, fund],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}
