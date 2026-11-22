"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { privateKeyToAccount } from "viem/accounts";
import { EscrowClient, type DealView, type Hex, type RfqPublic, type TokenFacts } from "@sealdesk/sdk";
import { api, getDesk, publicClient, tokenFacts } from "@/lib/desk";
import { BRAND, DEV_BURNER, explorerAddr, explorerTx, ZERO } from "@/lib/config";
import { fmtUnits, short, timeLeft, unitPrice } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import { AddressPill, Copy, Countdown, ErrorNote, Modal, Sealed, TokenAvatar } from "./ui";

// ---------------------------------------------------------------- token metadata

export function useTokenPair(token?: Hex | null, payToken?: Hex | null) {
  const [t, setT] = useState<TokenFacts | null>(null);
  const [p, setP] = useState<TokenFacts | null>(null);
  useEffect(() => {
    if (token) tokenFacts(token).then(setT, () => setT(null));
  }, [token]);
  useEffect(() => {
    if (payToken) tokenFacts(payToken).then(setP, () => setP(null));
  }, [payToken]);
  return { t, p, ready: !!t && !!p };
}

export const payLabel = (payToken: string, p?: TokenFacts | null) => (payToken === ZERO ? "ETH" : (p?.symbol ?? "USD"));

// ---------------------------------------------------------------- private link modal

