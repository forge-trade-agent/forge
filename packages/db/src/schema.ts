/**
 * Sealdesk database schema (PostgreSQL 16 + optional TimescaleDB).
 *
 * Money rules:
 *  - On-chain amounts are NUMERIC(78,0) base units (fits any uint256), surfaced as strings.
 *  - USD figures are NUMERIC(38,6). Never float.
 * Privacy rules:
 *  - The server never stores a price in plaintext before acceptance: answers are ciphertext.
 *  - Capability tokens are stored only as SHA-256 hashes.
 * Integrity rules (enforced by triggers in migrations/0001):
 *  - deal_events, ledger_journals and ledger_postings are append-only.
 *  - every ledger journal must balance (Σ debits = Σ credits per asset).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------------------------
// Custom column types
// ---------------------------------------------------------------------------------------------

export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/** uint256 in base units, as a decimal string. */
const u256 = (name: string) => numeric(name, { precision: 78, scale: 0 });
/** USD amount with 6 decimals, as a decimal string. */
const usd = (name: string) => numeric(name, { precision: 38, scale: 6 });
/** Lower-case 0x-prefixed 20-byte address. */
const address = (name: string) => text(name);
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

const ADDRESS_RE = "^0x[0-9a-f]{40}$";
const addrCheck = (table: string, col: string, nullable = false) =>
  check(
    `${table}_${col}_addr`,
    nullable
      ? sql.raw(`"${col}" IS NULL OR "${col}" ~ '${ADDRESS_RE}'`)
      : sql.raw(`"${col}" ~ '${ADDRESS_RE}'`),
  );

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------

export const sideEnum = pgEnum("side", ["buy", "sell"]);
export const marketKindEnum = pgEnum("market_kind", ["stock", "etf", "token"]);
export const rfqStatusEnum = pgEnum("rfq_status", ["open", "filled", "cancelled", "expired"]);
export const quoteStatusEnum = pgEnum("quote_status", ["sealed", "accepted", "withdrawn", "expired"]);
export const dealStatusEnum = pgEnum("deal_status", [
  "accepted",
  "payment_locked",
  "settled",
  "refunded",
  "expired",
]);
export const eventSourceEnum = pgEnum("event_source", ["api", "chain"]);
export const ledgerDirectionEnum = pgEnum("ledger_direction", ["debit", "credit"]);
export const relayerTxStatusEnum = pgEnum("relayer_tx_status", [
  "pending",
  "mined",
  "failed",
  "replaced",
  "dropped",
]);
export const notifyChannelEnum = pgEnum("notify_channel", ["telegram", "email", "webhook"]);
export const candleIntervalEnum = pgEnum("candle_interval", ["5m", "15m", "1h", "1d"]);

// ---------------------------------------------------------------------------------------------
// Markets (curated list + any ERC-20 seen on the desk)
// ---------------------------------------------------------------------------------------------

export const markets = pgTable(
  "markets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    kind: marketKindEnum("kind").notNull(),
    tokenAddress: address("token_address").notNull(),
    decimals: smallint("decimals").notNull(),
    logoUrl: text("logo_url"),
    /** Ticker of the underlying listing used for delayed reference prices (null = OTC only). */
    underlyingSymbol: text("underlying_symbol"),
    exchange: text("exchange"),
    permitSupported: boolean("permit_supported").notNull().default(false),
    featured: boolean("featured").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    verifiedAt: ts("verified_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("markets_chain_token_uq").on(t.chainId, t.tokenAddress),
    uniqueIndex("markets_chain_symbol_uq").on(t.chainId, t.symbol),
    index("markets_featured_idx").on(t.featured, t.sortOrder),
    addrCheck("markets", "token_address"),
    check("markets_decimals_range", sql`${t.decimals} BETWEEN 0 AND 36`),
  ],
);

// ---------------------------------------------------------------------------------------------
// RFQs: bids (side=buy) and sell listings (side=sell)
// ---------------------------------------------------------------------------------------------

