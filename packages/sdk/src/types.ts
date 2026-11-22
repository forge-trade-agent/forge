import type { RfqPublic, Terms } from "@sealdesk/shared/schemas";

export type Hex = `0x${string}`;
export type { RfqPublic, Terms };

export interface TokenFacts {
  address: Hex;
  hasCode: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  permit: boolean;
}

export interface SealedQuoteView {
  id: string;
  status: "sealed" | "accepted" | "withdrawn" | "expired";
  createdAt: string;
  sealed: { senderEncPubKey: string; nonce: string; ciphertext: string };
}

export interface DealView {
  dealId: Hex;
  rfqId: string;
  quoteId: string;
  escrow: Hex;
  chainId: number;
  terms: Terms;
  status: "accepted" | "payment_locked" | "settled" | "refunded" | "expired";
  acceptedAt: string;
  paymentLockedAt: string | null;
  settledAt: string | null;
  settleTx: Hex | null;
  refundedAt: string | null;
  refundTx: Hex | null;
  fee: string | null;
  referrerFee: string | null;
  relayer: Hex | null;
}

export interface Health {
  ok: boolean;
  version: string;
  chain: { id: number; name: string; rpc: string };
  contracts: { escrow: Hex; feeVault: Hex; stable: Hex; platformToken: Hex };
  relayer: Hex | null;
  /** Alert channels this desk delivers, and its Telegram bot's @username. */
  notifications?: { channels: ("telegram" | "email" | "webhook")[]; telegramBot: string | null };
}

export interface Receipt {
  chainId: number;
  escrow: Hex;
  txHash: Hex;
  block: string;
  settledAt: string;
  dealId: Hex;
  buyer: Hex;
  seller: Hex;
  token: Hex;
  amount: string;
  payToken: Hex;
  price: string;
  fees: { total: string; vault: string; referrer: string; relayer: string };
  sellerProceeds: string;
  relayer: Hex | null;
}

export interface PermitWire {
  value: string;
  deadline: string;
  v: number;
  r: Hex;
  s: Hex;
}
