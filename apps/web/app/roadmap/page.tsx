import type { Metadata } from "next";

export const metadata: Metadata = { title: "Roadmap" };

type Status = "live" | "next" | "planned" | "research";
const STAGES: { name: string; note: string; items: [string, string, Status][] }[] = [
  {
    name: "00 · Live · trading desk",
    note: "Running on the desk today.",
    items: [
      ["Sealed bids and listings", "Answers are encrypted to you in the sender's browser.", "live"],
      ["OTC desk", "Swap-style form: size in USD or tokens, ETH, USD or the desk token, reply window.", "live"],
      ["Trade page per token", "Paste any contract: price, your balance, one-click sell, open blocks.", "live"],
      ["Token list with logos", "Listed markets in every picker, with logos and checked addresses.", "live"],
      ["Partial fills", "Several counterparties fill one block, each part its own deal.", "live"],
      ["Payment locks first", "Sellers deliver only after the buyer has paid in.", "live"],
      ["Offers vs market", "Each sealed answer shown against the pool price: \"1.8% under market\".", "live"],
      ["Price-impact estimate", "What the same size would cost as a DEX market order, on the forms and the slippage page.", "live"],
      ["Deal receipts", "A public page per settled deal, rebuilt from the settlement transaction.", "live"],
      ["Backup of private links", "Export the keys to your blocks and restore them on another device.", "live"],
    ],
  },
  {
    name: "00 · Live · privacy, agents, trust",
    note: "",
    items: [
      ["Signed answers and funds check", "Every answer is signed by its wallet; fakes are flagged, empty wallets shown.", "live"],
      ["Ghost mode relayer", "Deliver from a one-time wallet; gas paid by the relayer.", "live"],
      ["SDK, OpenAPI, MCP server", "Agents and apps can do everything the site does; the MCP server is a single download.", "live"],
      ["Autopilot", "Trades by your rules 24/7: prices vs market, floors and ceilings, hard caps, dry run by default.", "live"],
      ["Live control panel", "Who controls what, read from the chain and shown on the Security page.", "live"],
      ["Stats and burn tracker", "Volume, deals, fees, saved vs DEX and the buy-and-burn, from contract events.", "live"],
      ["Manual refund helper", "The deal terms ready to paste into a block explorer if this site is ever down.", "live"],
      ["Referral program", "Earn half the protocol fee on deals you bring, paid by the escrow.", "live"],
      ["Buy-and-burn and holder discount", "Fees go to a vault that can only buy the token and burn it; holders pay 0.5% less.", "live"],
      ["Exposure check", "On a Ghost-mode deal, shows which public hops link the one-time wallet back to you.", "live"],
      ["Alerts", "Telegram, email or webhook when an answer arrives or a deal changes step.", "live"],
      ["Pay with the desk token", "Deals paid in the desk's own token: a flat 1.5% fee, burned by the escrow at settlement.", "live"],
    ],
  },
  {
    name: "01 · Next",
    note: "Launch and polish.",
    items: [
      ["Launch the desk token", "Create the token's pool so it has a market price, then queue the vault's burn route (2 days in public).", "next"],
      ["Contracts on mainnet", "Deploy the escrow and vault to the chain and verify the source on the explorer.", "next"],
      ["Fee vault on a multisig", "Governor and keeper held by a Safe, so no single key runs burns or changes the route.", "next"],
    ],
  },
  {
    name: "02 · Medium",
    note: "More ways to trade.",
    items: [
      ["Independent audit", "An outside firm audits the contracts before large sizes.", "planned"],
      ["Team access", "Big buyers send a private request straight to a project's team.", "planned"],
    ],
  },
  {
    name: "03 · Large",
    note: "Locked tokens and the network.",
    items: [
      ["Locked-token OTC", "Sell vesting tokens with the unlock schedule enforced in the contract.", "planned"],
      ["Private RPC relay", "Hide which wallets you read and trade from.", "research"],
    ],
  },
  {
    name: "04 · XL",
    note: "Unlinkable settlement. Built carefully and audited first.",
    items: [
      ["Shielded settlement pool", "Pay and get paid through a zero-knowledge pool.", "research"],
      ["Independent relayer network", "Anyone can run a relayer by bonding the token.", "research"],
    ],
  },
];

const TONE: Record<Status, string> = { live: "badge-buy", next: "badge-info", planned: "badge-warn", research: "badge-dim" };

export default function RoadmapPage() {
  return (
    <div className="wrap page stack" style={{ ["--g" as string]: "28px" }}>
      <div className="page-head">
        <div className="eyebrow">Roadmap</div>
        <h1 className="display">From a private desk to unlinkable settlement.</h1>
        <p>What&apos;s live, what&apos;s next, and the bigger pieces after that. No dates: each step ships when it&apos;s built and tested.</p>
        <div className="row" style={{ flexWrap: "wrap", ["--g" as string]: "8px", marginTop: 16 }}>
          {(Object.keys(TONE) as Status[]).map((s) => (
            <span key={s} className={`badge ${TONE[s]}`}>{s} · {STAGES.flatMap((x) => x.items).filter((i) => i[2] === s).length}</span>
          ))}
        </div>
      </div>
      {STAGES.map((s) => (
        <section key={s.name} className="stack" style={{ ["--g" as string]: "12px" }}>
          <div className="row between">
            <h2 style={{ margin: 0 }}>{s.name}</h2>
            {s.note && <span className="dim">{s.note}</span>}
          </div>
          <div className="grid-3">
            {s.items.map(([t, d, st]) => (
              <div key={t} className="panel panel-pad stack" style={{ ["--g" as string]: "8px" }}>
                <div className="row between">
                  <strong>{t}</strong>
                  <span className={`badge ${TONE[st]}`}>{st}</span>
                </div>
                <span className="muted" style={{ fontSize: 13 }}>{d}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
