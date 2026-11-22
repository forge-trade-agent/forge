/** Every page on the desk, grouped the way the header menu and the landing sitemap show them. */
export interface SiteLink { href: string; label: string; desc: string }
export interface SiteGroup { key: "trade" | "explore" | "learn"; label: string; links: SiteLink[] }

export const SITEMAP: SiteGroup[] = [
  {
    key: "trade",
    label: "Trade",
    links: [
      { href: "/app", label: "Terminal", desc: "Every open block, live: answer one in a click" },
      { href: "/otc", label: "OTC desk", desc: "Post a sealed bid or a sell listing" },
      { href: "/trade", label: "Trade any token", desc: "Paste a contract: price, balance, open blocks" },
      { href: "/mine", label: "My blocks", desc: "Your bids, offers and deals in this browser" },
      { href: "/notifications", label: "Alerts", desc: "Telegram, email or webhook when a block moves" },
      { href: "/exposure", label: "Exposure check", desc: "What links a Ghost-mode wallet back to you" },
      { href: "/slippage", label: "Slippage calculator", desc: "What your size costs on a DEX" },
    ],
  },
  {
    key: "explore",
    label: "Explore",
    links: [
      { href: "/markets", label: "Markets", desc: "Stock tokens, ETFs and the desk token with live prices" },
      { href: "/refer", label: "Refer & earn", desc: "Earn half the fee on deals you bring" },
      { href: "/stats", label: "Stats", desc: "Volume, deals, fees and burns, from the chain" },
    ],
  },
  {
    key: "learn",
    label: "Learn",
    links: [
      { href: "/how", label: "How it works", desc: "A block from post to settlement" },
      { href: "/security", label: "Security", desc: "Who controls what, live from the chain" },
      { href: "/docs", label: "Docs", desc: "Fees, contracts, privacy and every live feature" },
      { href: "/roadmap", label: "Roadmap", desc: "What's live and what's next" },
      { href: "/developers", label: "Developers", desc: "MCP server, SDK and API for agents" },
    ],
  },
];

/** Header order: Trade menu, then the three explore pages, then the Learn menu. */
export const HEADER: ({ group: SiteGroup } | { link: SiteLink })[] = [
  { group: SITEMAP[0]! },
  ...SITEMAP[1]!.links.map((link) => ({ link })),
  { group: SITEMAP[2]! },
];
