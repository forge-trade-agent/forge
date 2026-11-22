# Forge — Architecture (Phase 1)

> Working name **Forge**. Rename freely: the brand lives in `apps/web/config/brand.ts` and contract
> NatSpec only. Platform token placeholder: **$FORGE**.

Forge is a **non-custodial, sealed-bid RFQ desk** for block trades of tokenized stocks, ETFs and
ERC-20s on an EVM L2 (reference: Robinhood Chain, chain id 4663). Prices are end-to-end encrypted
between counterparties; settlement is a single atomic swap in an escrow contract with no admin.

---

## 1. Trust boundaries

| Component | Trusted for | NOT trusted for |
|---|---|---|
| `OtcEscrow` contract | Custody, atomic settlement, fee math, refunds | — (no owner, no upgrade, no pause) |
| `BuyBurnVault` | Holding fees until burned | Cannot withdraw fees to anyone |
| Browser (client) | Key generation, encryption, decryption, signature verification | — |
| API server | Availability, relaying ciphertext, indexing public data | Confidentiality of prices (never sees plaintext), correctness of answers (client re-verifies) |
| Relayer | Paying gas for Ghost-mode deliveries | Cannot alter terms (EIP-712 + dealId hash) or redirect funds |
| Indexer / DB | Convenience views, stats | Source of truth is always the chain |

A full server compromise must reveal at most: which blocks exist, their token, side and size, and
ciphertext blobs. It must never allow moving funds or reading prices.

---

## 2. Component diagram

```
                              ┌──────────────────────────────────────────────────────────┐
                              │                     BROWSER / AGENT                      │
                              │                                                          │
   private link               │  ┌───────────────┐   ┌───────────────┐  ┌─────────────┐  │
   /rfq/<id>#k=<x25519 sk>    │  │ @sealdesk/    │   │ Next.js desk  │  │ MCP server  │  │
   &t=<capability token> ───► │  │ crypto        │◄──┤ (wagmi+viem)  │  │ (stdio,     │  │
                              │  │ nacl.box      │   │               │  │ local keys) │  │
   fragment never leaves      │  │ EIP-712 verify│   └──────┬────────┘  └──────┬──────┘  │
   the browser                │  └───────────────┘          │ @sealdesk/sdk    │         │
                              └─────────────────────────────┼──────────────────┼─────────┘
                                   HTTPS (REST) + WSS/SSE   │                  │   JSON-RPC (wallet)
                         ┌──────────────────────────────────┼──────────────────┼─────────────────┐
                         │                    BACKEND       ▼                  │                 │
                         │  ┌────────────────────────────────────────┐         │                 │
                         │  │ apps/api  (Fastify + Zod → OpenAPI)    │         │                 │
                         │  │  /rfqs /quotes /accept /relay /markets │         │                 │
                         │  │  capability-token auth, idempotency,   │         │                 │
                         │  │  rate limit, realtime gateway          │         │                 │
                         │  └──────┬──────────────┬──────────────────┘         │                 │
                         │         │ SQL           │ XADD / PUB               │                 │
                         │  ┌──────▼───────┐  ┌────▼────────────┐              │                 │
                         │  │ Postgres 16  │  │ Redis 7         │              │                 │
                         │  │ + Timescale  │  │ streams, limits │              │                 │
                         │  │ (ciphertext, │  │ Redlock, BullMQ │              │                 │
                         │  │  deals,      │  └────▲──────▲─────┘              │                 │
                         │  │  ledger)     │       │      │                    │                 │
                         │  └──────▲───────┘       │      │                    │                 │
                         │         │               │      │                    │                 │
                         │  ┌──────┴──────────┐ ┌──┴──────┴───────┐ ┌──────────┴────────┐        │
                         │  │ apps/indexer    │ │ apps/worker     │ │ apps/relayer      │        │
                         │  │ reorg-safe logs │ │ expiry sweeps,  │ │ Ghost mode:       │        │
                         │  │ → deal states,  │ │ notifications,  │ │ verify sig, sim,  │        │
                         │  │ double-entry    │ │ stats rollups,  │ │ nonce mgr (Redlock│        │
                         │  │ mirror ledger,  │ │ price candles,  │ │ ), EIP-1559 bump  │        │
                         │  │ reconciliation  │ │ burn tracker    │ │ exposure check    │        │
                         │  └──────▲──────────┘ └──────▲──────────┘ └─────────┬─────────┘        │
                         └─────────┼───────────────────┼──────────────────────┼──────────────────┘
                                   │ eth_getLogs        │ eth_call / DEX        │ eth_sendRawTx
                         ┌─────────┴───────────────────┴──────────────────────▼──────────────────┐
                         │                         EVM L2 (chain 4663)                           │
                         │  ┌──────────────┐  fee   ┌───────────────┐ queue/activate ┌─────────┐ │
                         │  │  OtcEscrow   ├───────►│ BuyBurnVault  ├───────────────►│ IBurn   │ │
                         │  │ no owner     │        │ 48h timelock  │  buyAndBurn    │ Route   │ │
                         │  │ dealId=hash  │ ref fee│ on routes     │◄───────────────┤ (v4)    │ │
                         │  └──────┬───────┘──► referrer            └───────────────┘└────┬────┘ │
                         │         │ payout ─► seller / relayer                            │      │
                         │         └ tokens ─► buyer                       swap ─► 0x…dEaD ┘      │
                         └───────────────────────────────────────────────────────────────────────┘
```

---

## 3. Sequence: happy path (bid → sealed answer → accept → settle)

