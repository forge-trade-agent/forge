"use client";
import { useEffect, useMemo, useState } from "react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex, RfqPublic } from "@sealdesk/sdk";
import { api, balanceOf, getDesk } from "@/lib/desk";
import { fmtUnits, toBase, totalPrice } from "@/lib/format";
import { links } from "@/lib/keys";
import { useWallet } from "@/lib/wallet";
import { ConnectButton } from "./chrome";
import { payLabel, PrivateLinkModal, useTokenPair } from "./desk";
import { ErrorNote, Segmented } from "./ui";

/**
 * Answer someone's block with a sealed, signed offer. The price is encrypted in this browser to
 * the poster's key; the server stores ciphertext only.
 */
export function AnswerComposer({ rfq }: { rfq: RfqPublic }) {
  const w = useWallet();
  const { t, p, ready } = useTokenPair(rfq.token, rfq.payToken);
  const remaining = BigInt(rfq.amount) - BigInt(rfq.filledAmount);
  const iSell = rfq.side === "buy"; // answering a bid = selling into it
  const [size, setSize] = useState("");
  const [unit, setUnit] = useState("");
  const [payout, setPayout] = useState("");
  const [hours, setHours] = useState<"1" | "2" | "6" | "24">("2");
  const [ghost, setGhost] = useState(false);
  const [note, setNote] = useState("");
  const [minFeeBps, setMinFeeBps] = useState<number | null>(null);
  const [relayOn, setRelayOn] = useState(false);
  const [bal, setBal] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    if (t?.decimals != null && !size) setSize(fmtUnits(remaining, t.decimals, 8).replace(/,/g, ""));
  }, [t, remaining, size]);
  useEffect(() => {
    api.relayInfo().then((r) => {
      setMinFeeBps(r.minFeeBps);
      setRelayOn(r.enabled);
    }, () => undefined);
  }, []);
  useEffect(() => {
    if (!w.address) return setBal(null);
    // Selling: you must hold the tokens. Buying from a listing: you must hold the payment.
    // Re-read periodically: the wallet may be funded while this form is open.
    const read = () => balanceOf(iSell ? rfq.token : rfq.payToken, w.address!).then(setBal, () => setBal(null));
    void read();
    const iv = setInterval(() => void read(), 5000);
    return () => clearInterval(iv);
  }, [w.address, iSell, rfq.token, rfq.payToken]);

  const amount = useMemo(() => (t?.decimals != null ? toBase(size, t.decimals) : null), [size, t]);
  const price = useMemo(() => (amount && ready ? totalPrice(unit, amount, t!.decimals ?? 18, p!.decimals ?? 18) : null), [unit, amount, ready, t, p]);
  const relayerFee = ghost && price && minFeeBps !== null ? (price * BigInt(Math.max(minFeeBps, 10))) / 10_000n + 1n : 0n;
  const sizeOk = amount !== null && (rfq.allowPartial ? amount <= remaining : amount === remaining);
  const ps = payLabel(rfq.payToken, p);
  const needed = iSell ? amount : price;
  const shortFunds = !ghost && bal !== null && needed !== null && bal < needed;

  const submit = async () => {
    if (!amount || !price) return;
    setBusy(true);
    setError(null);
    try {
      const { desk } = await getDesk();
      let ghostKey: Hex | undefined;
      let signer = w.signer;
      if (ghost) {
        ghostKey = generatePrivateKey();
        signer = privateKeyToAccount(ghostKey);
      }
      if (!signer) throw new Error("Connect a wallet first");
      const payoutAddr = iSell && /^0x[0-9a-fA-F]{40}$/.test(payout) ? (payout.toLowerCase() as Hex) : iSell && ghost && w.address ? w.address : undefined;
      const r = await desk.answer({
        rfqId: rfq.id,
        signer,
        amount: amount.toString(),
        price: price.toString(),
        deadlineSeconds: Number(hours) * 3600,
        ...(payoutAddr ? { payout: payoutAddr } : {}),
        ...(relayerFee > 0n ? { relayerFee: relayerFee.toString() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      links.save({ kind: "quote", id: r.quoteId, link: r.privateLink, side: rfq.side, createdAt: new Date().toISOString(), ...(ghostKey ? { ghostKey } : {}) });
      setSent(r.privateLink);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (rfq.status !== "open") return <div className="infobox">This block is {rfq.status}. It no longer takes answers.</div>;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{iSell ? "Sell into this bid" : "Buy from this listing"}</span>
        <span className="badge badge-info">sealed to the poster</span>
      </div>
      <div className="panel-pad stack" style={{ ["--g" as string]: "16px" }}>
        <div className="field">
          <span className="label">Amount ({t?.symbol ?? "tokens"})</span>
          <input className={`input num${size && !sizeOk ? " invalid" : ""}`} value={size} onChange={(e) => setSize(e.target.value)} readOnly={!rfq.allowPartial} inputMode="decimal" />
          <span className="hint">{rfq.allowPartial ? `Up to ${t?.decimals != null ? fmtUnits(remaining, t.decimals, 6) : "…"} left (partial fills allowed).` : "This block must be filled in one piece."}</span>
        </div>
        <div className="field">
          <span className="label">Your price per {t?.symbol ?? "token"} ({ps})</span>
          <input className={`input big num${unit && !price ? " invalid" : ""}`} placeholder="0.00" value={unit} onChange={(e) => setUnit(e.target.value)} inputMode="decimal" autoFocus />
          {price && p?.decimals != null && <span className="hint">Total {fmtUnits(price, p.decimals, 6)} {ps}. Only the poster can read this.</span>}
        </div>
        {iSell && (
          <div className="field">
            <span className="label">Payout address <span className="dim" style={{ textTransform: "none" }}>optional, defaults to {ghost ? "your connected wallet" : "the signing wallet"}</span></span>
            <input className="input" placeholder="0x…" value={payout} onChange={(e) => setPayout(e.target.value.trim())} spellCheck={false} />
          </div>
        )}
        <div className="field">
          <span className="label">Deal deadline</span>
          <Segmented value={hours} onChange={setHours} label="Deadline" options={[{ value: "1", label: "1h" }, { value: "2", label: "2h" }, { value: "6", label: "6h" }, { value: "24", label: "24h" }]} />
          <span className="hint">If the deal isn't settled by then, any locked payment can be refunded.</span>
        </div>
        {iSell && relayOn && (
          <label className="toggle">
            <input type="checkbox" checked={ghost} onChange={(e) => setGhost(e.target.checked)} />
            <span>
              <strong>Ghost mode</strong>
              <span className="hint" style={{ display: "block" }}>
                Sign and deliver from a fresh one-time wallet; the relayer pays gas for a {minFeeBps ?? 10} bps fee{relayerFee > 0n && p?.decimals != null ? ` (${fmtUnits(relayerFee, p.decimals, 6)} ${ps})` : ""}. Your main wallet never appears in the deal.
              </span>
            </span>
          </label>
        )}
        {iSell && ghost && !/^0x[0-9a-fA-F]{40}$/.test(payout) && w.address && (
          <div className="warnbox">Payment will go to your connected wallet, and the payout address is public once the deal settles. That links this one-time wallet to you. Paste a fresh payout address above to keep them apart.</div>
        )}
        <div className="field">
          <span className="label">Note to the poster <span className="dim" style={{ textTransform: "none" }}>sealed, optional</span></span>
          <input className="input" maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {shortFunds && <div className="warnbox">This wallet holds {fmtUnits(bal!, iSell ? (t?.decimals ?? 18) : (p?.decimals ?? 18), 4)} {iSell ? t?.symbol : ps}. The poster will see your answer as unfunded.</div>}
        <ErrorNote error={error} />
        {!w.address && !ghost ? (
          <ConnectButton />
        ) : (
          <button className={`btn btn-lg btn-block ${iSell ? "btn-sell" : "btn-buy"}`} disabled={!sizeOk || !price || busy || (ghost && !w.address && !iSell)} onClick={() => void submit()}>
            {busy ? "Signing & sealing…" : "Send sealed answer"}
          </button>
        )}
        <span className="hint">Your wallet signs the offer (no transaction, no gas). Free to answer.</span>
      </div>
      {sent && <PrivateLinkModal open kind="quote" link={sent} onClose={() => (window.location.href = sent)} />}
    </div>
  );
}
