import Link from "next/link";
import { FrontierHero, HowScene } from "@/components/frontier";
import { AgentTerminal, MarketCount, MarketMarquee, Pipeline, TimelockCard, TokenStrip, ViewAs, WalletChecker } from "@/components/landing";
import { MarketsBoard } from "@/components/Markets";
import { Copy } from "@/components/ui";
import { API_URL, BRAND } from "@/lib/config";
import { SITEMAP } from "@/lib/sitemap";

function Head({ n, k, title, second, link }: { n: string; k: string; title: string; second: string; link?: [string, string] }) {
  return (
    <div className="section-head" data-reveal>
      <div>
        <div className="eyebrow">{k} <span style={{ color: "var(--dim)" }}>· {n} / 06</span></div>
        <h2 className="display">
          {title}
          <span className="second">{second}</span>
        </h2>
      </div>
      {link && <Link href={link[0]} className="btn btn-ghost">{link[1]} →</Link>}
    </div>
  );
}

const FAQ: [string, string][] = [
  ["Do I need an account?", "No. Posting gives you a private link; the key to your answers lives in that link and in this browser. No email, no KYC, no sign-up."],
  ["What can I trade?", "The listed stock tokens and ETFs, the platform token, or any ERC-20 on the chain by pasting its contract. Pay in ETH, the desk stablecoin or $" + BRAND.token + " itself."],
  ["Can you take my funds?", "No. Deposits sit in an escrow contract with no owner, no admin key, no pause and no upgrade. Funds only move to settle a deal or refund it after the deadline."],
  ["Is it audited?", "The contracts have an internal review and a large test suite (unit, fuzz, invariant and end-to-end on a real chain). An independent audit is required before large sizes."],
  ["What does it cost?", "Free to post and answer. A fee only when a deal settles: 2.5% under $10k, 2% from $10k, 1.5% from $100k, capped at 2.5% in the contract. Holders pay 0.5% less."],
  ["Is it anonymous?", "Private, not anonymous. Prices and intent stay sealed, but once a side deposits the deal is public on-chain like any transaction. Ghost mode keeps your main wallet out of it."],
];

