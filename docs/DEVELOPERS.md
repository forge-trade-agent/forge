# Developers: SDK and MCP server

## JavaScript SDK

One import, both sides of a trade. Runs in browsers and Node. The bundle is served at
`GET /sdk/forge.mjs` with its SHA-256 in the `x-content-sha256` header (pin it).

```js
import { Desk, EscrowClient } from "./forge.mjs";

const desk = await Desk.connect({ baseUrl: "https://api.desk.example" }, "https://desk.example");

// Buyer: post a private bid. Keep secretKey + manageToken (or privateLink) like a password.
const block = await desk.postBlock({ side: "buy", token: TSLA, payToken: USDG, amount: "2500000000000000000000", replyWindow: "1h" });

// Seller: send a sealed, signed answer (viem LocalAccount or signerFromWallet(walletClient)).
const sent = await desk.answer({ rfqId: block.rfq.id, signer: sellerAccount, amount: block.rfq.amount, price: "950275000000" });

// Buyer: decrypt locally, verify, rank; accept the best one (fills only the buyer's side).
const [best] = await desk.readAnswers({ rfqId: block.rfq.id, manageToken: block.manageToken, secretKey: block.secretKey });
const deal = await desk.accept({ rfqId: block.rfq.id, manageToken: block.manageToken, answer: best, wallet: buyerAddress });

// On-chain: payment locks first, then the seller's delivery settles both legs.
const escrow = new EscrowClient(publicClient, desk.cfg.escrow);
await escrow.depositPayment(buyerWallet, deal.terms);
const tx = await escrow.deliver(sellerWallet, deal.terms);
await desk.api.reportSettled(block.rfq.id, tx);
```

Ghost mode (seller delivers from a fresh wallet that holds the tokens but no ETH):

```js
const req = await escrow.ghostDelivery(oneTimeAccount, (await desk.api.relayInfo()).relayer, deal.terms);
const { requestId } = await desk.api.relayDeposit(req);
```

Realtime: `subscribe({ baseUrl, channel: "rfq:<id>", token: manageToken, onEvent })` resumes from the last
sequence number after any disconnect.

Every create call sends an `Idempotency-Key`; retries of 5xx/network errors reuse the same key, so a
retried create can never run twice.

## MCP server (11 tools)

```bash
npm run build -w @sealdesk/mcp   # -> packages/mcp/dist/forge-mcp.mjs (+ .sha256)
```

Client configuration (Claude Desktop / Claude Code style):

```json
{
  "mcpServers": {
    "forge": {
      "command": "node",
      "args": ["/path/to/forge-mcp.mjs"],
      "env": {
        "FORGE_API_URL": "https://api.desk.example",
        "FORGE_RPC_URL": "https://rpc.example",
        "FORGE_PRIVATE_KEY": "0x…",
        "FORGE_MAX_PRICE_USD": "100000000000"
      }
    }
  }
}
```

| Tool | Moves value | Notes |
|---|---|---|
| `list_markets`, `get_token_info`, `list_open_blocks` | no | public data; prices of open blocks are never public |
| `post_block`, `send_sealed_answer` | no | secrets go to the local keystore (`~/.forge/keystore.json`, 0600), never to the agent |
| `read_sealed_answers` | no | decrypts locally; counterparty content is returned under `untrusted` |
| `accept_answer`, `deposit_payment`, `deposit_tokens`, `refund_deal` | yes | require `confirm: true`; otherwise return a preview with exact amounts and fees |
| `get_deal_status` | no | desk record + on-chain escrow state |

Safety: the wallet key stays in the MCP process; optional `FORGE_MAX_PRICE_ETH` / `FORGE_MAX_PRICE_USD`
caps are enforced locally; unverified answers need `allowUnverified: true`; a seller can't deliver before
payment is locked.
