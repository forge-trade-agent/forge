/**
 * Deal identity and EIP-712 typed data shared by the web app, SDK, MCP server, API and relayer.
 * Must stay byte-for-byte compatible with OtcEscrow.sol.
 */
import {
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import type { Terms } from "@sealdesk/shared/schemas";

export interface TermsOnChain {
  buyer: Address;
  seller: Address;
  token: Address;
  amount: bigint;
  payToken: Address;
  price: bigint;
  sellerPayout: Address;
  referrer: Address;
  relayerFee: bigint;
  deadline: bigint;
  salt: Hex;
}

export const TERMS_ABI_TUPLE = {
  type: "tuple",
  components: [
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "payToken", type: "address" },
    { name: "price", type: "uint256" },
    { name: "sellerPayout", type: "address" },
    { name: "referrer", type: "address" },
    { name: "relayerFee", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export function toOnChainTerms(t: Terms): TermsOnChain {
  return {
    buyer: t.buyer,
    seller: t.seller,
    token: t.token,
    amount: BigInt(t.amount),
    payToken: t.payToken,
    price: BigInt(t.price),
    sellerPayout: t.sellerPayout,
    referrer: t.referrer,
    relayerFee: BigInt(t.relayerFee),
    deadline: BigInt(t.deadline),
    salt: t.salt,
  };
}

/** keccak256(abi.encode(terms)) — identical to OtcEscrow.dealIdOf. */
export function dealIdOf(t: Terms | TermsOnChain): Hex {
  const on = typeof t.amount === "string" ? toOnChainTerms(t as Terms) : (t as TermsOnChain);
  return keccak256(encodeAbiParameters([TERMS_ABI_TUPLE], [on]));
}

export function escrowDomain(chainId: number, escrow: Address): TypedDataDomain {
  return { name: "OtcEscrow", version: "1", chainId, verifyingContract: escrow };
}

export const ANSWER_TYPES = {
  Terms: TERMS_ABI_TUPLE.components.map((c) => ({ name: c.name, type: c.type })),
  Answer: [
    { name: "rfqId", type: "string" },
    { name: "terms", type: "Terms" },
  ],
} as const;

export const DELIVER_TYPES = {
  Deliver: [
    { name: "dealId", type: "bytes32" },
    { name: "relayer", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function answerTypedData(chainId: number, escrow: Address, rfqId: string, terms: Terms) {
  return {
    domain: escrowDomain(chainId, escrow),
    types: ANSWER_TYPES,
    primaryType: "Answer" as const,
    message: { rfqId, terms: toOnChainTerms(terms) },
  };
}

export function deliverTypedData(chainId: number, escrow: Address, dealId: Hex, relayer: Address, deadline: bigint) {
  return {
    domain: escrowDomain(chainId, escrow),
    types: DELIVER_TYPES,
    primaryType: "Deliver" as const,
    message: { dealId, relayer, deadline },
  };
}

/**
 * Who must have signed an answer:
 *  - on a bid (poster buys), the answer comes from the seller;
 *  - on a listing (poster sells), the answer comes from the buyer.
 */
export function expectedAnswerSigner(side: "buy" | "sell", t: Terms): Address {
  return side === "buy" ? t.seller : t.buyer;
}

export async function recoverAnswerSigner(
  chainId: number,
  escrow: Address,
  rfqId: string,
  terms: Terms,
  signature: Hex,
): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({ ...answerTypedData(chainId, escrow, rfqId, terms), signature });
  } catch {
    return null;
  }
}

export async function recoverDeliverSigner(
  chainId: number,
  escrow: Address,
  dealId: Hex,
  relayer: Address,
  deadline: bigint,
  signature: Hex,
): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({ ...deliverTypedData(chainId, escrow, dealId, relayer, deadline), signature });
  } catch {
    return null;
  }
}
