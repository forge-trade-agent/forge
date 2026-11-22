/**
 * Full local stack on a real EVM: anvil + compiled contracts + API (PGlite) + indexer + relayer.
 * Requires Foundry's anvil (ANVIL_BIN, PATH, or ~/.foundry/bin) and `forge build` output in contracts/out.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Abi,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { MIGRATIONS_DIR, schema, type AnyDb } from "@sealdesk/db";
import { MemoryCache, MemoryEventBus, MemoryLocks, MemoryRateLimiter, MemoryRelayQueue, ViemChainReader } from "@sealdesk/infra";
import { createLogger, hashToken, type Hex } from "@sealdesk/shared";
import { buildApp } from "../../api/src/app.ts";
import type { Ctx } from "../../api/src/context.ts";
import { Indexer } from "../../indexer/src/indexer.ts";
import { ViemChainSource } from "../../indexer/src/source.ts";
import { ViemRelayChain } from "../../relayer/src/chain.ts";
import { Relayer } from "../../relayer/src/relayer.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const CHAIN_ID = 4663;

export function findAnvil(): string | null {
  const exe = process.platform === "win32" ? "anvil.exe" : "anvil";
  const candidates = [process.env["ANVIL_BIN"], path.join(homedir(), ".foundry", "bin", exe)];
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) candidates.push(path.join(dir, exe));
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const p = path.join(ROOT, "contracts", "out", file, `${name}.json`);
  if (!existsSync(p)) throw new Error(`missing ${p}: run \`forge build\` in contracts/`);
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function startAnvil(bin: string, fixedPort?: number, forkUrl?: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = fixedPort ?? 20_000 + Math.floor(Math.random() * 20_000);
  const args = ["--port", String(port), "--chain-id", String(CHAIN_ID), "--silent", ...(forkUrl ? ["--fork-url", forkUrl] : [])];
  const proc = spawn(bin, args, { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < (forkUrl ? 600 : 100); i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return { url, proc };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("anvil did not start");
}

export type Wallet = WalletClient<Transport, Chain, Account>;

export interface Party {
  account: PrivateKeyAccount;
  address: Hex;
  wallet: Wallet;
}

export interface Stack {
  url: string;
  chain: Chain;
  pub: PublicClient;
  rpc(method: string, params: unknown[]): Promise<unknown>;
  apiUrl: string;
  ctx: Ctx;
  db: AnyDb;
  pg: PGlite;
  bus: MemoryEventBus;
  indexer: Indexer;
  relayer: Relayer;
  relayerAddress: Hex;
  escrow: Hex;
  vault: Hex;
  usd: Hex;
  tsla: Hex;
  seal: Hex;
  erc20: Abi;
  buyer: Party;
  seller: Party;
  newParty(eth?: bigint): Promise<Party>;
  deployToken(name: string, symbol: string, decimals: number): Promise<Hex>;
  mint(token: Hex, to: Hex, amount: bigint): Promise<void>;
  indexAll(): Promise<void>;
  close(): Promise<void>;
}

export interface StackOptions {
  corsOrigins?: string[];
  apiPort?: number;
  anvilPort?: number;
  /** Operator token for /admin on this stack. */
  adminToken?: string;
  /**
   * Run on a fork of a live chain instead of an empty one: the stable and the stock tokens are the
   * chain's real contracts. `holderOf` names an address that holds a token (for example a pool), so
   * `mint` can move real tokens to test wallets by impersonating it.
   */
  fork?: { url: string; usd: Hex; tsla: Hex; holderOf(token: Hex): Promise<Hex | null> };
}