export default function Landing() {
  return (
    <>
      <FrontierHero />
      <MarketMarquee />

      <div className="wrap">
        <section className="section">
          <div className="section-head" data-reveal>
            <div>
              <div className="eyebrow">Everything on {BRAND.name}</div>
              <h2 className="display">Every page,<span className="second">one click away.</span></h2>
            </div>
            <p className="muted" style={{ margin: 0, maxWidth: 360 }}>Trade, check the numbers, or read how it works.</p>
          </div>
          <div className="sitemap">
            {SITEMAP.map((g) => (
              <div key={g.key} data-reveal>
                <h3 className="eyebrow">{g.label}</h3>
                <ul>
                  {g.links.map((l) => (
                    <li key={l.href}><Link href={l.href}><strong>{l.label}</strong><span>{l.desc}</span></Link></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="section">
          <Head n="01" k="Markets" title="Pick a market." second="Keep your price." link={["/markets", "All markets"]} />
          <div data-reveal><MarketsBoard compact /></div>
        </section>

        <section className="section">
          <Head n="02" k="Privacy" title="Your price is yours." second="Nobody else reads it." />
          <ul className="feature-list">
            {[
              ["01", "Sealed answers", "Every price is encrypted in the sender's browser to your key. Our server stores ciphertext it can't open."],
              ["02", "No accounts", "No email, no KYC, no sign-up. A private link is the only key to your block."],
              ["03", "Ghost mode", "Settle from a one-time wallet and let the relayer pay the gas, so the deal never names your main wallet."],
            ].map(([n, t, d]) => (
              <li key={n} data-reveal><span className="eyebrow">{n}</span><strong>{t}</strong><p>{d}</p></li>
            ))}
          </ul>
          <div className="grid-2" style={{ marginTop: 56, gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.2fr)", alignItems: "center" }}>
            <div className="stack" style={{ ["--g" as string]: "14px" }}>
              <h3 className="display" style={{ fontSize: "clamp(22px, 2.2vw, 32px)", margin: 0 }}>See what each side sees.</h3>
              <p className="muted" style={{ margin: 0 }}>Switch the view. Other traders and our server see that a block exists and its size. The counterparty sees the terms once you accept. Only you see every price.</p>
              <p className="hint" style={{ margin: 0 }}>Private, not anonymous: once a side deposits, the deal is public on-chain like any transaction.</p>
            </div>
            <div data-reveal><ViewAs /></div>
          </div>
        </section>

      </div>
      <div style={{ paddingTop: "clamp(48px, 6vw, 96px)" }}><HowScene /></div>
      <div className="wrap">
        <section style={{ paddingTop: 48 }} data-reveal>
          <div className="row between" style={{ flexWrap: "wrap", marginBottom: 16 }}>
            <span className="eyebrow">Live simulation · three outcomes</span>
            <Link href="/how" className="link">The full walk-through →</Link>
          </div>
          <Pipeline />
        </section>

        <section className="section">
          <Head n="04" k="Agents & builders" title="Or just ask." second="From your terminal." />
          <div className="grid-2">
            <div data-reveal><AgentTerminal /></div>
            <div className="stack" style={{ ["--g" as string]: "14px" }}>
              <p className="muted" style={{ margin: 0 }}>Plug the desk into any MCP-capable AI agent. It posts, reads sealed answers and settles, with your keys on your machine. Value-moving tools need an explicit confirm.</p>
              <div className="codebox row between"><code>node forge-mcp.mjs</code><Copy text="node forge-mcp.mjs" label="Copy the MCP command" /></div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <Link href="/developers#mcp" className="btn">Set up the MCP server →</Link>
                <a href={`${API_URL}/sdk/forge.mjs`} className="btn">SDK →</a>
                <a href={`${API_URL}/openapi.json`} className="btn">OpenAPI →</a>
              </div>
            </div>
          </div>
        </section>

        <section className="section">
          <Head n="05" k={`The token · $${BRAND.token}`} title={`Every deal buys $${BRAND.token}.`} second="Then burns it." />
          <p className="muted" style={{ marginTop: -24, marginBottom: 48, maxWidth: 640, fontSize: 17 }}>Utility first: the desk works without a token. Two rules are written into the contracts and apply to every deal: fees buy and burn ${BRAND.token}, and holders pay less.</p>
          <ol className="feature-list four">
            {[["01", "A deal settles", "Buyer and seller swap in one contract transaction."], ["02", "Fee goes to the vault", "The protocol's share, in ETH or USD, lands in the buy-and-burn vault."], ["03", "The vault buys the token", "Through its timelocked route, with a minimum-out check."], ["04", "Burned for good", `Bought tokens go straight to 0x…dEaD. Deals paid in $${BRAND.token} skip the vault: a flat 1.5% fee, burned in the settlement transaction.`]].map(([n, t, d]) => (
              <li key={n} data-reveal><span className="eyebrow">{n}</span><strong>{t}</strong><p>{d}</p></li>
            ))}
          </ol>
          <div className="grid-2" style={{ marginTop: 56 }}>
            <div className="panel">
              <div className="panel-head"><span className="panel-title">Hold ${BRAND.token}, pay 0.5% less on every deal.</span></div>
              <table className="table">
                <thead><tr><th>Deal size</th><th>Fee</th><th>Holding ${BRAND.token}</th></tr></thead>
                <tbody>
                  {[["Under $10k", "2.5%", "2.0%"], ["From $10k", "2.0%", "1.5%"], ["From $100k", "1.5%", "1.0%"]].map(([a, b, c]) => (
                    <tr key={a}><td>{a}</td><td className="num">{b}</td><td className="num up">{c}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="hint" style={{ padding: "0 16px 16px" }}>Either side of the deal holding the minimum is enough; the contract checks both wallets at settlement.</p>
            </div>
            <div className="stack" style={{ ["--g" as string]: "16px" }}>
              <WalletChecker />
              <TimelockCard />
            </div>
          </div>
          <div style={{ marginTop: 24 }}><TokenStrip /></div>
          <p className="hint" style={{ marginTop: 24, maxWidth: 640 }}>${BRAND.token} is a utility token for this desk, not an investment. Burns depend on how much trades here, and nothing on this page promises a price or a return.</p>
        </section>

        <section className="section">
          <Head n="06" k="FAQ" title="Questions." second="More in the docs." link={["/docs", "Docs"]} />
          <div className="faq">
            {FAQ.map(([q, a]) => (
              <details key={q} data-reveal>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="cta">
          <h2 className="display silver cta-title" data-reveal>Moving size?<span className="accent">Keep it private.</span></h2>
          <p><MarketCount /></p>
          <div className="row" style={{ justifyContent: "center", flexWrap: "wrap" }}>
            <Link href="/app" className="btn btn-lg btn-buy">Open the desk</Link>
            <Link href="/trade?side=sell" className="btn btn-lg">Sell privately</Link>
          </div>
        </section>
      </div>
    </>
  );
}
