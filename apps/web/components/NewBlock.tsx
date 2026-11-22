"use client";
import { useEffect, useMemo, useState } from "react";
import type { Hex } from "@sealdesk/sdk";
import { getDesk, tokenFacts } from "@/lib/desk";
import { ZERO } from "@/lib/config";
import { toBase } from "@/lib/format";
import { loadMarkets, type MarketItem } from "@/lib/hooks";
import { links } from "@/lib/keys";
import { PrivateLinkModal } from "./desk";
import { MarketPicker } from "./MarketPicker";
import { PayNote, PayPicker } from "./PayPicker";
import { Drawer, ErrorNote, Segmented } from "./ui";

export type Side = "buy" | "sell";
export type Window = "15m" | "1h" | "4h" | "24h";

/** USD = the desk stablecoin, ETH = native, TOKEN = the platform token (flat 1.5% fee, burned). */
export type Pay = "USD" | "ETH" | "TOKEN";

export interface PostInput {
  side: Side;
  token: Hex;
  amount: bigint;
  pay: Pay;
  window: Window | "6h";
  allowPartial: boolean;
  note?: string;
  sizeUsd?: string;
}

/** Create a posting, save its private link locally, return the link. */
export async function postBlock(input: PostInput): Promise<{ link: string; id: string }> {
  const { desk, health } = await getDesk();
  const posted = await desk.postBlock({
    side: input.side,
    token: input.token,
    payToken: input.pay === "ETH" ? ZERO : input.pay === "TOKEN" ? health.contracts.platformToken : health.contracts.stable,
    amount: input.amount.toString(),
    replyWindow: input.window,
    allowPartial: input.allowPartial,
    ...(input.note ? { note: input.note } : {}),
    ...(input.sizeUsd ? { sizeUsd: input.sizeUsd } : {}),
  });
  links.save({ kind: "rfq", id: posted.rfq.id, link: posted.privateLink, side: input.side, createdAt: new Date().toISOString() });
  return { link: posted.privateLink, id: posted.rfq.id };
}

export function NewBlockDrawer({ open, onClose, initialSide = "buy", initialToken = null }: { open: boolean; onClose: () => void; initialSide?: Side; initialToken?: string | null }) {
  const [side, setSide] = useState<Side>(initialSide);
  const [token, setToken] = useState("");
  const [size, setSize] = useState("");
  const [pay, setPay] = useState<Pay>("USD");
  const [win, setWin] = useState<Window>("1h");
  const [note, setNote] = useState("");
  const [partial, setPartial] = useState(false);
  const [decimals, setDecimals] = useState<number | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [markets, setMarkets] = useState<MarketItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => setSide(initialSide), [initialSide, open]);
  // Opened from a coin: start with that coin picked.
  useEffect(() => { if (open && initialToken) setToken(initialToken); }, [open, initialToken]);
  useEffect(() => {
    loadMarkets().then(setMarkets, () => undefined);
  }, []);

  const valid = /^0x[0-9a-fA-F]{40}$/.test(token);
  useEffect(() => {
    setDecimals(null);
    setSymbol(null);
    if (!valid) return;
    tokenFacts(token.toLowerCase() as Hex).then(
      (f) => {
        if (!f.hasCode) {
          setError(new Error("No contract at this address on this chain"));
          return;
        }
        setError(null);
        setDecimals(f.decimals ?? 18);
        setSymbol(f.symbol);
      },
      setError,
    );
  }, [token, valid]);

  const amount = useMemo(() => (decimals === null ? null : toBase(size, decimals)), [size, decimals]);
  const submit = async () => {
    if (!amount || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postBlock({ side, token: token.toLowerCase() as Hex, amount, pay, window: win, allowPartial: partial, ...(note.trim() ? { note: note.trim() } : {}) });
      setCreated(r.link);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Drawer
        open={open && !created}
        onClose={onClose}
        title="New block"
        footer={
          <button className={`btn btn-lg btn-block ${side === "buy" ? "btn-buy" : "btn-sell"}`} disabled={!amount || busy} onClick={() => void submit()}>
            {busy ? "Creating…" : side === "buy" ? "Create private bid" : "Create private listing"}
          </button>
        }
      >
        <Segmented value={side} onChange={setSide} block tone={side === "sell" ? "sell" : undefined} label="Side" options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell privately" }]} />
        <div className="field">
          <span className="label">Token</span>
          <input className={`input${token && !valid ? " invalid" : ""}`} placeholder="0x… contract on this chain" value={token} onChange={(e) => setToken(e.target.value.trim())} spellCheck={false} />
          <MarketPicker markets={markets} value={token} onPick={setToken} />
        </div>
        <div className="field">
          <span className="label">Size {symbol ? `(${symbol})` : ""}</span>
          <input className={`input big num${size && !amount && decimals !== null ? " invalid" : ""}`} inputMode="decimal" placeholder="250,000" value={size} onChange={(e) => setSize(e.target.value)} />
        </div>
        <div className="row between" style={{ flexWrap: "wrap", ["--g" as string]: "16px" }}>
          <div className="field">
            <span className="label">Pay with</span>
            <PayPicker value={pay} onChange={setPay} token={symbol} />
            <PayNote pay={pay} />
          </div>
          <div className="field">
            <span className="label">{side === "buy" ? "Sellers" : "Buyers"} reply for</span>
            <Segmented value={win} onChange={setWin} label="Reply window" options={(["15m", "1h", "4h", "24h"] as const).map((v) => ({ value: v, label: v }))} />
          </div>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
          <span>
            <strong>Allow partial fills</strong>
            <span className="hint" style={{ display: "block" }}>Several counterparties can each fill part. Each part settles as its own deal.</span>
          </span>
        </label>
        <div className="field">
          <span className="label">Public note <span className="dim" style={{ textTransform: "none" }}>optional</span></span>
          <input className="input" maxLength={280} placeholder="Can fill in one block" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="infobox">
          <ul>
            <li>No account. You get a private link that controls this block.</li>
            <li>Answers are sealed and signed by their wallet. Only you can read them.</li>
            <li>Settles in one contract transaction, or everyone is refunded.</li>
          </ul>
        </div>
        <ErrorNote error={error} />
      </Drawer>
      {created && (
        <PrivateLinkModal
          open
          kind="rfq"
          link={created}
          onClose={() => {
            setCreated(null);
            setSize("");
            onClose();
          }}
        />
      )}
    </>
  );
}
