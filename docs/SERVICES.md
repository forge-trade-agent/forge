# Core services (Phase 5)

## What each service does

| Service | Responsibility | Key guarantees |
|---|---|---|
| `packages/crypto` | Seal/open answers (X25519 + XSalsa20-Poly1305), EIP-712 `Answer` and `Deliver` typed data, deal id, answer checks and ranking, private links, encrypted key backup (Argon2id + XChaCha20-Poly1305), at-rest encryption | Deal id and Deliver digest pinned against Solidity (`contracts/test/CrossLanguage.t.sol`); decrypted answers are parsed as hostile input |
| `apps/api` | Postings, sealed answers, accept (partial fills, row lock), deals, settlement reports (verified on-chain), receipts, relay queueing, notifications, markets, stats, referrals, burn, SSE stream, OpenAPI 3.1 | Capability-token auth (hash only, constant-time compare); `Idempotency-Key` on every create; per-IP sliding-window limits; no price ever leaves the server before acceptance; `Referrer-Policy: no-referrer` |
| `apps/indexer` | Escrow + vault logs into deal state, `settlement_ticks`, `burns`, and a double-entry ledger | Confirmed blocks only; halts on reorgs deeper than the confirmation depth; one DB transaction per batch (logs + cursor); replays are no-ops |
| `apps/relayer` | Ghost-mode deliveries | Re-validates everything; signature bound to this relayer; simulation before send; gas-price cap; nonce lock; same-nonce replacement at +12.5% when stuck |
| `apps/worker` | Expiry sweep, deadline alerts, DexScreener snapshots, delayed reference candles, burn tracker, nightly reconciliation, idempotency GC, notification dispatch | Notifications carry no prices, terms or links; webhooks are HTTPS-only, SSRF-guarded (public IPs only, no redirects) and HMAC-signed |

## Ledger accounts

`escrow:locked`, `escrow:owed`, `vault:fees` are asset accounts (debit-positive); `external:<address>` are
counter-accounts. Every journal balances per asset (enforced by a deferred trigger). Reconciliation checks:

```
on-chain escrow balance == totalLocked + totalOwed == ledger(escrow:locked + escrow:owed)
on-chain vault balance  >= ledger(vault:fees)
```

## Realtime

`GET /stream?channel=desk | rfq:<id> | quote:<id>` (Server-Sent Events). Event ids are per-channel sequence
numbers; reconnect with `Last-Event-ID` to resume without gaps. Heartbeats every 15 s; slow consumers are
dropped after 10 s of backpressure.

## Verification status

| Area | Verified here | Not verified here |
|---|---|---|
| Contracts | 52 Foundry tests (unit, fuzz, invariant, cross-language) | Uniswap v4 route against a real PoolManager (needs a fork RPC); Slither |
| Crypto | 9 tests incl. tamper/wrong-key/hostile-plaintext and Solidity vectors | Browser runtime (Phase 7) |
| DB | 11 tests on PGlite (real Postgres engine) | TimescaleDB branch of migration 0001 (runs in CI on `timescale/timescaledb`) |
| API | 18 tests end-to-end over HTTP incl. SSE resume, idempotency, rate limits, relay validation | Redis-backed adapters (in-memory twins used in tests) |
| Indexer | 7 tests with real ABI-encoded logs, ledger balance, replay, deep reorg | Live RPC |
| Relayer | 8 tests incl. fee bump, forged/misbound signatures, gas cap, nonce lock | Live broadcast |
| Worker | 10 tests incl. SSRF guard, webhook HMAC, DexScreener shape (checked live), candle roll-ups | Alpha Vantage live (needs your API key); SMTP/Telegram live |
| SDK | 4 unit tests (SSE parsing, idempotent retries, error mapping) + browser-safe bundle build | A real browser (Phase 7) |
| End to end | 5 scenarios on anvil with the compiled contracts: SDK trade with SSE, Ghost-mode relay, refund, reconciliation, two MCP agents | A live public chain |

Redis adapters (`packages/infra/src/redis.ts`) are typechecked but have no automated tests yet: they need a
Redis instance (CI service container).

## Protocol rule: who fills which side of the terms

Postings are anonymous, so an answerer cannot know the poster's wallet. An answer therefore leaves the
poster's fields empty (zero address / zero fee) and signs that; the poster fills only its own fields when
accepting (`completeTerms`). Poster fields: bids `buyer, referrer`; listings `seller, sellerPayout, referrer,
relayerFee`. An answer that pre-fills them is ranked last.
