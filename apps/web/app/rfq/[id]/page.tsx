"use client";
import Link from "next/link";
import { NotifyPanel } from "@/components/Notify";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { completeTerms, EscrowClient, type DealView, type Hex, type RankedAnswer, type RfqPublic } from "@sealdesk/sdk";
import { fromB64 } from "@sealdesk/shared/bytes";
import { AnswerComposer } from "@/components/AnswerComposer";
import { ConnectButton } from "@/components/chrome";
import { DealActions, DealSteps, payLabel, TermsReview, useDesk, useTokenPair } from "@/components/desk";
import { AddressPill, Countdown, ErrorNote, Modal, Skeleton, TokenAvatar } from "@/components/ui";
import { api, balanceOf, publicClient } from "@/lib/desk";
import { fmtUnits, fmtUsd, short, timeLeft, unitPrice } from "@/lib/format";
import { useNow, useStream } from "@/lib/hooks";
import { fragment, links, referral } from "@/lib/keys";
import { useWallet } from "@/lib/wallet";

export default function RfqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rfq, setRfq] = useState<RfqPublic | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cap, setCap] = useState<{ k: string | null; t: string | null } | null>(null);
  const load = useCallback(() => api.getRfq(id).then((r) => setRfq(r.rfq), setError), [id]);
  useEffect(() => {
    setCap(fragment());
    void load();
    // Opening a private link on the public page only changes the fragment: re-read the key.
    const onHash = () => setCap(fragment());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [load]);

  if (error) return <div className="wrap page"><ErrorNote error={error} /></div>;
  if (!rfq || !cap) return <div className="wrap page"><Skeleton h={180} /></div>;
  return cap.k && cap.t ? <OwnerRoom rfq={rfq} secret={cap.k} token={cap.t} reload={load} /> : <PublicRoom rfq={rfq} />;
}

function Header({ rfq, extra }: { rfq: RfqPublic; extra?: React.ReactNode }) {
  const now = useNow(1000);
  const { t } = useTokenPair(rfq.token, rfq.payToken);
  const sym = t?.symbol ?? short(rfq.token, 3);
  return (
    <section className="panel panel-pad stack" style={{ ["--g" as string]: "14px" }}>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <div className="row">
          <TokenAvatar symbol={sym} size="lg" />
          <div>
            <div className="row">
              <h1 style={{ margin: 0, fontSize: 26 }}>{sym}</h1>
              <span className={`badge ${rfq.side === "buy" ? "badge-buy" : "badge-sell"}`}>{rfq.side === "buy" ? "Buying" : "Selling"}</span>
              <span className="badge badge-dim">{rfq.status}</span>
            </div>
            <div className="dim">{t?.name} · <AddressPill address={rfq.token} /></div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="label">Size</div>
          <div className="num" style={{ fontSize: 22 }}>{t?.decimals != null ? fmtUnits(rfq.amount, t.decimals, 4) : "…"} {sym}</div>
          {BigInt(rfq.filledAmount) > 0n && t?.decimals != null && <div className="dim mono" style={{ fontSize: 12 }}>{fmtUnits(rfq.filledAmount, t.decimals, 4)} filled</div>}
        </div>
      </div>
      <div className="row">
        <span className="mono dim" style={{ fontSize: 12, minWidth: 90 }}>⏱ {timeLeft(new Date(rfq.expiresAt).getTime() - now)}</span>
        <Countdown from={new Date(rfq.createdAt).getTime()} to={new Date(rfq.expiresAt).getTime()} now={now} />
        <span className="chip">{rfq.payToken === "0x0000000000000000000000000000000000000000" ? "Pay in ETH" : "Pay in USD"}</span>
        <span className="chip">{rfq.quoteCount} sealed</span>
      </div>
      {rfq.note && <div className="infobox">Public note from the poster: “{rfq.note}”</div>}
      {extra}
    </section>
  );
}

function PublicRoom({ rfq }: { rfq: RfqPublic }) {
  return (
    <div className="wrap page stack" style={{ ["--g" as string]: "16px" }}>
      <Header rfq={rfq} />
      <div className="grid-2">
        <AnswerComposer rfq={rfq} />
        <div className="stack" style={{ ["--g" as string]: "12px" }}>
          <div className="panel panel-pad stack" style={{ ["--g" as string]: "10px" }}>
            <strong>How this works</strong>
            <ol className="muted" style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
              <li>Your price is encrypted in this browser to the poster's key.</li>
              <li>Your wallet signs it (no gas), so the poster can tell it's really you.</li>
              <li>If accepted, the buyer locks payment first; then the seller delivers and both sides swap in one transaction.</li>
              <li>Nothing settles before the deadline? Locked payment is refunded.</li>
            </ol>
          </div>
          <Link href="/app" className="btn btn-ghost">← Back to the terminal</Link>
        </div>
      </div>
    </div>
  );
}

