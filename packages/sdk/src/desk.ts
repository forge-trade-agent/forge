/**
 * High-level sealed flows. Keys never leave the caller: the SDK generates X25519 keys locally,
 * seals answers locally and decrypts answers locally. The server only ever sees ciphertext.
 */
import {
  answerTypedData,
  buildPrivateLink,
  checkAnswer,
  completeTerms,
  generateKeyPair,
  openAnswer,
  sealAnswer,
  sortAnswers,
  toB64,
  type BalanceReader,
  type CheckedAnswer,
} from "@sealdesk/crypto";
import { ZERO_ADDRESS, type RfqCreate, type SealedAnswerPlaintext } from "@sealdesk/shared/schemas";
import { ForgeApi } from "./api.ts";
import type { HttpOptions } from "./http.ts";
import type { DealView, Hex, RfqPublic, Terms } from "./types.ts";

/** Anything that can sign EIP-712 typed data: a viem LocalAccount, or a WalletClient via signerFromWallet. */
export interface TypedSigner {
  address: Hex;
  signTypedData(typedData: never): Promise<Hex>;
}

export function signerFromWallet(wallet: {
  account?: { address: Hex } | undefined;
  signTypedData(args: never): Promise<Hex>;
}): TypedSigner {
  const account = wallet.account;
  if (!account) throw new Error("wallet client has no account");
  return {
    address: account.address,
    signTypedData: (td: never) => wallet.signTypedData({ ...(td as object), account } as never),
  };
}

export interface DeskConfig {
  chainId: number;
  escrow: Hex;
  /** Web origin used to build private links (e.g. https://desk.example). */
  appOrigin: string;
}

export interface PostedBlock {
  rfq: RfqPublic;
  manageToken: string;
  /** X25519 secret: the only key that can read answers. Store it like a password. */
  secretKey: Uint8Array;
  privateLink: string;
}

export interface SentAnswer {
  quoteId: string;
  quoteToken: string;
  terms: Terms;
  privateLink: string;
}

export interface RankedAnswer extends CheckedAnswer {
  quoteId: string;
}

