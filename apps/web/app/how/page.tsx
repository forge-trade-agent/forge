import type { Metadata } from "next";
import Link from "next/link";
import { BRAND, CHAIN_NAME } from "@/lib/config";

export const metadata: Metadata = { title: "How it works" };

const T = `$${BRAND.token}`;

/** Illustrative values only: the cards show what each step looks like, not a real deal. */
export default function HowPage() {
  return (
    <div className="wrap page">
      <div className="page-head">
        <div className="eyebrow">How it works</div>
        <h1 className="display">Size moves.<span className="second">The chart doesn&apos;t.</span></h1>
        <p>Four steps from a private post to a settlement on {CHAIN_NAME}. Every step is a public transaction you can check, except the prices: those stay sealed until someone deposits.</p>
      </div>

      <div className="how-steps">
        <section className="how-step" id="post">
          <div>
            <span className="eyebrow">01 · Post</span>
            <h2 className="display">Bid or list a block.</h2>
            <p>Name the token, the size, ETH, USD or {T}, and how long the other side can reply: 15 minutes to 24 hours. No account. You get a private link, and the block shows up in the terminal so the other side can find it. Other traders see the token and the size, nothing else.</p>
          </div>
          <div className="how-card" aria-label="Example bid">
            <div className="row between"><strong>Bid for NVDA</strong><span className="badge badge-buy">Buy</span></div>
            <div className="row between"><span className="k">Size</span><span className="num">$400,000</span></div>
            <div className="row between"><span className="k">Pay in</span><span>USD</span></div>
            <div className="row between"><span className="k">Replies open for</span><span>4 hours</span></div>
            <div className="foot">Key · <code>/rfq/7c2e…#k=••••••</code> · your private link</div>
          </div>
        </section>

        <section className="how-step" id="answers">
          <div>
            <span className="eyebrow">02 · Seal</span>
            <h2 className="display">Get sealed answers.</h2>
            <p>Sellers answer a bid, buyers answer a listing. Each price is encrypted in their browser to a key only your link holds, and signed by the wallet it names, so nobody can answer in someone else&apos;s name. Our server stores ciphertext it can&apos;t read, and other answerers can&apos;t see it, so there is nothing to front-run.</p>
          </div>
          <div className="how-card" aria-label="Example answers">
            <div className="row between"><strong>Answers to your bid</strong><span className="dim" style={{ fontSize: 12 }}>only you can read them</span></div>
            {[["signed", "funded", "badge-buy"], ["signed", "funded", "badge-buy"], ["unverified", "no funds", "badge-sell"]].map(([a, b, c], i) => (
              <div key={i} className="row between"><span className="sealed">••••••</span><span className="row" style={{ ["--g" as string]: "6px" }}><span className={`badge ${c}`}>{a}</span><span className="badge badge-dim">{b}</span></span></div>
            ))}
            <div className="foot">Our server sees <code>4b1d90c2e7…f03a</code> (ciphertext)</div>
          </div>
        </section>

        <section className="how-step" id="accept">
          <div>
            <span className="eyebrow">03 · Accept</span>
            <h2 className="display">Pick one. The terms lock.</h2>
            <p>Accepting an answer fixes the deal: both wallets, the token, the amount, the price and a deadline. The deal id is the hash of those terms, so a deposit can never be redirected to different ones.</p>
          </div>
          <div className="how-card" aria-label="Example deal terms">
            <div className="row between"><strong>Deal terms</strong><span className="badge badge-dim">Fixed</span></div>
            <div className="row between"><span className="k">Buyer</span><span className="num">0x4e1a…9b20</span></div>
            <div className="row between"><span className="k">Seller</span><span className="num">one-time 0x2c7f…11de</span></div>
            <div className="row between"><span className="k">Gets</span><span className="num">2,626 NVDA</span></div>
            <div className="row between"><span className="k">Pays</span><span className="num">$400,000 USD</span></div>
            <div className="row between"><span className="k">Deadline</span><span>in 2 hours</span></div>
            <div className="foot">deal id = keccak256(terms) → <code>0x91d3…e47a</code></div>
          </div>
        </section>

        <section className="how-step" id="settle">
          <div>
            <span className="eyebrow">04 · Settle</span>
            <h2 className="display">Swap in one transaction.</h2>
            <p>The payment locks into the contract first, then the tokens. The seller&apos;s delivery swaps both sides in that same transaction. If the deadline passes first, the buyer gets the payment back. The contract has no owner, no admin key, no pause and no upgrade.</p>
          </div>
          <div className="how-card" aria-label="Example settlement">
            <div className="how-flow">
              <div><span className="label">Buyer</span><strong className="num">$400,000</strong><span className="dim">USD</span></div>
              <div className="mid"><span className="label">Contract</span><strong>1 transaction</strong><span className="dim">no admin key</span></div>
              <div><span className="label">Seller</span><strong className="num">2,626</strong><span className="dim">NVDA</span></div>
            </div>
          </div>
        </section>

        <section className="how-step" id="ghost">
          <div>
            <span className="eyebrow">Ghost mode · sellers</span>
            <h2 className="display">Deliver from a one-time wallet.</h2>
            <p>Your answer can name a one-time wallet made in your browser. After acceptance you move the tokens into it, and the relayer delivers them with a signed permit, paying the gas. Proceeds go to the address you choose, ideally a fresh one. The relayer takes a small fee from the proceeds.</p>
          </div>
          <div className="how-grid2">
            <div><strong>What it hides</strong><p>The buyer, and anyone watching the contract, only ever see the one-time wallet.</p></div>
            <div><strong>What it doesn&apos;t</strong><p>The transfer into the one-time wallet is public, so on-chain analysis can still connect them. It is not a mixer.</p></div>
          </div>
        </section>

        <section id="fees">
          <span className="eyebrow">Fees</span>
          <h2 className="display" style={{ fontSize: "var(--t-h2)", margin: "12px 0 24px" }}>Free to post.<span className="second" style={{ display: "block", color: "#5f5f5a" }}>Paid only when it settles.</span></h2>
          <table className="table">
            <thead><tr><th>Deal size</th><th>Fee</th><th>Holding {T}</th></tr></thead>
            <tbody>{[["Under $10k", "2.5%", "2.0%"], ["From $10k", "2.0%", "1.5%"], ["From $100k", "1.5%", "1.0%"]].map(([a, b, c]) => <tr key={a}><td>{a}</td><td className="num">{b}</td><td className="num up">{c}</td></tr>)}</tbody>
          </table>
          <ul className="muted" style={{ marginTop: 16 }}>
            <li>The contract caps the fee at 2.5%.</li>
            <li>Partners earn half the fee: share any page with <code>?ref=0xYourWallet</code>.</li>
            <li>Fees buy {T} and send it to the burn address.</li>
            <li>Paying in {T}: a flat 1.5% at any size, burned in the settlement transaction itself.</li>
          </ul>
        </section>

        <section id="limits">
          <span className="eyebrow">Limits</span>
          <h2 className="display" style={{ fontSize: "var(--t-h2)", margin: "12px 0 24px" }}>Good to know.</h2>
          <div className="how-limits">
            <div><strong>{CHAIN_NAME} only</strong><p>Every block, deposit and settlement happens there.</p></div>
            <div><strong>Plain tokens only</strong><p>Tokens that take a fee on transfer are rejected by the contract.</p></div>
            <div><strong>Final once settled</strong><p>There is no undo after the swap. Check the terms before you deposit.</p></div>
            <div><strong>Not a regulated venue</strong><p>It is a sealed-bid OTC market. Check the rules where you live.</p></div>
          </div>
        </section>

        <section className="cta" style={{ paddingTop: 24 }}>
          <h2 className="display silver cta-title">Ready when<span className="accent">you are.</span></h2>
          <p>The full details, including the privacy model and the API, are in the docs.</p>
          <div className="row" style={{ justifyContent: "center", flexWrap: "wrap" }}>
            <Link href="/app" className="btn btn-lg btn-buy">Open the desk</Link>
            <Link href="/docs" className="btn btn-lg">Read the docs</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
