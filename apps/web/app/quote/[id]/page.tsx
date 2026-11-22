"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import type { DealView, RfqPublic } from "@sealdesk/sdk";
import { DealActions, DealSteps, TermsReview, useTokenPair } from "@/components/desk";
import { ExposureCheck } from "@/components/Exposure";
import { NotifyPanel } from "@/components/Notify";
import { ErrorNote, Skeleton, TokenAvatar } from "@/components/ui";
import { api } from "@/lib/desk";
import { fmtUnits, short } from "@/lib/format";
import { useStream } from "@/lib/hooks";
import { fragment, links, type SavedLink } from "@/lib/keys";
import { privateKeyToAccount } from "viem/accounts";

type QuoteState = Awaited<ReturnType<typeof api.quote>>;

export default function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [saved, setSaved] = useState<SavedLink | undefined>(undefined);
  const [state, setState] = useState<QuoteState | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const read = () => {
      setToken(fragment().t);
      setSaved(links.get("quote", id));
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [id]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setState(await api.quote(id, token));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [id, token]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 6000);
    return () => clearInterval(iv);
  }, [load]);
  useStream(token ? `quote:${id}` : null, token ?? null, () => void load());

  if (token === undefined) return <div className="wrap page"><Skeleton h={160} /></div>;
  if (!token) {
    return (
      <div className="wrap page">
        <div className="errbox">This page needs the private link of your answer (it carries the key after the #). Open it from <Link className="link" href="/mine">My blocks</Link>.</div>
      </div>
    );
  }
  return (
    <div className="wrap page stack" style={{ ["--g" as string]: "16px" }}>
      <ErrorNote error={error} />
      {!state ? <Skeleton h={200} /> : <QuoteRoom state={state} ghostKey={saved?.ghostKey} reload={load} />}
      {state && saved?.ghostKey && (
        <ExposureCheck oneTime={privateKeyToAccount(saved.ghostKey).address.toLowerCase() as `0x${string}`} terms={state.deal?.terms ?? null} since={state.quote.createdAt} />
      )}
      {state && <NotifyPanel cap={{ kind: "quote", id }} token={token} />}
    </div>
  );
}

function QuoteRoom({ state, ghostKey, reload }: { state: QuoteState; ghostKey?: `0x${string}` | undefined; reload: () => void }) {
  const rfq: RfqPublic = state.rfq;
  const deal: DealView | null = state.deal;
  const { t, p } = useTokenPair(rfq.token, rfq.payToken);
  const role = rfq.side === "buy" ? "seller" : "buyer"; // answering a bid = selling
  return (
    <>
      <section className="panel panel-pad stack" style={{ ["--g" as string]: "12px" }}>
        <div className="row between" style={{ flexWrap: "wrap" }}>
          <div className="row">
            <TokenAvatar symbol={t?.symbol ?? "?"} size="lg" />
            <div>
              <div className="eyebrow">Your sealed answer</div>
              <h1 style={{ margin: "4px 0 0", fontSize: 24 }}>
                {role === "seller" ? "Selling" : "Buying"} {t?.decimals != null ? fmtUnits(rfq.amount, t.decimals, 4) : ""} {t?.symbol}
              </h1>
            </div>
          </div>
          <span className={`badge ${state.quote.status === "accepted" ? "badge-buy" : "badge-dim"}`}>{state.quote.status}</span>
        </div>
        {deal ? <DealSteps status={deal.status} /> : (
          <div className="infobox">
            Your price is sealed to the poster. You'll see the deal here the moment they accept{ghostKey ? " (signed by your one-time wallet)" : ""}. Posting {rfq.status === "open" ? "is still open" : `is ${rfq.status}`}.
          </div>
        )}
      </section>
      {deal && (
        <div className="grid-2">
          <div className="panel">
            <div className="panel-head"><span className="panel-title">Deal terms</span><span className="mono dim" style={{ fontSize: 12 }}>{short(deal.dealId, 6)}</span></div>
            <TermsReview terms={deal.terms} t={t} p={p} />
          </div>
          <div className="panel panel-pad">
            <DealActions deal={deal} role={role} ghostKey={ghostKey} onChange={reload} />
          </div>
        </div>
      )}
    </>
  );
}
