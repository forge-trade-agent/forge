/**
 * viem implementation of ChainReader. Every read is against the configured chain and escrow;
 * nothing here trusts client-supplied data.
 */
import { decodeEventLog, erc20Abi, getAddress, parseAbi, type PublicClient } from "viem";
import { otcEscrowAbi, type ChainReader, type Hex, type OnChainDealStatus, type SettlementProof, type TokenFacts } from "@sealdesk/shared";

const permitProbeAbi = parseAbi([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function nonces(address) view returns (uint256)",
]);

const STATUS: Record<number, OnChainDealStatus> = { 0: "none", 1: "payment_locked", 2: "settled", 3: "refunded" };

export class ViemChainReader implements ChainReader {
  readonly chainId: number;
  readonly escrow: Hex;
  private readonly client: PublicClient;
  constructor(client: PublicClient, chainId: number, escrow: Hex) {
    this.client = client;
    this.chainId = chainId;
    this.escrow = escrow.toLowerCase() as Hex;
  }

  async tokenFacts(address: Hex): Promise<TokenFacts> {
    const code = await this.client.getCode({ address });
    const base: TokenFacts = {
      address: address.toLowerCase() as Hex,
      hasCode: !!code && code !== "0x",
      name: null,
      symbol: null,
      decimals: null,
      totalSupply: null,
      permit: false,
    };
    if (!base.hasCode) return base;
    // Plain parallel reads: works on any chain (no Multicall3 dependency) and a reverting
    // or missing function only nulls that one field.
    const results = await Promise.allSettled([
      this.client.readContract({ address, abi: erc20Abi, functionName: "name" }),
      this.client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      this.client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      this.client.readContract({ address, abi: erc20Abi, functionName: "totalSupply" }),
      this.client.readContract({ address, abi: permitProbeAbi, functionName: "DOMAIN_SEPARATOR" }),
      this.client.readContract({ address, abi: permitProbeAbi, functionName: "nonces", args: [this.escrow] }),
    ]);
    const ok = <T>(r: PromiseSettledResult<unknown>): T | null => (r.status === "fulfilled" ? (r.value as T) : null);
    const clean = (s: string | null) => (s === null ? null : s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64));
    return {
      ...base,
      name: clean(ok<string>(results[0]!)),
      symbol: clean(ok<string>(results[1]!)),
      decimals: ok<number>(results[2]!),
      totalSupply: ok<bigint>(results[3]!)?.toString() ?? null,
      permit: ok(results[4]!) !== null && ok(results[5]!) !== null,
    };
  }

  async dealStatus(dealId: Hex): Promise<OnChainDealStatus> {
    const s = await this.client.readContract({ address: this.escrow, abi: otcEscrowAbi, functionName: "status", args: [dealId] });
    return STATUS[Number(s)] ?? "none";
  }

  async settlementFromTx(txHash: Hex): Promise<SettlementProof | null> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash });
    } catch {
      return null;
    }
    if (receipt.status !== "success") return null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.escrow) continue;
      try {
        const ev = decodeEventLog({ abi: otcEscrowAbi, data: log.data, topics: log.topics });
        if (ev.eventName !== "Settled") continue;
        const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
        const a = ev.args;
        const lc = (x: string) => getAddress(x).toLowerCase() as Hex;
        return {
          txHash: txHash.toLowerCase() as Hex,
          blockNumber: receipt.blockNumber,
          timestamp: Number(block.timestamp),
          escrow: this.escrow,
          dealId: a.dealId,
          buyer: lc(a.buyer),
          seller: lc(a.seller),
          token: lc(a.token),
          amount: a.amount,
          payToken: lc(a.payToken),
          price: a.price,
          fee: a.fee,
          referrerFee: a.referrerFee,
          relayerFee: a.relayerFee,
          relayer: lc(a.relayer),
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  async balanceOf(token: Hex, owner: Hex): Promise<bigint> {
    if (/^0x0{40}$/.test(token)) return this.client.getBalance({ address: owner });
    return this.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  }
}
