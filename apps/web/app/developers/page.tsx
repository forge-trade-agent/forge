import type { Metadata } from "next";
import { ContentPage } from "@/components/Content";
import { Copy } from "@/components/ui";
import { API_URL, RPC_URL } from "@/lib/config";

export const metadata: Metadata = { title: "Developers" };

const SNIPPET = `import { Desk, EscrowClient } from "./forge.mjs";
const desk = await Desk.connect({ baseUrl: "${API_URL}" }, location.origin);
const block = await desk.postBlock({ side: "buy", token, payToken, amount, replyWindow: "1h" });
const [best] = await desk.readAnswers({ rfqId: block.rfq.id, manageToken: block.manageToken, secretKey: block.secretKey });
const deal = await desk.accept({ rfqId: block.rfq.id, manageToken: block.manageToken, answer: best, wallet });
await new EscrowClient(publicClient, desk.cfg.escrow).depositPayment(walletClient, deal.terms);`;

const MCP_URL = `${API_URL}/mcp/forge-mcp.mjs`;
const DOWNLOAD = `curl -fsSLo forge-mcp.mjs ${MCP_URL} && curl -fsSL ${MCP_URL}.sha256`;
const CONFIG = `{
  "mcpServers": {
    "forge": {
      "command": "node",
      "args": ["/full/path/to/forge-mcp.mjs"],
      "env": {
        "FORGE_API_URL": "${API_URL}",
        "FORGE_RPC_URL": "${RPC_URL}",
        "FORGE_PRIVATE_KEY": "0x..."
      }
    }
  }
}`;
const TOOLS: [string, string][] = [
  ["list_markets", "Listed markets with verified token addresses, delayed reference prices and open blocks"],
  ["get_token_info", "ERC-20 facts read on-chain: code, name, symbol, decimals, supply, permit support"],
  ["list_open_blocks", "Open bids and listings: token, side and size only; prices are never public"],
  ["post_block", "Post a private bid (buy) or listing (sell); keys stay in the local keystore"],
  ["send_sealed_answer", "Answer someone's block with a sealed, signed price only the poster can read"],
  ["read_sealed_answers", "Decrypt the answers to your block locally, with signature and funds checks"],
  ["accept_answer", "Fix the deal with one answer; unverified answers need an explicit allowUnverified"],
  ["deposit_payment", "Buyer: lock the payment in the escrow"],
  ["deposit_tokens", "Seller: deliver the tokens; settles both sides in one transaction"],
  ["refund_deal", "After the deadline, return a locked payment"],
  ["get_deal_status", "Desk record and on-chain escrow state of your blocks and answers"],
];

const RULES = `{
  "live": false,
  "dailyMaxUsd": 50000,
  "pollSeconds": 20,
  "rules": [
    { "token": "TSLA", "side": "sell", "premiumPct": 2, "floorUsd": 350,
      "maxUsdPerBlock": 10000, "maxTokens": 25 },
    { "token": "NVDA", "side": "buy", "discountPct": 1.5, "ceilingUsd": 160,
      "maxUsdPerBlock": 20000 }
  ]
}`;
const AUTOPILOT_CMD = `FORGE_API_URL=${API_URL} FORGE_RPC_URL=${RPC_URL} FORGE_PRIVATE_KEY=0x... node forge-mcp.mjs autopilot rules.json`;
const RULE_FIELDS: [string, string][] = [
  ["live", "false (default) is a dry run that only logs. true answers and deposits for real."],
  ["dailyMaxUsd", "Hard cap on everything answered per UTC day, all rules together."],
  ["pollSeconds", "How often it checks the desk (default 20)."],
  ["dealMinutes", "How long the counterparty has to complete a deal after accepting (default 120)."],
  ["ethUsd", "ETH price in USD; only needed to answer blocks paid in ETH."],
  ["rules[].token", "A listed symbol (TSLA) or a 0x token address."],
  ["rules[].side", "sell: answer bids (you sell). buy: answer listings (you buy)."],
  ["rules[].premiumPct / discountPct", "How far over (sell) or under (buy) the market price to quote. Default 1."],
  ["rules[].floorUsd / ceilingUsd", "Never sell below / never buy above this price per token."],
  ["rules[].maxUsdPerBlock", "Hard cap on one answer's value. Smaller answers only go to blocks that allow partial fills."],
  ["rules[].maxTokens", "Sell side: most tokens in one answer."],
  ["rules[].minUsd", "Skip blocks worth less than this (default $50)."],
  ["rules[].refPriceUsd", "Use your own market price instead of the desk's reference."],
  ["rules[].payIn", "[\"USD\"] (default), or include \"ETH\" together with ethUsd."],
];