```
Buyer browser            API               Seller browser              OtcEscrow
     │ gen X25519 (pk,sk)  │                       │                        │
     │ POST /rfqs {token,  │                       │                        │
     │  side:buy, amount,  │                       │                        │
     │  payToken, pk}  ───►│ store, cap token hash │                        │
     │◄── {id, capToken} ──│                       │                        │
     │ link = /rfq/id#k=sk&t=capToken (kept local) │                        │
     │                     │◄── GET /rfqs ─────────│                        │
     │                     │── public view ───────►│ (token, size, pk; NO price)
     │                     │                       │ build Terms draft,      │
     │                     │                       │ sign EIP-712 Answer,    │
     │                     │                       │ nacl.box(json, pk)      │
     │                     │◄── POST quotes {epk,  │                        │
     │                     │    nonce, ciphertext}─│                        │
     │── GET quotes (cap) ►│                       │                        │
     │◄── ciphertexts ─────│                       │                        │
     │ decrypt, Zod-parse, verify sig, funds check │                        │
     │ rank: signed+funded > signed > unverified   │                        │
     │── POST accept {quoteId, terms} ────────────►│ notify seller (WS)     │
     │── depositPayment(terms) [ETH or ERC20/permit] ─────────────────────►│ PaymentLocked
     │                     │                       │── deliver(terms) ─────►│ pull tokens,
     │                     │                       │                        │ tokens→buyer,
     │                     │                       │                        │ payout→seller,
     │                     │                       │                        │ fee→vault/ref
     │                     │◄── POST /rfqs/id/settled {tx} (anyone) ────────│ Settled event
     │                     │ verify receipt+event+dealId, record            │
```

Ordering rule: **payment locks first**. A seller never deposits into a deal whose payment is not
already locked, and the seller's deposit *is* the settlement — there is no state where only the
seller has funds in escrow.

## 4. Sequence: refund

```
  payment locked ── deadline passes, seller never delivered ──► anyone calls refund(terms)
                                                               → price returned to terms.buyer
                                                               → state Refunded (terminal)
```

## 5. Sequence: Ghost mode (relayed delivery)

```
Seller main wallet ──(funds via any route)──► one-time wallet W  (holds `amount` tokens, 0 ETH)
W signs:  EIP-2612 permit(owner=W, spender=escrow, amount, deadline)
W signs:  EIP-712 Deliver(dealId, relayer, deadline)
Seller browser ── POST /relay/deposit {terms, permitSig, deliverSig} ──► Relayer
Relayer: verify sigs, eth_call simulate, check terms.relayerFee ≥ min, broadcast
OtcEscrow.deliverFor(terms, permit, deliverSig)   (msg.sender = relayer)
   → permit (try/catch, tolerate front-run), pull tokens from W, settle,
     relayerFee → relayer, remainder → terms.sellerPayout
```
Exposure check (off-chain): trace inbound transfers of W for N hops and report links to known
addresses of the user (their connected wallets, CEX deposit clusters) before they deliver.

## 6. Sequence: burn route timelock

```
governor ── queueRoute(newRoute) ──► vault: pending=newRoute, eta=now+48h   (event RouteQueued)
          ... 48h public window, anyone can inspect newRoute bytecode/verification ...
anyone  ── activateRoute() ────────► vault: route=pending                    (event RouteActivated)
keeper  ── burn(payToken, amountIn, minOut) ─► route.buyAndBurn → TOKEN → 0x…dEaD
          vault re-checks DEAD balance delta ≥ minOut (min-out checked twice)
```
The governor can queue or cancel a pending route; it can never move fees. Until a route is active,
fees accumulate in the vault.

---

## 7. Fee model (enforced on-chain)

| Notional (in pay token, thresholds immutable per pay token) | Fee | With holder discount |
|---|---|---|
| < tier1 (≈ $10k) | 250 bps | 200 bps |
| ≥ tier1 | 200 bps | 150 bps |
| ≥ tier2 (≈ $100k) | 150 bps | 100 bps |

* `MAX_FEE_BPS = 250` is a constant; the computed fee can never exceed it.
* Discount applies when **buyer or seller** holds ≥ `MIN_HOLDING` of the platform token at settlement.
* Fee is taken from the payment leg. Referrer (if valid) receives 50%; the rest goes to the vault.
* `relayerFee` is paid from the seller's proceeds to the relayer (only in Ghost mode).
* Thresholds for ETH are fixed in wei at deployment (no oracle → no oracle manipulation). Drift vs USD
  is an accepted, documented trade-off; a new escrow can be deployed with new tiers.

## 8. Deal state machine

Off-chain (DB): `POSTED → ANSWERED → ACCEPTED → PAYMENT_LOCKED → SETTLED | REFUNDED`, plus
`EXPIRED` (no accept before reply window) and `CANCELLED`. On-chain only stores
`None → PaymentLocked → Settled | Refunded`; the indexer derives everything else.

## 9. Monorepo layout (Phase 4 will scaffold the TS apps)

```
.
├─ contracts/            Foundry project (Phase 2)  ← done
├─ docs/                 architecture, threat model, audit report
├─ apps/api              Fastify REST + realtime gateway
├─ apps/indexer          reorg-safe log indexer + reconciliation
├─ apps/relayer          Ghost-mode relayer
├─ apps/worker           BullMQ jobs
├─ apps/web              Next.js desk
├─ packages/crypto       sealing + EIP-712 typed data (shared by web, sdk, mcp)
├─ packages/sdk          ESM SDK
├─ packages/mcp          MCP server
└─ packages/shared       Zod schemas, error codes, chain config
```
