import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  fallback,
  http,
  type Chain,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toOnChainTerms } from "@sealdesk/crypto";
import { otcEscrowAbi, type Hex, type OnChainDealStatus, type PermitWire, type Terms } from "@sealdesk/shared";

export interface DeliverForArgs {
  terms: Terms;
  permit: PermitWire | null;
  authDeadline: bigint;
  signature: Hex;
}

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface MinedReceipt {
  status: "success" | "reverted";
  gasUsed: bigint;
  blockNumber: bigint;
}

/** Everything the relayer does on-chain. Faked in tests. */
export interface RelayChain {
  readonly address: Hex;
  dealStatus(dealId: Hex): Promise<OnChainDealStatus>;
  /** Simulates and estimates gas; throws SimulationError with the revert reason. */
  simulate(args: DeliverForArgs): Promise<{ gas: bigint }>;
  fees(): Promise<Fees>;
  pendingNonce(): Promise<bigint>;
  send(args: DeliverForArgs, opts: { nonce: bigint; gas: bigint } & Fees): Promise<Hex>;
  receipt(hash: Hex): Promise<MinedReceipt | null>;
  balance(): Promise<bigint>;
}

export class SimulationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SimulationError";
  }
}

const NO_PERMIT = {
  value: 0n,
  deadline: 0n,
  v: 0,
  r: `0x${"0".repeat(64)}` as Hex,
  s: `0x${"0".repeat(64)}` as Hex,
};

function callArgs(a: DeliverForArgs) {
  const permit = a.permit
    ? { value: BigInt(a.permit.value), deadline: BigInt(a.permit.deadline), v: a.permit.v, r: a.permit.r, s: a.permit.s }
    : NO_PERMIT;
  return [toOnChainTerms(a.terms), permit, a.authDeadline, a.signature] as const;
}

export class ViemRelayChain implements RelayChain {
  readonly address: Hex;
  private readonly pub: PublicClient;
  private readonly wallet;
  private readonly escrow: Hex;

  constructor(pub: PublicClient, chain: Chain, rpcUrls: string[], privateKey: Hex, escrow: Hex) {
    const account = privateKeyToAccount(privateKey);
    this.address = account.address.toLowerCase() as Hex;
    this.pub = pub;
    this.escrow = escrow;
    this.wallet = createWalletClient({ account, chain, transport: fallback(rpcUrls.map((u) => http(u, { timeout: 10_000 }))) });
  }

  async dealStatus(dealId: Hex): Promise<OnChainDealStatus> {
    const s = await this.pub.readContract({ address: this.escrow, abi: otcEscrowAbi, functionName: "status", args: [dealId] });
    return (["none", "payment_locked", "settled", "refunded"] as const)[Number(s)] ?? "none";
  }

  async simulate(a: DeliverForArgs): Promise<{ gas: bigint }> {
    try {
      await this.pub.simulateContract({
        address: this.escrow,
        abi: otcEscrowAbi,
        functionName: "deliverFor",
        args: callArgs(a),
        account: this.wallet.account,
      });
      const gas = await this.pub.estimateContractGas({
        address: this.escrow,
        abi: otcEscrowAbi,
        functionName: "deliverFor",
        args: callArgs(a),
        account: this.wallet.account,
      });
      return { gas: (gas * 12n) / 10n }; // 20% headroom
    } catch (err) {
      if (err instanceof BaseError) {
        const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
        if (revert instanceof ContractFunctionRevertedError) {
          throw new SimulationError(revert.data?.errorName ?? revert.reason ?? "reverted");
        }
      }
      throw err; // transport errors are retried, not treated as reverts
    }
  }

  async fees(): Promise<Fees> {
    const f = await this.pub.estimateFeesPerGas();
    return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
  }

  pendingNonce(): Promise<bigint> {
    return this.pub.getTransactionCount({ address: this.address, blockTag: "pending" }).then(BigInt);
  }

  send(a: DeliverForArgs, o: { nonce: bigint; gas: bigint } & Fees): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.escrow,
      abi: otcEscrowAbi,
      functionName: "deliverFor",
      args: callArgs(a),
      nonce: Number(o.nonce),
      gas: o.gas,
      maxFeePerGas: o.maxFeePerGas,
      maxPriorityFeePerGas: o.maxPriorityFeePerGas,
      chain: this.wallet.chain,
    });
  }

  async receipt(hash: Hex): Promise<MinedReceipt | null> {
    try {
      const r = await this.pub.getTransactionReceipt({ hash });
      return { status: r.status, gasUsed: r.gasUsed, blockNumber: r.blockNumber };
    } catch {
      return null;
    }
  }

  balance(): Promise<bigint> {
    return this.pub.getBalance({ address: this.address });
  }
}