export async function startStack(anvilBin: string, opts: StackOptions = {}): Promise<Stack> {
  const { url, proc } = await startAnvil(anvilBin, opts.anvilPort, opts.fork?.url);
  const chain = defineChain({
    id: CHAIN_ID,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  // cacheTime 0: always read the latest head (viem caches eth_blockNumber for ~4s by default).
  const pub = createPublicClient({ chain, transport: http(url), cacheTime: 0 }) as PublicClient;
  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return ((await r.json()) as { result: unknown }).result;
  };

  const party = async (eth = 100n * 10n ** 18n, pk: Hex = generatePrivateKey()): Promise<Party> => {
    const account = privateKeyToAccount(pk);
    if (eth > 0n) await rpc("anvil_setBalance", [account.address, `0x${eth.toString(16)}`]);
    return { account, address: account.address.toLowerCase() as Hex, wallet: createWalletClient({ account, chain, transport: http(url) }) };
  };

  const deployer = await party();
  const deploy = async (file: string, name: string, args: unknown[]): Promise<Hex> => {
    const a = artifact(file, name);
    const hash = await deployer.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.contractAddress!.toLowerCase() as Hex;
  };

  const mockErc20 = artifact("Mocks.sol", "MockERC20").abi;
  const usd = opts.fork ? (opts.fork.usd.toLowerCase() as Hex) : await deploy("Mocks.sol", "MockERC20", ["USD Global", "USDG", 6]);
  const tsla = opts.fork ? (opts.fork.tsla.toLowerCase() as Hex) : await deploy("Mocks.sol", "MockERC20", ["Tesla", "TSLA", 18]);
  const mocks = new Set<string>(opts.fork ? [] : [usd, tsla]);
  const seal = await deploy("Mocks.sol", "MockERC20", ["Forge", "FORGE", 18]);
  mocks.add(seal);
  const vault = await deploy("BuyBurnVault.sol", "BuyBurnVault", [seal, deployer.address, deployer.address]);
  const escrow = await deploy("OtcEscrow.sol", "OtcEscrow", [
    usd, [10_000n * 10n ** 6n, 100_000n * 10n ** 6n], [4n * 10n ** 18n, 40n * 10n ** 18n], vault, seal, 1_000_000n * 10n ** 18n,
  ]);
  const deployBlock = await pub.getBlockNumber();

  const mint = async (token: Hex, to: Hex, amount: bigint) => {
    if (opts.fork && !mocks.has(token.toLowerCase())) return fundFromHolder(token, to, amount);
    const hash = await deployer.wallet.writeContract({ address: token, abi: mockErc20, functionName: "mint", args: [to, amount] });
    await pub.waitForTransactionReceipt({ hash });
  };
  /** Fork only: move real tokens from a holder (impersonated), at most a quarter of what it has. */
  const fundFromHolder = async (token: Hex, to: Hex, amount: bigint) => {
    const holder = await opts.fork!.holderOf(token);
    if (!holder) throw new Error(`no holder found for ${token}`);
    const bal = (await pub.readContract({ address: token, abi: mockErc20, functionName: "balanceOf", args: [holder] })) as bigint;
    const send = amount < bal / 4n ? amount : bal / 4n;
    if (send === 0n) throw new Error(`holder ${holder} has no ${token}`);
    await rpc("anvil_impersonateAccount", [holder]);
    await rpc("anvil_setBalance", [holder, "0x8ac7230489e80000"]);
    const h = (await rpc("eth_sendTransaction", [{
      from: holder, to: token, data: encodeFunctionData({ abi: mockErc20, functionName: "transfer", args: [to, send] }),
    }])) as Hex;
    await pub.waitForTransactionReceipt({ hash: h });
    await rpc("anvil_stopImpersonatingAccount", [holder]);
  };

  const buyer = await party();
  const seller = await party();
  const relayerKey = generatePrivateKey();
  const relayerParty = await party(10n ** 18n, relayerKey);
  if (opts.fork) {
    // Real tokens: whatever a holder can spare. Not fatal if a pool is thin.
    await mint(usd, buyer.address, 10_000n * 10n ** 6n).catch(() => undefined);
    await mint(tsla, seller.address, 10n * 10n ** 18n).catch(() => undefined);
  } else {
    await mint(usd, buyer.address, 10_000_000n * 10n ** 6n);
    await mint(tsla, seller.address, 1_000_000n * 10n ** 18n);
  }

  // ---------------------------------------------------------------- API
  const pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS_DIR });
  const db = d as unknown as AnyDb;
  const bus = new MemoryEventBus();
  const relayQueue = new MemoryRelayQueue();
  const log = createLogger("e2e", process.env["E2E_LOG"] ?? "silent");
  const big = { limit: 100_000, windowMs: 60_000 };
  const ctx: Ctx = {
    db,
    chain: new ViemChainReader(pub, CHAIN_ID, escrow),
    bus,
    limiter: new MemoryRateLimiter(),
    cache: new MemoryCache(),
    relay: relayQueue,
    log,
    now: () => new Date(),
    checks: { db: async () => true, redis: async () => true },
    config: {
      chainId: CHAIN_ID,
      chainName: opts.fork ? "Robinhood Chain (local fork)" : "anvil",
      rpcUrl: url,
      escrow,
      vault,
      stable: usd,
      platformToken: seal,
      relayer: relayerParty.address,
      relayerMinFeeBps: 10,
      notifyKey: new Uint8Array(32).fill(1),
      adminTokenHash: opts.adminToken ? hashToken(opts.adminToken) : null,
      publicUrl: "http://desk.test",
      corsOrigins: opts.corsOrigins ?? [],
      version: "e2e",
      limits: { global: big, createRfq: big, createQuote: big, relay: big },
    },
  };
  const app = await buildApp(ctx);
  const apiUrl = await app.listen({ port: opts.apiPort ?? 0, host: "127.0.0.1" });

  // ---------------------------------------------------------------- indexer + relayer
  const indexer = new Indexer(db, new ViemChainSource(pub), bus, log, {
    chainId: CHAIN_ID, escrow, vault, stable: usd, stableDecimals: 6, startBlock: deployBlock, confirmations: 0, batchBlocks: 500,
  });
  const relayer = new Relayer(
    { db, chain: new ViemRelayChain(pub, chain, [url], relayerKey, escrow), queue: relayQueue, locks: new MemoryLocks(), bus, log },
    { chainId: CHAIN_ID, escrow, minFeeBps: 10, maxGasPriceWei: 500n * 10n ** 9n, bumpAfterMs: 20_000, maxBumps: 2, pollMs: 100, deadlineMarginS: 60 },
  );

  return {
    url, chain, pub, rpc, apiUrl, ctx, db, pg, bus, indexer, relayer, relayerAddress: relayerParty.address,
    escrow, vault, usd, tsla, seal, erc20: mockErc20, buyer, seller,
    newParty: (eth) => party(eth),
    deployToken: async (name, symbol, decimals) => {
      const t = await deploy("Mocks.sol", "MockERC20", [name, symbol, decimals]);
      mocks.add(t);
      return t;
    },
    mint,
    async indexAll() {
      while ((await indexer.tick()) > 0) {
        /* catch up */
      }
    },
    async close() {
      await app.close();
      await pg.close();
      proc.kill();
    },
  };
}

export async function balanceOf(s: Stack, token: Hex, owner: Hex): Promise<bigint> {
  return (await s.pub.readContract({ address: token, abi: s.erc20, functionName: "balanceOf", args: [owner] })) as bigint;
}