export const rfqs = pgTable(
  "rfqs",
  {
    /** 128-bit random id, Crockford base32 (26 chars). */
    id: text("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    side: sideEnum("side").notNull(),
    tokenAddress: address("token_address").notNull(),
    /** address(0) = native ETH */
    payToken: address("pay_token").notNull(),
    amount: u256("amount").notNull(),
    /** Optional USD size shown publicly when the poster sized in USD. */
    sizeUsd: usd("size_usd"),
    note: text("note"),
    /** Poster's X25519 public key (32 bytes). Answers are sealed to it. */
    encPubKey: bytea("enc_pub_key").notNull(),
    manageTokenHash: bytea("manage_token_hash").notNull(),
    allowPartial: boolean("allow_partial").notNull().default(false),
    /** Sum of amounts in accepted deals (partial fills). */
    filledAmount: u256("filled_amount").notNull().default("0"),
    status: rfqStatusEnum("status").notNull().default("open"),
    quoteCount: integer("quote_count").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    closedAt: ts("closed_at"),
  },
  (t) => [
    uniqueIndex("rfqs_manage_token_uq").on(t.manageTokenHash),
    index("rfqs_open_feed_idx").on(t.status, t.createdAt),
    index("rfqs_open_expiry_idx").on(t.status, t.expiresAt),
    index("rfqs_token_idx").on(t.chainId, t.tokenAddress, t.status),
    addrCheck("rfqs", "token_address"),
    addrCheck("rfqs", "pay_token"),
    check("rfqs_amount_pos", sql`${t.amount} > 0`),
    check("rfqs_filled_le_amount", sql`${t.filledAmount} >= 0 AND ${t.filledAmount} <= ${t.amount}`),
    check("rfqs_note_len", sql`${t.note} IS NULL OR char_length(${t.note}) <= 280`),
    check("rfqs_pubkey_len", sql`octet_length(${t.encPubKey}) = 32`),
    check("rfqs_token_hash_len", sql`octet_length(${t.manageTokenHash}) = 32`),
    check("rfqs_expiry_after_create", sql`${t.expiresAt} > ${t.createdAt}`),
    check("rfqs_token_ne_pay", sql`${t.tokenAddress} <> ${t.payToken}`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Sealed answers (quotes). Ciphertext only.
// ---------------------------------------------------------------------------------------------

export const quotes = pgTable(
  "quotes",
  {
    id: text("id").primaryKey(),
    rfqId: text("rfq_id")
      .notNull()
      .references(() => rfqs.id, { onDelete: "cascade" }),
    /** Ephemeral X25519 public key of the sender (32 bytes). */
    senderEncPubKey: bytea("sender_enc_pub_key").notNull(),
    nonce: bytea("nonce").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    quoteTokenHash: bytea("quote_token_hash").notNull(),
    status: quoteStatusEnum("status").notNull().default("sealed"),
    createdAt: ts("created_at").notNull().defaultNow(),
    acceptedAt: ts("accepted_at"),
  },
  (t) => [
    uniqueIndex("quotes_token_uq").on(t.quoteTokenHash),
    index("quotes_rfq_idx").on(t.rfqId, t.createdAt),
    check("quotes_pubkey_len", sql`octet_length(${t.senderEncPubKey}) = 32`),
    check("quotes_nonce_len", sql`octet_length(${t.nonce}) = 24`),
    check("quotes_ct_len", sql`octet_length(${t.ciphertext}) BETWEEN 16 AND 4096`),
    check("quotes_token_hash_len", sql`octet_length(${t.quoteTokenHash}) = 32`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Deals: one per accepted answer. Mirrors OtcEscrow.Terms exactly.
// ---------------------------------------------------------------------------------------------

export const deals = pgTable(
  "deals",
  {
    /** keccak256(abi.encode(terms)) — the on-chain deal id. */
    dealId: bytea("deal_id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    escrowAddress: address("escrow_address").notNull(),
    rfqId: text("rfq_id")
      .notNull()
      .references(() => rfqs.id),
    quoteId: text("quote_id")
      .notNull()
      .references(() => quotes.id),
    // --- Terms ---
    buyer: address("buyer").notNull(),
    seller: address("seller").notNull(),
    tokenAddress: address("token_address").notNull(),
    amount: u256("amount").notNull(),
    payToken: address("pay_token").notNull(),
    price: u256("price").notNull(),
    sellerPayout: address("seller_payout").notNull(),
    referrer: address("referrer"),
    relayerFee: u256("relayer_fee").notNull().default("0"),
    deadline: ts("deadline").notNull(),
    salt: bytea("salt").notNull(),
    // --- Lifecycle ---
    status: dealStatusEnum("status").notNull().default("accepted"),
    acceptedAt: ts("accepted_at").notNull().defaultNow(),
    paymentLockedAt: ts("payment_locked_at"),
    paymentTx: bytea("payment_tx"),
    settledAt: ts("settled_at"),
    settleTx: bytea("settle_tx"),
    settleBlock: bigint("settle_block", { mode: "bigint" }),
    refundedAt: ts("refunded_at"),
    refundTx: bytea("refund_tx"),
    // --- Settlement outputs (from the Settled event) ---
    fee: u256("fee"),
    referrerFee: u256("referrer_fee"),
    relayer: address("relayer"),
    priceUsd: usd("price_usd"),
  },
  (t) => [
    index("deals_rfq_idx").on(t.rfqId),
    uniqueIndex("deals_quote_uq").on(t.quoteId),
    index("deals_status_deadline_idx").on(t.status, t.deadline),
    index("deals_referrer_idx").on(t.referrer, t.status),
    index("deals_settled_at_idx").on(t.settledAt),
    uniqueIndex("deals_settle_tx_uq").on(t.settleTx),
    check("deals_id_len", sql`octet_length(${t.dealId}) = 32`),
    check("deals_salt_len", sql`octet_length(${t.salt}) = 32`),
    check("deals_amount_pos", sql`${t.amount} > 0 AND ${t.price} > 0`),
    check("deals_buyer_ne_seller", sql`${t.buyer} <> ${t.seller}`),
    check(
      "deals_referrer_not_party",
      sql`${t.referrer} IS NULL OR (${t.referrer} <> ${t.buyer} AND ${t.referrer} <> ${t.seller} AND ${t.referrer} <> ${t.sellerPayout})`,
    ),
    check(
      "deals_status_consistency",
      sql`(${t.status} <> 'settled' OR (${t.settleTx} IS NOT NULL AND ${t.settledAt} IS NOT NULL))
      AND (${t.status} <> 'refunded' OR (${t.refundTx} IS NOT NULL AND ${t.refundedAt} IS NOT NULL))`,
    ),
    addrCheck("deals", "escrow_address"),
    addrCheck("deals", "buyer"),
    addrCheck("deals", "seller"),
    addrCheck("deals", "token_address"),
    addrCheck("deals", "pay_token"),
    addrCheck("deals", "seller_payout"),
    addrCheck("deals", "referrer", true),
    addrCheck("deals", "relayer", true),
  ],
);

/** Append-only lifecycle log. Chain events are unique by (chain, tx, log index). */
export const dealEvents = pgTable(
  "deal_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    dealId: bytea("deal_id")
      .notNull()
      .references(() => deals.dealId),
    kind: text("kind").notNull(),
    source: eventSourceEnum("source").notNull(),
    chainId: integer("chain_id"),
    txHash: bytea("tx_hash"),
    logIndex: integer("log_index"),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    payload: jsonb("payload").notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("deal_events_deal_idx").on(t.dealId, t.id),
    uniqueIndex("deal_events_chain_log_uq").on(t.chainId, t.txHash, t.logIndex),
    check(
      "deal_events_chain_fields",
      sql`${t.source} <> 'chain' OR (${t.txHash} IS NOT NULL AND ${t.logIndex} IS NOT NULL AND ${t.blockNumber} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Indexer state (reorg-aware)
// ---------------------------------------------------------------------------------------------

export const chainCursors = pgTable(
  "chain_cursors",
  {
    chainId: integer("chain_id").notNull(),
    contract: address("contract").notNull(),
    lastBlock: bigint("last_block", { mode: "bigint" }).notNull(),
    lastBlockHash: bytea("last_block_hash").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.contract] }), addrCheck("chain_cursors", "contract")],
);

/** Recent canonical block hashes, used to detect reorgs and roll back. */
export const indexedBlocks = pgTable(
  "indexed_blocks",
  {
    chainId: integer("chain_id").notNull(),
    number: bigint("number", { mode: "bigint" }).notNull(),
    hash: bytea("hash").notNull(),
    parentHash: bytea("parent_hash").notNull(),
    timestamp: ts("timestamp").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.number] })],
);

// ---------------------------------------------------------------------------------------------
// Double-entry mirror ledger (built only from chain events; reconciled nightly)
// ---------------------------------------------------------------------------------------------

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    /** e.g. "escrow:locked", "escrow:owed:<addr>", "vault:fees", "referrer:<addr>", "external:<addr>", "burned" */
    code: text("code").notNull(),
    asset: address("asset").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ledger_accounts_uq").on(t.chainId, t.code, t.asset), addrCheck("ledger_accounts", "asset")],
);

export const ledgerJournals = pgTable(
  "ledger_journals",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    dealId: bytea("deal_id").references(() => deals.dealId),
    txHash: bytea("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    description: text("description").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ledger_journals_event_uq").on(t.chainId, t.txHash, t.logIndex),
    index("ledger_journals_deal_idx").on(t.dealId),
  ],
);

export const ledgerPostings = pgTable(
  "ledger_postings",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    journalId: bigint("journal_id", { mode: "bigint" })
      .notNull()
      .references(() => ledgerJournals.id),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => ledgerAccounts.id),
    direction: ledgerDirectionEnum("direction").notNull(),
    amount: u256("amount").notNull(),
  },
  (t) => [
    index("ledger_postings_journal_idx").on(t.journalId),
    index("ledger_postings_account_idx").on(t.accountId),
    check("ledger_postings_amount_pos", sql`${t.amount} > 0`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Relayer (Ghost mode)
// ---------------------------------------------------------------------------------------------

export const relayerTxs = pgTable(
  "relayer_txs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    dealId: bytea("deal_id")
      .notNull()
      .references(() => deals.dealId),
    relayer: address("relayer").notNull(),
    nonce: bigint("nonce", { mode: "bigint" }).notNull(),
    txHash: bytea("tx_hash").notNull(),
    status: relayerTxStatusEnum("status").notNull().default("pending"),
    maxFeePerGas: u256("max_fee_per_gas").notNull(),
    maxPriorityFeePerGas: u256("max_priority_fee_per_gas").notNull(),
    gasLimit: u256("gas_limit").notNull(),
    gasUsed: u256("gas_used"),
    /** Previous attempt this one replaced (fee bump). */
    replacesId: bigint("replaces_id", { mode: "bigint" }),
    error: text("error"),
    submittedAt: ts("submitted_at").notNull().defaultNow(),
    finalizedAt: ts("finalized_at"),
  },
  (t) => [
    uniqueIndex("relayer_txs_hash_uq").on(t.chainId, t.txHash),
    index("relayer_txs_nonce_idx").on(t.chainId, t.relayer, t.nonce),
    index("relayer_txs_pending_idx").on(t.status, t.submittedAt),
    addrCheck("relayer_txs", "relayer"),
  ],
);

// ---------------------------------------------------------------------------------------------
// Notifications (bound to a capability, never to an identity)
// ---------------------------------------------------------------------------------------------

export const notificationSubscriptions = pgTable(
  "notification_subscriptions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** SHA-256 of the rfq manage token or quote token this subscription belongs to. */
    capabilityHash: bytea("capability_hash").notNull(),
    channel: notifyChannelEnum("channel").notNull(),
    /** Destination encrypted at rest (XChaCha20-Poly1305, NOTIFY_ENCRYPTION_KEY). */
    destinationEnc: bytea("destination_enc").notNull(),
    verifiedAt: ts("verified_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("notify_capability_idx").on(t.capabilityHash),
    uniqueIndex("notify_capability_channel_uq").on(t.capabilityHash, t.channel),
  ],
);

// ---------------------------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------------------------

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: bytea("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.key] }),
    index("idempotency_expiry_idx").on(t.expiresAt),
    check("idempotency_key_len", sql`char_length(${t.key}) BETWEEN 8 AND 128`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Time series (hypertables when TimescaleDB is available — see migrations/0001)
// ---------------------------------------------------------------------------------------------

/** Delayed OHLC of the underlying listing (reference only). */
export const priceCandles = pgTable(
  "price_candles",
  {
    marketId: bigint("market_id", { mode: "number" })
      .notNull()
      .references(() => markets.id),
    interval: candleIntervalEnum("interval").notNull(),
    bucket: ts("bucket").notNull(),
    open: numeric("open", { precision: 38, scale: 18 }).notNull(),
    high: numeric("high", { precision: 38, scale: 18 }).notNull(),
    low: numeric("low", { precision: 38, scale: 18 }).notNull(),
    close: numeric("close", { precision: 38, scale: 18 }).notNull(),
    volume: numeric("volume", { precision: 38, scale: 6 }),
  },
  (t) => [
    primaryKey({ columns: [t.marketId, t.interval, t.bucket] }),
    check("price_candles_ohlc", sql`${t.low} <= ${t.open} AND ${t.low} <= ${t.close} AND ${t.high} >= ${t.open} AND ${t.high} >= ${t.close}`),
  ],
);

/** On-chain DEX snapshots (deepest pool), reference only. */
export const dexSnapshots = pgTable(
  "dex_snapshots",
  {
    chainId: integer("chain_id").notNull(),
    tokenAddress: address("token_address").notNull(),
    ts: ts("ts").notNull(),
    priceUsd: numeric("price_usd", { precision: 38, scale: 18 }).notNull(),
    marketCapUsd: usd("market_cap_usd"),
    liquidityUsd: usd("liquidity_usd"),
    volume24hUsd: usd("volume_24h_usd"),
    change24hPct: numeric("change_24h_pct", { precision: 12, scale: 4 }),
    poolAddress: text("pool_address"),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.tokenAddress, t.ts] }), addrCheck("dex_snapshots", "token_address")],
);

/** One row per settled deal, feeding desk statistics (continuous aggregate when Timescale is present). */
export const settlementTicks = pgTable(
  "settlement_ticks",
  {
    ts: ts("ts").notNull(),
    dealId: bytea("deal_id").notNull(),
    chainId: integer("chain_id").notNull(),
    tokenAddress: address("token_address").notNull(),
    payToken: address("pay_token").notNull(),
    price: u256("price").notNull(),
    fee: u256("fee").notNull(),
    priceUsd: usd("price_usd"),
    feeUsd: usd("fee_usd"),
  },
  (t) => [primaryKey({ columns: [t.dealId, t.ts] }), index("settlement_ticks_token_idx").on(t.tokenAddress, t.ts)],
);

/** Vault burns, for the burn tracker. */
export const burns = pgTable(
  "burns",
  {
    chainId: integer("chain_id").notNull(),
    txHash: bytea("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    ts: ts("ts").notNull(),
    payToken: address("pay_token").notNull(),
    amountIn: u256("amount_in").notNull(),
    amountBurned: u256("amount_burned").notNull(),
    route: address("route").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.txHash, t.logIndex] }), index("burns_ts_idx").on(t.ts)],
);

// ---------------------------------------------------------------------------------------------
// Site settings: small public values an operator sets from /admin (e.g. the token's contract address)
// ---------------------------------------------------------------------------------------------

export const siteSettings = pgTable("site_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