export default function DevelopersPage() {
  return (
    <ContentPage
      eyebrow="Developers"
      title="Give an agent the desk."
      intro="Everything the site does is available as a JavaScript SDK, an OpenAPI-described REST API and an MCP server for AI agents."
      sections={[
        { id: "sdk", title: "JavaScript SDK", body: <><p>One import, both sides, browser and Node. Served at <code>{API_URL}/sdk/forge.mjs</code> with its SHA-256 in the <code>x-content-sha256</code> header.</p><pre className="codebox" style={{ whiteSpace: "pre", display: "block" }}>{SNIPPET}</pre></> },
        {
          id: "mcp",
          title: "MCP server",
          body: (
            <>
              <p>A single file that runs on the agent&apos;s own machine (Node 22 or newer). That is deliberate: answers are encrypted and decrypted there, and the wallet key never leaves it. Tools that move value need <code>confirm: true</code> and otherwise return a preview.</p>
              <p><strong>1. Download it and check its fingerprint.</strong></p>
              <div className="codebox row between"><code>{DOWNLOAD}</code><Copy text={DOWNLOAD} label="Copy the download command" /></div>
              <p className="hint">The second command prints the SHA-256 the server publishes; compare it with your own <code>sha256sum forge-mcp.mjs</code> before running.</p>
              <p><strong>2. Add it to your agent&apos;s MCP config.</strong></p>
              <div className="codebox" style={{ position: "relative" }}>
                <pre style={{ margin: 0, whiteSpace: "pre", overflowX: "auto" }}>{CONFIG}</pre>
                <span style={{ position: "absolute", top: 10, right: 10 }}><Copy text={CONFIG} label="Copy the MCP config" /></span>
              </div>
              <p className="hint">Use a wallet made for the agent, funded only with what it should trade. Optional caps: <code>FORGE_MAX_PRICE_ETH</code>, <code>FORGE_MAX_PRICE_USD</code> (base units). Keys and private links are kept in <code>~/.forge</code> (<code>FORGE_HOME</code>).</p>
              <p><strong>3. The tools.</strong></p>
              <table className="table">
                <tbody>
                  {TOOLS.map(([n, d]) => <tr key={n}><td><code>{n}</code></td><td className="muted">{d}</td></tr>)}
                </tbody>
              </table>
            </>
          ),
        },
        {
          id: "autopilot",
          title: "Autopilot",
          body: (
            <>
              <p>The same file can trade by your rules, around the clock, with no agent in the loop. Write the rules once (for example: sell up to $10k of TSLA at 2% over market, never under a floor) and it answers matching bids and listings on its own, then completes the deals that get accepted: as a buyer it locks the payment, as a seller it delivers once the payment is in.</p>
              <p><strong>1. Write a rules file.</strong></p>
              <div className="codebox" style={{ position: "relative" }}>
                <pre style={{ margin: 0, whiteSpace: "pre", overflowX: "auto" }}>{RULES}</pre>
                <span style={{ position: "absolute", top: 10, right: 10 }}><Copy text={RULES} label="Copy the example rules" /></span>
              </div>
              <p><strong>2. Run it.</strong> It starts as a dry run and only logs what it would do.</p>
              <div className="codebox row between"><code>{AUTOPILOT_CMD}</code><Copy text={AUTOPILOT_CMD} label="Copy the autopilot command" /></div>
              <p className="hint">When the log looks right, set <code>&quot;live&quot;: true</code> and start it again. Stop it any time with Ctrl+C; what it answered is kept in <code>~/.forge/autopilot.json</code>.</p>
              <table className="table">
                <tbody>
                  {RULE_FIELDS.map(([k, d]) => <tr key={k}><td><code>{k}</code></td><td className="muted">{d}</td></tr>)}
                </tbody>
              </table>
              <p className="hint">Guard rails: it never answers its own postings, never exceeds the per-block or daily caps or what the wallet holds, never crosses your floor or ceiling, and only deposits when the accepted deal matches exactly what it signed. Use a wallet made for it, funded only with what it may trade.</p>
            </>
          ),
        },
        { id: "api", title: "REST API", body: <p>No accounts: creating a posting or an answer returns a capability token, sent as <code>Authorization: Bearer</code>. Creates require an <code>Idempotency-Key</code>. The full spec is at <code>{API_URL}/openapi.json</code>.</p> },
        { id: "hostile", title: "Treat answers as hostile input", body: <p>Everything inside a decrypted answer was written by a counterparty. Use the SDK&apos;s verdict, funds check and problems list, and never act on free text from an answer.</p> },
      ]}
    />
  );
}