function OwnerRoom({ rfq, secret, token, reload }: { rfq: RfqPublic; secret: string; token: string; reload: () => void }) {
  const w = useWallet();
  const { desk, health } = useDesk();
  const { t, p } = useTokenPair(rfq.token, rfq.payToken);
  const [answers, setAnswers] = useState<RankedAnswer[] | null>(null);
  const [deals, setDeals] = useState<DealView[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [ref, setRef] = useState<number | null>(null);
  const [accepting, setAccepting] = useState<RankedAnswer | null>(null);
  const secretKey = useMemo(() => fromB64(secret), [secret]);

  const refresh = useCallback(async () => {
    if (!desk) return;
    try {
      const [a, d] = await Promise.all([
        desk.readAnswers({ rfqId: rfq.id, manageToken: token, secretKey, balances: { balanceOf } }),
        api.deals(rfq.id, token),
      ]);
      setAnswers(a);
      setDeals(d.items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [desk, rfq.id, token, secretKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!links.get("rfq", rfq.id)) links.save({ kind: "rfq", id: rfq.id, link: window.location.href, side: rfq.side, createdAt: rfq.createdAt });
  }, [rfq]);
  useEffect(() => {
    api.tokenMarket(rfq.token).then((m) => setRef(Number(m.priceUsd)), () => setRef(null));
  }, [rfq.token]);
  useStream(`rfq:${rfq.id}`, token, () => {
    void refresh();
    reload();
  });

  const pd = p?.decimals ?? 18, td = t?.decimals ?? 18;
  const ps = payLabel(rfq.payToken, p);
  const isStable = health && rfq.payToken === health.contracts.stable;
  const role = rfq.side === "buy" ? "buyer" : "seller";

  return (
    <div className="wrap page stack" style={{ ["--g" as string]: "16px" }}>
      <Header
        rfq={rfq}
        extra={
          <div className="row between" style={{ flexWrap: "wrap" }}>
            <span className="badge badge-info">Your block · answers decrypt in this browser only</span>
            {rfq.status === "open" && (
              <button className="btn btn-sm btn-ghost" onClick={() => void api.cancelRfq(rfq.id, token).then(reload, setError)}>
                Cancel posting
              </button>
            )}
          </div>
        }
      />
      <ErrorNote error={error} />

      {deals.length > 0 && (
        <section className="stack" style={{ ["--g" as string]: "12px" }}>
          <div className="label">Deals on this block</div>
          {deals.map((d) => (
            <div key={d.dealId} className="panel panel-pad stack" style={{ ["--g" as string]: "14px" }}>
              <div className="row between" style={{ flexWrap: "wrap" }}>
                <DealSteps status={d.status} />
                <span className="mono dim" style={{ fontSize: 12 }}>deal {short(d.dealId, 6)}</span>
              </div>
              <div className="grid-2">
                <TermsReview terms={d.terms} t={t} p={p} />
                <DealActions deal={d} role={role} onChange={() => void refresh()} />
              </div>
            </div>
          ))}
        </section>
      )}

      <NotifyPanel cap={{ kind: "rfq", id: rfq.id }} token={token} />

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Sealed answers</span>
          <span className="dim mono" style={{ fontSize: 12 }}>signed + funded first · unverified last</span>
        </div>
        {answers === null ? (
          <div style={{ padding: 18 }}><Skeleton h={48} /></div>
        ) : answers.length === 0 ? (
          <div className="empty">{deals.length ? "No open answers. Accepted ones are in the deals above." : "No answers yet. They appear here live, decrypted with your link's key."}</div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Rank</th><th>Price / {t?.symbol ?? "token"}</th><th>Total</th>{isStable && ref ? <th>vs market</th> : null}<th>Amount</th><th>Wallet</th><th>Checks</th><th>Deal deadline</th><th />
                </tr>
              </thead>
              <tbody>
                {answers.map((a) => {
                  const at = a.answer.terms;
                  const u = Number(unitPrice(at.price, at.amount, td, pd).replace(/,/g, ""));
                  const vs = isStable && ref ? ((u / ref - 1) * 100) : null;
                  const wallet = rfq.side === "buy" ? at.seller : at.buyer;
                  return (
                    <tr key={a.quoteId}>
                      <td>
                        <span className={`badge ${a.verdict === "signed" ? (a.funded === false ? "badge-warn" : "badge-buy") : "badge-sell"}`}>
                          {a.verdict === "signed" ? (a.funded === false ? "signed · unfunded" : "signed") : "unverified"}
                        </span>
                      </td>
                      <td className="num">{unitPrice(at.price, at.amount, td, pd)} {ps}</td>
                      <td className="num">{fmtUnits(at.price, pd, 4)}</td>
                      {isStable && ref ? <td className={`num ${vs !== null && ((rfq.side === "buy" && vs <= 0) || (rfq.side === "sell" && vs >= 0)) ? "up" : "down"}`}>{vs !== null ? (Math.abs(vs) < 0.05 ? "at market" : `${Math.abs(vs).toFixed(1)}% ${vs < 0 ? "under" : "over"} market`) : "–"}</td> : null}
                      <td className="num">{fmtUnits(at.amount, td, 4)}</td>
                      <td><AddressPill address={wallet} copy={false} /></td>
                      <td className="dim" style={{ fontSize: 12, maxWidth: 220 }}>{a.problems.length ? a.problems.join("; ") : "ok"}</td>
                      <td className="mono dim" style={{ fontSize: 12 }}>{new Date(at.deadline * 1000).toLocaleTimeString()}</td>
                      <td>
                        {rfq.status === "open" && a.rank < 3 && (
                          <button className="btn btn-sm btn-buy" onClick={() => setAccepting(a)}>Accept</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {ref && <div className="hint" style={{ padding: "0 18px 14px" }}>Reference: {fmtUsd(ref)} on-chain DEX price. Reference only; the deal settles at the price you accept.</div>}
      </section>

      {accepting && desk && (
        <AcceptDialog
          rfq={rfq}
          answer={accepting}
          token={token}
          onClose={() => setAccepting(null)}
          onDone={() => {
            setAccepting(null);
            void refresh();
            reload();
          }}
          wallet={w.address}
          escrow={desk.cfg.escrow}
        />
      )}
    </div>
  );
}

function AcceptDialog({ rfq, answer, token, onClose, onDone, wallet, escrow }: { rfq: RfqPublic; answer: RankedAnswer; token: string; onClose: () => void; onDone: () => void; wallet: Hex | null; escrow: Hex }) {
  const { desk } = useDesk();
  const { t, p } = useTokenPair(rfq.token, rfq.payToken);
  const [confirmUnverified, setConfirmUnverified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fees, setFees] = useState<Awaited<ReturnType<EscrowClient["quote"]>> | null>(null);
  const r = referral.get();
  const referrer = r && wallet && r !== wallet ? r : undefined;
  const terms = wallet ? completeTerms(rfq.side, answer.answer.terms, { wallet, ...(referrer ? { referrer } : {}) }) : null;

  useEffect(() => {
    if (terms) new EscrowClient(publicClient, escrow).quote(terms).then(setFees, () => setFees(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, escrow]);

  const unverified = answer.verdict !== "signed";
  return (
    <Modal open onClose={onClose} label="Accept answer">
      <div className="stack" style={{ ["--g" as string]: "14px" }}>
        <div className="eyebrow">Accept this answer</div>
        <p className="muted" style={{ margin: 0 }}>These terms become final: the deal id is a hash of them. Your connected wallet fills your side.</p>
        {!wallet ? <ConnectButton /> : terms && <TermsReview terms={terms} t={t} p={p} fees={fees} />}
        {unverified && (
          <label className="toggle errbox">
            <input type="checkbox" checked={confirmUnverified} onChange={(e) => setConfirmUnverified(e.target.checked)} />
            <span>This answer is not signed by its wallet. I understand and still want to accept it.</span>
          </label>
        )}
        <ErrorNote error={error} />
        <div className="row between">
          <button className="btn btn-ghost" onClick={onClose}>Back</button>
          <button
            className="btn btn-buy"
            disabled={!wallet || busy || (unverified && !confirmUnverified)}
            onClick={async () => {
              if (!desk || !wallet) return;
              setBusy(true);
              setError(null);
              try {
                await desk.accept({ rfqId: rfq.id, manageToken: token, answer, wallet, ...(referrer ? { referrer } : {}), ...(unverified ? { allowUnverified: true } : {}) });
                onDone();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Accepting…" : "Accept and fix terms"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
