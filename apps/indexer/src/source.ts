import type { Log, PublicClient } from "viem";
import type { Hex } from "@sealdesk/shared";

export interface BlockHeader {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
}

/** Everything the indexer reads from the chain. Faked in tests with real ABI-encoded logs. */
export interface ChainSource {
  getBlockNumber(): Promise<bigint>;
  getBlock(n: bigint): Promise<BlockHeader>;
  getLogs(addresses: Hex[], fromBlock: bigint, toBlock: bigint): Promise<Log[]>;
  getTransactionInput(hash: Hex): Promise<Hex | null>;
}

export class ViemChainSource implements ChainSource {
  private readonly client: PublicClient;
  constructor(client: PublicClient) {
    this.client = client;
  }
  getBlockNumber() {
    return this.client.getBlockNumber();
  }
  async getBlock(n: bigint): Promise<BlockHeader> {
    const b = await this.client.getBlock({ blockNumber: n });
    return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
  }
  getLogs(addresses: Hex[], fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    return this.client.getLogs({ address: addresses, fromBlock, toBlock });
  }
  async getTransactionInput(hash: Hex): Promise<Hex | null> {
    try {
      return (await this.client.getTransaction({ hash })).input;
    } catch {
      return null;
    }
  }
}