export function PrivateLinkModal({ open, onClose, link, kind }: { open: boolean; onClose: () => void; link: string; kind: "rfq" | "quote" }) {
  return (
    <Modal open={open} onClose={onClose} label="Your private link">
      <div className="stack" style={{ ["--g" as string]: "16px" }}>
        <div className="eyebrow">Private link · saved in this browser</div>
        <h2 style={{ margin: 0, fontSize: 26 }}>{kind === "rfq" ? "Your block is live." : "Your answer is sealed."}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {kind === "rfq"
            ? "This link is the only key to your answers. Anyone who has it can read the prices and accept for you."
            : "This link lets you follow the deal and deliver once it is accepted."}
        </p>
        <div className="codebox">
          <code>{link}</code>
          <Copy text={link} label="Copy private link" />
        </div>
        <div className="warnbox">Keep it like a password. It is never sent to our server: the key lives after the # in the link.</div>
        <div className="row between">
          <Link href="/mine" className="btn btn-ghost">
            My blocks
          </Link>
          <a className="btn btn-buy" href={link}>
            Open {kind === "rfq" ? "deal room" : "my answer"} →
          </a>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- block card

const compactUsd = (v: string) => `~$${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(v))}`;
const compactQty = (v: string) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(v.replace(/,/g, "")));

/**
 * One open block, laid out like the reference terminal: logo and short contract on the left;
 * name, kind and side with the size on the right; pay token, sealed price and offers; then the
 * time left with copy and the one action.
 */
export function BlockCard({ rfq, symbol, name, kind, now }: { rfq: RfqPublic; symbol?: string; name?: string; kind?: string; now: number }) {
  const { t, p } = useTokenPair(rfq.token, rfq.payToken === ZERO ? null : rfq.payToken);
  const payChip = rfq.payToken === ZERO ? "Ξ ETH" : p?.symbol?.toUpperCase() === BRAND.token ? `◆ ${BRAND.token}` : "$ USD";
  const sym = symbol ?? t?.symbol ?? short(rfq.token, 3);
  const created = new Date(rfq.createdAt).getTime();
  const expires = new Date(rfq.expiresAt).getTime();
  const buying = rfq.side === "buy";
  const left = BigInt(rfq.amount) - BigInt(rfq.filledAmount);
  const size = t?.decimals != null ? fmtUnits(left, t.decimals, 2) : null;
  const kindLabel = kind === "etf" ? "ETF token" : kind === "token" ? "Token" : kind ? "Stock token" : null;
  return (
    <div className="brow">
      <div className="brow-id">
        <TokenAvatar symbol={sym} size="lg" />
        <span className="brow-addr">{short(rfq.token, 4)}</span>
      </div>
      <div className="brow-main">
        <div className="brow-top">
          <span className="brow-title">
            <strong>{sym}</strong>
            <span className="dim">{name ?? t?.name ?? ""}{kindLabel ? ` · ${kindLabel}` : ""}</span>
            <span className={`badge ${buying ? "badge-buy" : "badge-sell"}`}>{buying ? "Buying" : "Selling"}</span>
          </span>
          <span className="brow-size"><span className="label">Size</span> <b className="num">{rfq.sizeUsd ? compactUsd(rfq.sizeUsd) : size ? compactQty(size) : "…"}</b></span>
        </div>
        <div className="brow-chips">
          <span className="chip">{payChip}</span>
          <Sealed />
          <span className="chip">{rfq.quoteCount} {buying ? (rfq.quoteCount === 1 ? "offer" : "offers") : (rfq.quoteCount === 1 ? "bid" : "bids")}</span>
          {rfq.allowPartial && <span className="chip">partial ok</span>}
        </div>
        <div className="brow-bottom">
          <span className="num dim brow-time">⏱ {timeLeft(expires - now)}</span>
          <Countdown from={created} to={expires} now={now} />
          <Copy text={rfq.token} label={`Copy the ${sym} contract address`} />
          <Link href={`/rfq/${rfq.id}`} className={`btn btn-sm ${buying ? "btn-sell" : "btn-buy"}`}>{buying ? "Sell into" : "Buy block"}</Link>
        </div>
        {rfq.note && <span className="brow-note" title="Public note from the poster">“{rfq.note.slice(0, 80)}”</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- terms review

export function TermsReview({ terms, t, p, fees }: { terms: DealView["terms"]; t: TokenFacts | null; p: TokenFacts | null; fees?: { fee: bigint; referrerFee: bigint; vaultFee: bigint; sellerNet: bigint } | null }) {
  const pd = p?.decimals ?? 18, td = t?.decimals ?? 18;
  const ps = payLabel(terms.payToken, p);
  const rows: [string, React.ReactNode][] = [
    ["Amount", `${fmtUnits(terms.amount, td, 6)} ${t?.symbol ?? ""}`],
    ["Total price", `${fmtUnits(terms.price, pd, 6)} ${ps}`],
    ["Unit price", `${unitPrice(terms.price, terms.amount, td, pd)} ${ps}`],
    ["Buyer", terms.buyer === ZERO ? <span className="dim">filled on accept</span> : <AddressPill address={terms.buyer} />],
    ["Seller", terms.seller === ZERO ? <span className="dim">filled on accept</span> : <AddressPill address={terms.seller} />],
    ["Seller payout", terms.sellerPayout === ZERO ? <span className="dim">filled on accept</span> : <AddressPill address={terms.sellerPayout} />],
    ["Deadline", new Date(terms.deadline * 1000).toLocaleString()],
  ];
  if (terms.referrer !== ZERO) rows.push(["Referrer", <AddressPill key="r" address={terms.referrer} />]);
  if (terms.relayerFee !== "0") rows.push(["Relayer fee (Ghost mode)", `${fmtUnits(terms.relayerFee, pd, 6)} ${ps}`]);
  if (fees) {
    rows.push(["Protocol fee", `${fmtUnits(fees.fee, pd, 6)} ${ps} (${((Number(fees.fee) / Number(terms.price)) * 100).toFixed(2)}%)`]);
    rows.push(["Seller receives", `${fmtUnits(fees.sellerNet, pd, 6)} ${ps}`]);
  }
  return (
    <table className="table">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="label" style={{ width: 170 }}>{k}</td>
            <td className="num">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- deal stepper

const ORDER = ["accepted", "payment_locked", "settled"] as const;
export function DealSteps({ status }: { status: DealView["status"] }) {
  const idx = ORDER.indexOf(status as (typeof ORDER)[number]);
  const label = { accepted: "Accepted", payment_locked: "Payment locked", settled: "Settled" };
  return (
    <div className="steps">
      <span className="step done">Posted</span>
      <span className="step done">Answered</span>
      {ORDER.map((s, i) => (
        <span key={s} className={`step${idx > i || status === "settled" ? " done" : idx === i ? " now" : ""}`}>
          {label[s]}
        </span>
      ))}
      {status === "refunded" && <span className="step now">Refunded</span>}
      {status === "expired" && <span className="step now">Expired</span>}
    </div>
  );
}

// ---------------------------------------------------------------- deal actions

export function DealActions({ deal, role, ghostKey, onChange }: { deal: DealView; role: "buyer" | "seller"; ghostKey?: Hex | undefined; onChange: () => void }) {
  const w = useWallet();
  const now = useNow(5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tx, setTx] = useState<Hex | null>(null);
  const [onChain, setOnChain] = useState<string | null>(null);
  const [relay, setRelay] = useState<{ id: string; state: string; error?: string } | null>(null);
  const [ghostBal, setGhostBal] = useState<{ tokens: bigint; eth: bigint } | null>(null);
  const escrow = useMemo(() => new EscrowClient(publicClient, deal.escrow), [deal.escrow]);
  const { t, p } = useTokenPair(deal.terms.token, deal.terms.payToken);
  const ghost = useMemo(() => (ghostKey ? privateKeyToAccount(ghostKey) : null), [ghostKey]);
  const t_ = deal.terms;
  const me = role === "buyer" ? t_.buyer : t_.seller;
  const walletOk = !!w.address && w.address === me;
  const pastDeadline = now / 1000 > t_.deadline;

  useEffect(() => {
    escrow.status(t_).then(setOnChain, () => setOnChain(null));
  }, [escrow, t_, deal.status, tx]);

  useEffect(() => {
    if (!ghost) return;
    const load = async () => {
      const [tokens, eth] = await Promise.all([
        publicClient.readContract({ address: t_.token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [ghost.address] }),
        publicClient.getBalance({ address: ghost.address }),
      ]);
      setGhostBal({ tokens, eth });
    };
    void load();
    const iv = setInterval(() => void load(), 5000);
    return () => clearInterval(iv);
  }, [ghost, t_.token]);

  useEffect(() => {
    if (!relay || relay.state === "mined" || relay.state === "failed") return;
    const iv = setInterval(async () => {
      const s = await api.relayStatus(relay.id).catch(() => null);
      if (s) {
        setRelay({ id: relay.id, state: s.state, ...(s.error ? { error: s.error } : {}) });
        if (s.state === "mined") {
          if (s.txHash) setTx(s.txHash);
          onChange();
        }
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [relay, onChange]);

  const run = async (label: string, fn: () => Promise<Hex | void>) => {
    setBusy(label);
    setError(null);
    try {
      const h = await fn();
      if (h) setTx(h);
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const status = onChain ?? deal.status;
  const ps = payLabel(t_.payToken, p);

  return (
    <div className="stack" style={{ ["--g" as string]: "12px" }}>
      {error ? <ErrorNote error={error} /> : null}
      {tx && (
        <div className="okbox">
          Transaction confirmed: {explorerTx(tx) ? <a className="link" href={explorerTx(tx)!} target="_blank" rel="noreferrer noopener">{short(tx, 6)} ↗</a> : short(tx, 6)}
          {status === "settled" && (
            <>
              {" · "}
              <Link className="link" href={`/receipt/${tx}`}>View receipt</Link>
            </>
          )}
        </div>
      )}

      {status === "settled" && !tx && deal.settleTx && (
        <div className="okbox">
          Settled on-chain. <Link className="link" href={`/receipt/${deal.settleTx}`}>View receipt →</Link>
        </div>
      )}
      {status === "refunded" && <div className="infobox">Refunded: the payment went back to the buyer after the deadline.</div>}

      {/* Buyer: lock payment */}
      {role === "buyer" && status === "none" && deal.status !== "expired" && !pastDeadline && (
        <>
          <div className="infobox">
            Payment locks first. You deposit {fmtUnits(t_.price, p?.decimals ?? 18, 6)} {ps}; the seller then delivers and both sides swap in one transaction. If they don't deliver by the deadline, you can refund.
          </div>
          {!walletOk && <div className="warnbox">Connect the buyer wallet {short(t_.buyer)} to deposit.</div>}
          <button className="btn btn-buy btn-lg btn-block" disabled={!walletOk || !!busy} onClick={() => run("lock", () => escrow.depositPayment(w.wallet!, t_))}>
            {busy === "lock" ? "Confirm in wallet…" : `Lock ${ps} payment`}
          </button>
        </>
      )}
      {role === "buyer" && status === "payment_locked" && !pastDeadline && <div className="infobox">Payment locked. Waiting for the seller to deliver before {new Date(t_.deadline * 1000).toLocaleString()}.</div>}

      {/* Seller: deliver */}
      {role === "seller" && status === "none" && <div className="infobox">Waiting for the buyer to lock payment. You deposit only after that.</div>}
      {role === "seller" && status === "payment_locked" && !pastDeadline && !ghost && (
        <>
          {!walletOk && <div className="warnbox">Connect the seller wallet {short(t_.seller)} to deliver.</div>}
          <button className="btn btn-sell btn-lg btn-block" disabled={!walletOk || !!busy} onClick={() => run("deliver", async () => {
            const h = await escrow.deliver(w.wallet!, t_);
            await api.reportSettled(deal.rfqId, h).catch(() => undefined);
            return h;
          })}>
            {busy === "deliver" ? "Confirm in wallet…" : `Deliver ${t?.symbol ?? "tokens"} and settle`}
          </button>
        </>
      )}

      {/* Ghost mode */}
      {role === "seller" && ghost && status !== "settled" && (
        <div className="panel panel-pad stack" style={{ ["--g" as string]: "10px" }}>
          <div className="row between">
            <strong>Ghost mode</strong>
            <span className="badge badge-info">one-time wallet</span>
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            This answer was signed by a fresh wallet. Send it {fmtUnits(t_.amount, t?.decimals ?? 18, 6)} {t?.symbol} (no ETH needed); the relayer pays gas and keeps the {fmtUnits(t_.relayerFee, p?.decimals ?? 18, 6)} {ps} relayer fee.
          </div>
          <AddressPill address={ghost.address} n={8} />
          {ghostBal && (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span className={`badge ${ghostBal.tokens >= BigInt(t_.amount) ? "badge-buy" : "badge-warn"}`}>
                {fmtUnits(ghostBal.tokens, t?.decimals ?? 18, 4)} / {fmtUnits(t_.amount, t?.decimals ?? 18, 4)} {t?.symbol}
              </span>
              <span className="badge badge-dim">{fmtUnits(ghostBal.eth, 18, 4)} ETH</span>
            </div>
          )}
          <div className="warnbox" style={{ fontSize: 12 }}>
            If you fund this wallet straight from your main wallet, that transfer is public and links the two. The exposure check on this page shows every public hop it finds.
          </div>
          {DEV_BURNER && (
            <button className="btn btn-sm" onClick={() => void w.fund(ghost.address.toLowerCase() as Hex, { eth: false })}>
              Dev: fund one-time wallet with tokens (no ETH)
            </button>
          )}
          {status === "payment_locked" && !pastDeadline && (
            <button
              className="btn btn-sell btn-block"
              disabled={!!busy || (ghostBal !== null && ghostBal.tokens < BigInt(t_.amount)) || (relay !== null && relay.state !== "failed")}
              onClick={() => run("ghost", async () => {
                const info = await api.relayInfo();
                if (!info.enabled || !info.relayer) throw new Error("The relayer is not enabled on this desk");
                const req = await escrow.ghostDelivery(ghost, info.relayer, t_);
                const r = await api.relayDeposit(req);
                setRelay({ id: r.requestId, state: r.state });
              })}
            >
              {relay ? `Relay: ${relay.state}` : busy === "ghost" ? "Signing…" : "Deliver via relayer"}
            </button>
          )}
          {relay?.error && <div className="err">{relay.error}</div>}
        </div>
      )}

      {/* Refund after deadline (anyone) */}
      {status === "payment_locked" && pastDeadline && (
        <>
          <div className="warnbox">The deadline passed before delivery. Anyone can return the payment to the buyer.</div>
          <button className="btn btn-block" disabled={!w.wallet || !!busy} onClick={() => run("refund", () => escrow.refund(w.wallet!, t_))}>
            {busy === "refund" ? "Confirm in wallet…" : "Refund buyer"}
          </button>
        </>
      )}

      {/* If this site is ever down: everything needed to refund straight from a block explorer. */}
      {(status === "payment_locked" || status === "accepted") && <ManualRefund escrowAddr={deal.escrow} terms={t_} />}
    </div>
  );
}

/**
 * The deal terms as the tuple `refund(Terms)` takes, in the contract's field order, so anyone can
 * refund from a block explorer's "Write contract" tab without this site.
 */
function ManualRefund({ escrowAddr, terms: t }: { escrowAddr: Hex; terms: DealView["terms"] }) {
  const tuple = JSON.stringify([t.buyer, t.seller, t.token, String(t.amount), t.payToken, String(t.price), t.sellerPayout, t.referrer, String(t.relayerFee), String(t.deadline), t.salt]);
  const href = explorerAddr(escrowAddr);
  return (
    <details className="manual-refund">
      <summary>If this site is down: refund from a block explorer</summary>
      <ol>
        <li>Wait until the deal deadline ({new Date(t.deadline * 1000).toLocaleString()}) has passed.</li>
        <li>Open the escrow contract {href ? <a className="link" href={href} target="_blank" rel="noreferrer noopener">{short(escrowAddr, 6)} ↗</a> : <code>{escrowAddr}</code>} on the explorer, tab “Write contract”, function <code>refund</code>.</li>
        <li>Paste these terms as the <code>t</code> argument and send. Anyone can call it; the payment only ever goes back to the buyer.</li>
      </ol>
      <div className="codebox row between"><code style={{ fontSize: 12 }}>{tuple}</code><Copy text={tuple} label="Copy the deal terms for a manual refund" /></div>
    </details>
  );
}

/** Desk connection for components that need chain id + escrow. */
export function useDesk() {
  const [d, setD] = useState<Awaited<ReturnType<typeof getDesk>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    getDesk().then(setD, setError);
  }, []);
  return { desk: d?.desk ?? null, health: d?.health ?? null, error };
}
