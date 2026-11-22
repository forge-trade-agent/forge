import type { PublicClient } from "viem";
import type { Logger } from "pino";

/**
 * Refuse to start against the wrong network or an address with no code.
 * Every chain-facing service runs this before doing anything else.
 */
export async function chainPreflight(
  client: PublicClient,
  log: Logger,
  expected: { chainId: number; contracts: Record<string, `0x${string}`> },
): Promise<{ head: bigint }> {
  const chainId = await client.getChainId();
  if (chainId !== expected.chainId) {
    throw new Error(`RPC is on chain ${chainId}, expected ${expected.chainId}`);
  }
  for (const [name, addr] of Object.entries(expected.contracts)) {
    const code = await client.getCode({ address: addr });
    if (!code || code === "0x") throw new Error(`${name} at ${addr} has no code on chain ${chainId}`);
  }
  const head = await client.getBlockNumber();
  log.info({ chainId, head: head.toString(), contracts: expected.contracts }, "chain preflight ok");
  return { head };
}
