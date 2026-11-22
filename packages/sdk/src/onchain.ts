/**
 * On-chain side of a deal, using the caller's own viem clients (keys stay in the wallet).
 * Every write waits for its receipt and throws on revert.
 */
import { erc20Abi, parseAbi, type Account, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";
import { deliverTypedData, dealIdOf, toOnChainTerms } from "@sealdesk/crypto";
import { otcEscrowAbi } from "@sealdesk/shared/abi";
import type { Hex, PermitWire, Terms } from "./types.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const permitAbi = parseAbi(["function nonces(address) view returns (uint256)", "function name() view returns (string)"]);
const STATUS = ["none", "payment_locked", "settled", "refunded"] as const;
export type OnChainStatus = (typeof STATUS)[number];

type Wallet = WalletClient<Transport, Chain, Account>;

export class EscrowClient {
  readonly escrow: Hex;
  private readonly pub: PublicClient;

  constructor(pub: PublicClient, escrow: Hex) {
    this.pub = pub;
    this.escrow = escrow;
  }

  async status(t: Terms): Promise<OnChainStatus> {
    const s = await this.pub.readContract({ address: this.escrow, abi: otcEscrowAbi, functionName: "status", args: [dealIdOf(t)] });
    return STATUS[Number(s)] ?? "none";
  }

  /** Exact fee split the contract would apply right now. */
  async quote(t: Terms) {
    const [fee, referrerFee, vaultFee, sellerNet] = await this.pub.readContract({
      address: this.escrow, abi: otcEscrowAbi, functionName: "quote", args: [toOnChainTerms(t)],
    });
    return { fee, referrerFee, vaultFee, sellerNet };
  }

  private async wait(pending: Promise<Hex>): Promise<Hex> {
    const hash = await pending;
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return hash;
  }

  /** Approve exactly what is needed (never unlimited). */
  async ensureAllowance(wallet: Wallet, token: Hex, amount: bigint): Promise<Hex | null> {
    const owner = wallet.account.address;
    const current = await this.pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, this.escrow] });
    if (current >= amount) return null;
    return this.wait(wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [this.escrow, amount], account: wallet.account, chain: wallet.chain }));
  }

  /** Buyer: lock the payment (ETH or stablecoin). */
  async depositPayment(wallet: Wallet, t: Terms): Promise<Hex> {
    const price = BigInt(t.price);
    if (t.payToken === ZERO) {
      return this.wait(wallet.writeContract({
        address: this.escrow, abi: otcEscrowAbi, functionName: "depositPayment", args: [toOnChainTerms(t)],
        value: price, account: wallet.account, chain: wallet.chain,
      }));
    }
    await this.ensureAllowance(wallet, t.payToken, price);
    return this.wait(wallet.writeContract({
      address: this.escrow, abi: otcEscrowAbi, functionName: "depositPayment", args: [toOnChainTerms(t)],
      account: wallet.account, chain: wallet.chain,
    }));
  }

  /** Seller: deliver the tokens; this settles both legs in the same transaction. */
  async deliver(wallet: Wallet, t: Terms): Promise<Hex> {
    if (wallet.account.address.toLowerCase() !== t.seller) throw new Error("wallet is not terms.seller");
    await this.ensureAllowance(wallet, t.token, BigInt(t.amount));
    return this.wait(wallet.writeContract({
      address: this.escrow, abi: otcEscrowAbi, functionName: "deliver", args: [toOnChainTerms(t)],
      account: wallet.account, chain: wallet.chain,
    }));
  }

  /** Anyone, after the deadline: return the locked payment to the buyer. */
  async refund(wallet: Wallet, t: Terms): Promise<Hex> {
    return this.wait(wallet.writeContract({
      address: this.escrow, abi: otcEscrowAbi, functionName: "refund", args: [toOnChainTerms(t)],
      account: wallet.account, chain: wallet.chain,
    }));
  }

  /** EIP-2612 permit signed by `owner` (no gas needed by the owner). */
  async signPermit(owner: Account, token: Hex, value: bigint, deadline: bigint): Promise<PermitWire> {
    if (!owner.signTypedData) throw new Error("account cannot sign typed data");
    let name: string;
    let version = "1";
    try {
      const d = await this.pub.getEip712Domain({ address: token });
      name = d.domain.name ?? "";
      version = d.domain.version ?? "1";
    } catch {
      name = await this.pub.readContract({ address: token, abi: permitAbi, functionName: "name" });
    }
    const nonce = await this.pub.readContract({ address: token, abi: permitAbi, functionName: "nonces", args: [owner.address] });
    const chainId = await this.pub.getChainId();
    const sig = await owner.signTypedData({
      domain: { name, version, chainId, verifyingContract: token },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: { owner: owner.address, spender: this.escrow, value, nonce, deadline },
    });
    const r = `0x${sig.slice(2, 66)}` as Hex;
    const s = `0x${sig.slice(66, 130)}` as Hex;
    const v = parseInt(sig.slice(130, 132), 16);
    return { value: value.toString(), deadline: deadline.toString(), v: v < 27 ? v + 27 : v, r, s };
  }

  /**
   * Ghost mode: the one-time wallet (terms.seller) signs a permit and a Deliver authorization for
   * `relayer`. It needs the tokens but no ETH. Send the result to POST /relay/deposit.
   */
  async ghostDelivery(oneTime: Account, relayer: Hex, t: Terms, validForSeconds = 900) {
    if (oneTime.address.toLowerCase() !== t.seller) throw new Error("one-time wallet must be terms.seller");
    if (!oneTime.signTypedData) throw new Error("account cannot sign typed data");
    const authDeadline = BigInt(Math.floor(Date.now() / 1000) + validForSeconds);
    const permit = await this.signPermit(oneTime, t.token, BigInt(t.amount), authDeadline);
    const chainId = await this.pub.getChainId();
    const signature = await oneTime.signTypedData(deliverTypedData(chainId, this.escrow, dealIdOf(t), relayer, authDeadline));
    return { terms: t, permit, authDeadline: authDeadline.toString(), signature };
  }
}
