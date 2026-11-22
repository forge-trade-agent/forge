import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/Content";
import { DocsContracts, DocsFacts, DocsStart } from "@/components/DocsLive";
import { Copy } from "@/components/ui";
import { API_URL, BRAND } from "@/lib/config";

export const metadata: Metadata = { title: "Docs" };

const T = `$${BRAND.token}`;

const REST = `GET  ${API_URL}/markets                     listed markets, reference prices
GET  ${API_URL}/markets/{symbol}/chart        candles (?range=1D|5D|1M|6M|1Y)
GET  ${API_URL}/rfqs                          open bids and listings
POST ${API_URL}/rfqs                          post a bid or listing
POST ${API_URL}/rfqs/{id}/quotes              send a sealed answer
POST ${API_URL}/rfqs/{id}/accept              accept one (needs the private link)
GET  ${API_URL}/token/{address}               ERC-20 facts read on-chain
GET  ${API_URL}/stats                         desk totals and burns
GET  ${API_URL}/control                       who controls what, read from the chain
GET  ${API_URL}/referrals/{address}           what a referrer earned
GET  ${API_URL}/openapi.json                  the full spec`;

const FAQ: [string, string][] = [
  ["Do I need an account?", "No. Posting gives you a private link; the key to your answers lives in that link and in your browser. No email, no KYC, no sign-up."],
  ["Who can read the prices?", "Only the person who posted the block. Each answer is encrypted in the sender's browser to the poster's key. Our server stores ciphertext."],
  ["Can you take my funds?", "No. Deposits sit in an escrow with no owner, no admin key, no pause and no upgrade. Funds only move to settle a deal or to refund it after the deadline."],
  ["Is it audited?", "The contracts have an internal review and a test suite (unit, fuzz, invariant, and end-to-end on a real chain). An independent audit is planned before large sizes."],
  ["Is it anonymous?", "Private, not anonymous. Prices and intent stay sealed while negotiating, but once a side deposits, the deal is public on-chain. Ghost mode keeps your main wallet out of it."],
  ["What if the other side never deposits?", "Nothing settles. After the deal deadline anyone can call refund, and the payment goes back to the buyer. Tokens are never locked before the payment is in."],
  [`Do I need ${T}?`, `No. The desk works without it. Holding the minimum only lowers your fee by 0.5%.`],
];