export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export class Desk {
  readonly api: ForgeApi;
  readonly cfg: DeskConfig;

  constructor(api: ForgeApi, cfg: DeskConfig) {
    this.api = api;
    this.cfg = { ...cfg, escrow: cfg.escrow.toLowerCase() as Hex };
  }

  /** Connect and read chain id and escrow address from the server. */
  static async connect(http: HttpOptions, appOrigin: string): Promise<Desk> {
    const api = new ForgeApi(http);
    const h = await api.health();
    return new Desk(api, { chainId: h.chain.id, escrow: h.contracts.escrow, appOrigin });
  }

  // ------------------------------------------------------------------ poster side

  async postBlock(p: Omit<RfqCreate, "encPubKey" | "allowPartial"> & { allowPartial?: boolean }): Promise<PostedBlock> {
    const keys = generateKeyPair();
    const res = await this.api.createRfq({ ...p, encPubKey: toB64(keys.publicKey) });
    return {
      rfq: res.rfq,
      manageToken: res.manageToken,
      secretKey: keys.secretKey,
      privateLink: buildPrivateLink(this.cfg.appOrigin, "rfq", res.rfq.id, keys.secretKey, res.manageToken),
    };
  }

  /** Decrypt, validate and rank every answer. Content is attacker-controlled: rely on `verdict`/`problems`. */
  async readAnswers(p: { rfqId: string; manageToken: string; secretKey: Uint8Array; balances?: BalanceReader }): Promise<RankedAnswer[]> {
    const [{ rfq }, { items }] = await Promise.all([this.api.getRfq(p.rfqId), this.api.sealedQuotes(p.rfqId, p.manageToken)]);
    const out: RankedAnswer[] = [];
    for (const q of items) {
      if (q.status !== "sealed") continue;
      const opened = openAnswer(q.sealed, p.secretKey);
      if (!opened.ok) continue; // undecryptable answers are dropped, never shown
      const checked = await checkAnswer(rfq, opened.answer, {
        chainId: this.cfg.chainId,
        escrow: this.cfg.escrow,
        now: Date.now(),
        ...(p.balances ? { balances: p.balances } : {}),
      });
      out.push({ ...checked, quoteId: q.id });
    }
    return sortAnswers(rfq.side, out) as RankedAnswer[];
  }

  /**
   * Accept an answer: fills only the poster's side of the signed terms.
   * Unverified answers require `allowUnverified: true` (explicit confirmation).
   */
  async accept(p: {
    rfqId: string;
    manageToken: string;
    answer: RankedAnswer;
    wallet: Hex;
    payout?: Hex;
    referrer?: Hex;
    relayerFee?: string;
    allowUnverified?: boolean;
  }): Promise<DealView> {
    if (p.answer.verdict !== "signed" && !p.allowUnverified) {
      throw new Error("answer is not signed by its wallet; pass allowUnverified: true to accept it anyway");
    }
    if (p.answer.rank >= 3) throw new Error(`answer has problems: ${p.answer.problems.join("; ")}`);
    const { rfq } = await this.api.getRfq(p.rfqId);
    const terms = completeTerms(rfq.side, p.answer.answer.terms, {
      wallet: p.wallet,
      ...(p.payout ? { payout: p.payout } : {}),
      ...(p.referrer ? { referrer: p.referrer } : {}),
      ...(p.relayerFee ? { relayerFee: p.relayerFee } : {}),
    });
    return (await this.api.accept(p.rfqId, p.manageToken, p.answer.quoteId, terms)).deal;
  }

  // ------------------------------------------------------------------ answerer side

  /** Build answer terms: the answerer's side is filled, the poster's side left empty. */
  answerTerms(rfq: RfqPublic, p: { wallet: Hex; amount: string; price: string; payout?: Hex; deadlineSeconds?: number; relayerFee?: string }): Terms {
    const w = p.wallet.toLowerCase() as Hex;
    const base = {
      token: rfq.token,
      payToken: rfq.payToken,
      amount: p.amount,
      price: p.price,
      referrer: ZERO_ADDRESS as Hex,
      deadline: Math.floor(Date.now() / 1000) + (p.deadlineSeconds ?? 2 * 3600),
      salt: randomSalt(),
    };
    return rfq.side === "buy"
      ? { ...base, buyer: ZERO_ADDRESS as Hex, seller: w, sellerPayout: (p.payout ?? w).toLowerCase() as Hex, relayerFee: p.relayerFee ?? "0" }
      : { ...base, buyer: w, seller: ZERO_ADDRESS as Hex, sellerPayout: ZERO_ADDRESS as Hex, relayerFee: "0" };
  }

  async answer(p: {
    rfqId: string;
    signer: TypedSigner;
    amount: string;
    price: string;
    payout?: Hex;
    deadlineSeconds?: number;
    relayerFee?: string;
    note?: string;
  }): Promise<SentAnswer> {
    const { rfq } = await this.api.getRfq(p.rfqId);
    if (rfq.status !== "open") throw new Error(`posting is ${rfq.status}`);
    const terms = this.answerTerms(rfq, { ...p, wallet: p.signer.address });
    const signature = await p.signer.signTypedData(answerTypedData(this.cfg.chainId, this.cfg.escrow, rfq.id, terms) as never);
    const plaintext: SealedAnswerPlaintext = { v: 1, rfqId: rfq.id, terms, signature, ...(p.note ? { note: p.note } : {}) };
    const sealed = sealAnswer(plaintext, new Uint8Array(Uint8Array.from(atob(rfq.encPubKey), (c) => c.charCodeAt(0))));
    const res = await this.api.sendQuote(rfq.id, sealed);
    return {
      quoteId: res.quoteId,
      quoteToken: res.quoteToken,
      terms,
      privateLink: buildPrivateLink(this.cfg.appOrigin, "quote", res.quoteId, null, res.quoteToken),
    };
  }

  /** The accepted deal for an answer, or null while it is still sealed. */
  async myDeal(quoteId: string, quoteToken: string): Promise<DealView | null> {
    return (await this.api.quote(quoteId, quoteToken)).deal;
  }
}
