/**
 * Client-side checks run on every decrypted answer before it is shown or accepted.
 * Ranking: signed + funded first, signed second, unverified last.
 */
import type { Address, Hex } from "viem";
import type { SealedAnswerPlaintext } from "@sealdesk/shared/schemas";
import { expectedAnswerSigner, recoverAnswerSigner } from "./eip712.ts";

export interface PostingView {
  id: string;
  side: "buy" | "sell";
  token: Address;
  payToken: Address;
  amount: string;
  filledAmount: string;
  allowPartial: boolean;
}

export type Verdict = "signed" | "unverified";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Fields the POSTER fills when accepting (answerers can't know them: postings are anonymous).
 * An answer must leave them empty, sign that, and the poster's fill is the only allowed change.
 *  - bid  (poster buys):  buyer, referrer
 *  - listing (poster sells): seller, sellerPayout, referrer, relayerFee
 */
export const POSTER_FIELDS = {
  buy: ["buyer", "referrer"],
  sell: ["seller", "sellerPayout", "referrer", "relayerFee"],
} as const satisfies Record<"buy" | "sell", readonly (keyof SealedAnswerPlaintext["terms"])[]>;

export interface PosterFill {
  wallet: Address;
  payout?: Address;
  referrer?: Address;
  relayerFee?: string;
}

/** Final deal terms: the signed answer plus the poster's own side. */
export function completeTerms(side: "buy" | "sell", answerTerms: SealedAnswerPlaintext["terms"], fill: PosterFill) {
  const t = { ...answerTerms };
  const lc = (a: Address) => a.toLowerCase() as Address;
  if (side === "buy") {
    t.buyer = lc(fill.wallet);
  } else {
    t.seller = lc(fill.wallet);
    t.sellerPayout = lc(fill.payout ?? fill.wallet);
    t.relayerFee = fill.relayerFee ?? "0";
  }
  t.referrer = lc(fill.referrer ?? ZERO);
  return t;
}

export interface CheckedAnswer {
  answer: SealedAnswerPlaintext;
  verdict: Verdict;
  problems: string[];
  /** null when not checked (no balance reader supplied) */
  funded: boolean | null;
  rank: number;
}

export interface BalanceReader {
  /** ERC-20 balance and allowance to the escrow, or ETH balance when token is address(0). */
  balanceOf(token: Address, owner: Address): Promise<bigint>;
}

export async function checkAnswer(
  posting: PostingView,
  answer: SealedAnswerPlaintext,
  ctx: { chainId: number; escrow: Address; now: number; balances?: BalanceReader },
): Promise<CheckedAnswer> {
  const t = answer.terms;
  const problems: string[] = [];
  const amount = BigInt(t.amount);
  const remaining = BigInt(posting.amount) - BigInt(posting.filledAmount);

  if (answer.rfqId !== posting.id) problems.push("answer is for a different posting");
  if (t.token !== posting.token) problems.push("token does not match the posting");
  if (t.payToken !== posting.payToken) problems.push("pay token does not match the posting");
  if (posting.allowPartial ? amount > remaining || amount === 0n : amount !== remaining) {
    problems.push(posting.allowPartial ? "size exceeds what is left" : "size does not match the posting");
  }
  if (t.deadline <= Math.floor(ctx.now / 1000) + 300) problems.push("deadline is less than 5 minutes away");
  const prefilled = POSTER_FIELDS[posting.side].filter((f) => (f === "relayerFee" ? t[f] !== "0" : t[f] !== ZERO));
  if (prefilled.length) problems.push(`answer pre-fills the poster's side (${prefilled.join(", ")})`);
  const answerer = posting.side === "buy" ? t.seller : t.buyer;
  if (answerer === ZERO) problems.push("answer has no answering wallet");

  let verdict: Verdict = "unverified";
  if (answer.signature) {
    const signer = await recoverAnswerSigner(ctx.chainId, ctx.escrow, answer.rfqId, t, answer.signature as Hex);
    const expected = expectedAnswerSigner(posting.side, t);
    if (signer && signer.toLowerCase() === expected.toLowerCase()) verdict = "signed";
    else problems.push("signature does not match the answering wallet");
  } else {
    problems.push("answer is not signed");
  }

  let funded: boolean | null = null;
  if (ctx.balances) {
    // On a bid the answerer is the seller and must hold the tokens; on a listing the buyer must hold the payment.
    const [asset, owner, needed] =
      posting.side === "buy" ? [t.token, t.seller, amount] : [t.payToken, t.buyer, BigInt(t.price)];
    try {
      funded = (await ctx.balances.balanceOf(asset, owner)) >= needed;
    } catch {
      funded = null;
    }
    if (funded === false) problems.push("answering wallet does not hold enough funds");
  }

  const fatal = problems.some((p) => !p.startsWith("answer is not signed") && !p.includes("does not hold"));
  const rank = fatal ? 3 : verdict === "signed" && funded !== false ? (funded ? 0 : 1) : 2;
  return { answer, verdict, problems, funded, rank };
}

/** Best price first within each rank. For bids lower price is better; for listings higher is better. */
export function sortAnswers(side: "buy" | "sell", answers: CheckedAnswer[]): CheckedAnswer[] {
  const unit = (a: CheckedAnswer) => (BigInt(a.answer.terms.price) * 10n ** 18n) / BigInt(a.answer.terms.amount);
  return [...answers].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const d = unit(a) - unit(b);
    if (d === 0n) return 0;
    return side === "buy" ? (d < 0n ? -1 : 1) : d > 0n ? -1 : 1;
  });
}