export default function DocsPage() {
  return (
    <ContentPage
      eyebrow="Docs"
      title="How the desk works, end to end."
      intro="Posting a block, reading sealed answers, settling in one transaction, the privacy model, fees, the token and the API. Every contract, who can do what, what we store and what can go wrong."
      lead={<><DocsFacts /><DocsStart /></>}
      sections={[
        {
          id: "features",
          title: "Live features",
          body: (
            <ul className="docs-features">
              {[
                ["Sealed bids and listings", "Post a bid to buy or a block to sell. Answers are encrypted to you in the sender's browser.", "/app"],
                ["OTC desk", `Swap-style form: size in USD or tokens, pay in ETH, USD or ${T}, reply window.`, "/otc"],
                ["Trade any token", "Paste a contract: price, your balance, one-click sell, open blocks for that token.", "/trade"],
                ["Partial fills", "Several counterparties fill one big block, each part its own deal.", "/app"],
                ["Price-impact estimate", "Before you post, see what the same size would cost as a DEX market order.", "/slippage"],
                ["Offers vs market", "Each sealed answer shows how far it is from the token's pool price.", "/app"],
                ["Signed answers and funds check", "Every answer is signed by its wallet; fakes are flagged, empty wallets shown.", "/security"],
                ["Ghost mode", "Deliver from a one-time wallet; the relayer pays the gas.", "/how#ghost"],
                ["Deal receipts", "A public page per settled deal, rebuilt from the settlement transaction.", "/stats"],
                ["Backup of private links", "Export the keys to your blocks to a file and restore them elsewhere.", "/mine"],
                ["Referral program", "Earn half the protocol fee on deals you bring, paid by the escrow at settlement.", "/refer"],
                ["Buy-and-burn and holder discount", `Fees go to a vault that can only buy ${T} and burn it. Holders pay 0.5% less.`, "/stats"],
                [`Pay with ${T}, fee burned instantly`, `Deals can be paid in ${T}: a flat 1.5% fee, burned by the escrow in the settlement transaction.`, "/otc"],
                ["Stats and live control panel", "Volume, deals, fees and burns, plus who controls what, read from the chain.", "/security"],
                ["SDK, REST API and MCP server", "Agents and apps can do everything the site does.", "/developers"],
                ["Autopilot", "An agent that trades by your rules 24/7, with hard caps and a dry run by default.", "/developers#autopilot"],
              ].map(([t, d, href]) => (
                <li key={t}><span className="badge badge-buy">Live</span><span><strong>{t}</strong><span className="muted">{d}</span></span><Link className="link" href={href!}>Open →</Link></li>
              ))}
            </ul>
          ),
        },
        {
          id: "posting",
          title: "Posting a block",
          body: (
            <>
              <p>A block is one side&apos;s intent, posted privately. There are two kinds:</p>
              <ul>
                <li><strong>Bid (you buy).</strong> You set the size in USD (from $5) and the token. Sellers answer with an amount and a price.</li>
                <li><strong>Listing (you sell).</strong> You set the token amount. Buyers answer with the price for the whole block.</li>
              </ul>
              <table className="table"><tbody>
                <tr><td>Pay in</td><td>ETH, the desk&apos;s USD stablecoin, or {T}</td></tr>
                <tr><td>Reply window</td><td>15 minutes to 24 hours</td></tr>
                <tr><td>Partial fills</td><td>optional: several counterparties can each take part</td></tr>
                <tr><td>Cost to post</td><td>free</td></tr>
              </tbody></table>
              <p>Posting returns a private link. It is the only key to your block: whoever holds it can read the answers and accept one. It is saved in this browser; back it up on <Link className="link" href="/mine">My blocks</Link> before switching devices.</p>
            </>
          ),
        },
        {
          id: "answers",
          title: "Sealed answers",
          body: (
            <>
              <p>Every answer is encrypted in the sender&apos;s browser to the poster&apos;s public key (X25519 + XSalsa20-Poly1305) before it leaves the device. The server stores and relays ciphertext it can&apos;t open; only the poster&apos;s browser holds the key.</p>
              <p>Each answer is also signed by the wallet that sent it (EIP-712), and checked when you open it:</p>
              <ul>
                <li><strong>signed:</strong> the signature matches the wallet named in the answer.</li>
                <li><strong>funded:</strong> that wallet holds what it would have to deposit, read on-chain.</li>
                <li><strong>unverified:</strong> anything that fails is ranked last, and accepting it needs an explicit confirmation.</li>
              </ul>
            </>
          ),
        },
        {
          id: "settlement",
          title: "Settlement and the contract",
          body: (
            <ol>
              <li><strong>Accept.</strong> You pick an answer. The terms (both wallets, token, amount, price, payout, deadline) are fixed and hashed into the deal id.</li>
              <li><strong>Payment locks first.</strong> The buyer deposits ETH, USD or the desk token. The seller only deposits once the payment is in, so nobody locks tokens for nothing.</li>
              <li><strong>Delivery settles.</strong> When the seller&apos;s tokens arrive, the escrow swaps both sides in the same transaction: tokens to the buyer, payment minus the fee to the seller.</li>
              <li><strong>Or the buyer is refunded.</strong> If the deadline passes first, anyone can call <code>refund</code> and the payment goes back to the buyer. Nobody can block it.</li>
              <li><strong>Gasless and Ghost mode.</strong> Tokens with EIP-2612 permit can be delivered with a signature; in Ghost mode a relayer submits it from a one-time wallet and pays the gas.</li>
              <li><strong>Exposure check.</strong> On a Ghost-mode answer, the <a className="link" href="/exposure">exposure check</a> scans public token transfers and the deal terms for hops that link the one-time wallet back to your wallets: a payout to your main wallet, funding straight from it, or a funder that has traded with it. It runs in your browser against the chain RPC.</li>
            </ol>
          ),
        },
        {
          id: "markets",
          title: "Markets and prices",
          body: (
            <>
              <p>The market board lists tokens checked on the chain: stock tokens, index ETFs and the desk&apos;s own token. Any other ERC-20 can be traded by pasting its address. Tokens that take a fee on transfer are rejected by the escrow.</p>
              <p>Prices shown are reference prices: the listed stock&apos;s, delayed, or a token&apos;s DEX pool price. Our server fetches and caches them, so your browser never calls a data provider. The on-chain token can trade away from them, and your block settles at the price you accept.</p>
              <Link className="link" href="/markets">Open the market board →</Link>
            </>
          ),
        },
        {
          id: "fees",
          title: `Fees and ${T}`,
          body: (
            <>
              <p>Posting and answering are free. A fee is taken only when a deal settles, from the payment:</p>
              <table className="table">
                <thead><tr><th>Deal size</th><th>Fee</th><th>Holding {T}</th></tr></thead>
                <tbody>{[["Under $10k", "2.5%", "2.0%"], ["From $10k", "2.0%", "1.5%"], ["From $100k", "1.5%", "1.0%"]].map(([a, b, c]) => <tr key={a}><td>{a}</td><td className="num">{b}</td><td className="num up">{c}</td></tr>)}</tbody>
              </table>
              <ul>
                <li>The fee is capped at 2.5% in the contract and can&apos;t be raised.</li>
                <li>A referrer named in the deal earns half of the fee, paid by the escrow at settlement. <Link className="link" href="/refer">Get your link →</Link></li>
                <li>The protocol&apos;s share goes to the fee vault, which can only buy {T} and send it to the burn address.</li>
                <li>If the buyer or the seller holds the minimum {T}, the fee drops by 0.5%.</li>
                <li><strong>Paying in {T}:</strong> a flat 1.5% at any size, and the escrow sends the desk&apos;s share straight to the burn address in the settlement transaction: no vault, no keeper, no waiting. A referrer still gets half. The holder discount doesn&apos;t stack on top.</li>
              </ul>
              <p className="hint">{T} is a utility token for this desk, not an investment. Nothing here promises a price or a return.</p>
            </>
          ),
        },
        {
          id: "agents",
          title: "For agents: MCP, SDK, API",
          body: (
            <>
              <p>Agents use the same desk as people. Keys and decryption stay on the agent&apos;s machine; the server only sees what a browser would send.</p>
              <p><strong>MCP server.</strong> A single file the agent runs locally, with 11 tools. Setup on the <Link className="link" href="/developers#mcp">Developers page</Link>.</p>
              <p><strong>JavaScript SDK.</strong> <code>{API_URL}/sdk/forge.mjs</code>, for browsers and Node.</p>
              <p><strong>REST API.</strong></p>
              <div className="codebox" style={{ position: "relative" }}>
                <pre style={{ margin: 0, whiteSpace: "pre", overflowX: "auto", fontSize: 12 }}>{REST}</pre>
                <span style={{ position: "absolute", top: 10, right: 10 }}><Copy text={REST} label="Copy the API list" /></span>
              </div>
            </>
          ),
        },
        {
          id: "privacy",
          title: "Privacy model",
          body: (
            <>
              <p>Private, not anonymous. Exactly who sees what:</p>
              <table className="table">
                <thead><tr><th /><th>While negotiating</th><th>After a deposit</th></tr></thead>
                <tbody>
                  <tr><td>Token and size</td><td>visible to everyone</td><td>public on-chain</td></tr>
                  <tr><td>Prices in answers</td><td>sealed: only the poster</td><td>the accepted one is public on-chain</td></tr>
                  <tr><td>Wallets</td><td>hidden from other traders</td><td>public on-chain (or a one-time wallet)</td></tr>
                  <tr><td>Our server</td><td>ciphertext, plus timing and IP like any website</td><td>the accepted terms</td></tr>
                </tbody>
              </table>
            </>
          ),
        },
        { id: "contracts", title: "Contracts and how to verify", body: <DocsContracts /> },
        {
          id: "admin",
          title: "Why admin keys: 0",
          body: (
            <>
              <p>Many contracts have an admin key: a wallet that can pull funds, pause, swap the code or raise fees. If it is abused or stolen, every user&apos;s money goes with it. The escrow that holds your deposits has none: no owner, no admin role, no pause, no proxy, no function to change fees. Its settings were fixed at deploy.</p>
              <p>Every function that changes anything:</p>
              <table className="table">
                <tbody>
                  <tr><td><code>depositPayment</code></td><td>Only the buyer named in the deal. Locks the payment.</td></tr>
                  <tr><td><code>deliver</code> / <code>deliverWithPermit</code></td><td>Only the seller named in the deal. Delivers the tokens; with the payment in, both sides swap in this transaction.</td></tr>
                  <tr><td><code>deliverFor</code></td><td>A relayer, only with the seller&apos;s signature for this exact deal and this relayer (Ghost mode).</td></tr>
                  <tr><td><code>refund</code></td><td>Anyone, only after the deadline. The payment goes back to the buyer, never anywhere else.</td></tr>
                  <tr><td><code>claim</code></td><td>Whoever is owed a payout that couldn&apos;t be pushed, to an address they choose.</td></tr>
                </tbody>
              </table>
              <p>That is the complete list; everything else only reads. The code is in the repository, with {51} contract tests including fuzz and invariant tests.</p>
            </>
          ),
        },
        {
          id: "who",
          title: "Who can do what",
          body: (
            <table className="table">
              <tbody>
                {[
                  ["Post a bid or listing, send a sealed answer", "Anyone"],
                  ["Read the prices in sealed answers", "Only the poster (keys in their browser)"],
                  ["Accept an answer", "Whoever holds the block's private link"],
                  ["Deposit the payment", "Only the buyer named in the deal"],
                  ["Deliver the tokens", "Only the seller named in the deal, or the relayer with the seller's signature"],
                  ["Change price, amount, payout or deadline after accepting", "Nobody: any change is a different deal id"],
                  ["Refund after the deadline", "Anyone; the payment only goes back to the buyer"],
                  ["Pause, upgrade or change the escrow", "Nobody"],
                  ["Raise the fee above 2.5%", "Nobody"],
                  ["Withdraw fees from the vault", `Nobody. They can only buy ${T} and burn it`],
                  ["Change the burn route", "The vault governor, after a public 2-day wait"],
                ].map(([a, b]) => <tr key={a}><td>{a}</td><td className="muted">{b}</td></tr>)}
              </tbody>
            </table>
          ),
        },
        {
          id: "safety",
          title: "Safety and worst cases",
          body: (
            <table className="table">
              <tbody>
                {[
                  ["A bug in the escrow", "Tests and review reduce the risk but can't rule out every bug. Funds sit in the contract only between the two deposits."],
                  ["Our server goes down", "You can't post or read answers, but deposits are never stuck: after the deadline anyone can call refund from a block explorer. The deal panel has the terms ready to copy."],
                  ["Our server or website is compromised", "It could show a wrong page. It still can't read sealed prices or move funds; check the terms before you deposit."],
                  ["The relayer key leaks", "It can only submit deliveries sellers already signed for that relayer. Keep its ETH balance small."],
                  ["The vault governor acts badly", "It could only spend fees already in the vault, and a route change waits 2 days in public. Deposits are not affected."],
                  ["You lose your private link", "Nobody can recover it. Your deposits are still safe: they refund after the deadline."],
                ].map(([a, b]) => <tr key={a}><td><strong>{a}</strong></td><td className="muted">{b}</td></tr>)}
              </tbody>
            </table>
          ),
        },
        {
          id: "data",
          title: "Data we keep and third parties",
          body: (
            <>
              <table className="table">
                <tbody>
                  <tr><td>Postings</td><td className="muted">token, side, size, pay token, optional public note, reply window</td></tr>
                  <tr><td>Sealed answers</td><td className="muted">ciphertext we can&apos;t decrypt, plus the sender&apos;s one-off encryption key</td></tr>
                  <tr><td>Private-link tokens</td><td className="muted">only their hashes</td></tr>
                  <tr><td>Accepted deals</td><td className="muted">the deal terms (public on-chain at the first deposit anyway)</td></tr>
                  <tr><td>Not stored</td><td className="muted">accounts, emails, names, cookies, analytics</td></tr>
                </tbody>
              </table>
              <p>Services involved: the market data providers our server fetches prices from (a DEX price feed, and a delayed stock price feed when configured), your wallet&apos;s RPC for on-chain reads and transactions, and the hosting provider. Fonts are served from this site.</p>
            </>
          ),
        },
        {
          id: "troubleshooting",
          title: "Troubleshooting",
          body: (
            <table className="table">
              <tbody>
                {[
                  ["\"This private link is incomplete\"", "Open the full saved link, including everything after #. That part never reaches our server."],
                  ["\"Connect the buyer (or seller) wallet\"", "Switch your wallet to the address named in the deal."],
                  ["The seller can't deposit yet", "Payment locks first: delivery opens once the buyer has paid in."],
                  ["Ghost mode is greyed out", "The token has no gasless approvals (EIP-2612). Deliver from your wallet instead."],
                  ["\"Transaction reverted\"", "Usually the deadline passed or a balance is short. After the deadline, use Refund."],
                  ["Bids start at $5", "Pick a token or paste its address, and post at least $5."],
                ].map(([a, b]) => <tr key={a}><td><strong>{a}</strong></td><td className="muted">{b}</td></tr>)}
              </tbody>
            </table>
          ),
        },
        { id: "next", title: "In development", body: <p>What is live, what is next and the larger pieces after that are on the <Link className="link" href="/roadmap">roadmap</Link>. Anything involving funds ships only after testing and review.</p> },
        {
          id: "terms",
          title: "Terms",
          body: (
            <ul>
              <li>Not financial, legal or tax advice. Nothing here promises a price or a return.</li>
              <li>The software is provided as is. Trades settle on-chain and are final.</li>
              <li>Not a regulated venue. You are responsible for following the rules where you live, including restrictions on stock tokens.</li>
              <li>Deposits are controlled by the contract and the two parties to a deal, not by us.</li>
            </ul>
          ),
        },
        {
          id: "faq",
          title: "FAQ",
          body: <div className="faq">{FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>,
        },
      ]}
    />
  );
}
