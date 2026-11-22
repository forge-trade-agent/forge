CREATE TYPE "public"."candle_interval" AS ENUM('5m', '15m', '1h', '1d');--> statement-breakpoint
CREATE TYPE "public"."deal_status" AS ENUM('accepted', 'payment_locked', 'settled', 'refunded', 'expired');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('api', 'chain');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."market_kind" AS ENUM('stock', 'etf', 'token');--> statement-breakpoint
CREATE TYPE "public"."notify_channel" AS ENUM('telegram', 'email', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('sealed', 'accepted', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."relayer_tx_status" AS ENUM('pending', 'mined', 'failed', 'replaced', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."rfq_status" AS ENUM('open', 'filled', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TABLE "burns" (
	"chain_id" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"log_index" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"pay_token" text NOT NULL,
	"amount_in" numeric(78, 0) NOT NULL,
	"amount_burned" numeric(78, 0) NOT NULL,
	"route" text NOT NULL,
	CONSTRAINT "burns_chain_id_tx_hash_log_index_pk" PRIMARY KEY("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"chain_id" integer NOT NULL,
	"contract" text NOT NULL,
	"last_block" bigint NOT NULL,
	"last_block_hash" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_cursors_chain_id_contract_pk" PRIMARY KEY("chain_id","contract"),
	CONSTRAINT "chain_cursors_contract_addr" CHECK ("contract" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "deal_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deal_id" "bytea" NOT NULL,
	"kind" text NOT NULL,
	"source" "event_source" NOT NULL,
	"chain_id" integer,
	"tx_hash" "bytea",
	"log_index" integer,
	"block_number" bigint,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deal_events_chain_fields" CHECK ("deal_events"."source" <> 'chain' OR ("deal_events"."tx_hash" IS NOT NULL AND "deal_events"."log_index" IS NOT NULL AND "deal_events"."block_number" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"deal_id" "bytea" PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"escrow_address" text NOT NULL,
	"rfq_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"buyer" text NOT NULL,
	"seller" text NOT NULL,
	"token_address" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"pay_token" text NOT NULL,
	"price" numeric(78, 0) NOT NULL,
	"seller_payout" text NOT NULL,
	"referrer" text,
	"relayer_fee" numeric(78, 0) DEFAULT '0' NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"salt" "bytea" NOT NULL,
	"status" "deal_status" DEFAULT 'accepted' NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_locked_at" timestamp with time zone,
	"payment_tx" "bytea",
	"settled_at" timestamp with time zone,
	"settle_tx" "bytea",
	"settle_block" bigint,
	"refunded_at" timestamp with time zone,
	"refund_tx" "bytea",
	"fee" numeric(78, 0),
	"referrer_fee" numeric(78, 0),
	"relayer" text,
	"price_usd" numeric(38, 6),
	CONSTRAINT "deals_id_len" CHECK (octet_length("deals"."deal_id") = 32),
	CONSTRAINT "deals_salt_len" CHECK (octet_length("deals"."salt") = 32),
	CONSTRAINT "deals_amount_pos" CHECK ("deals"."amount" > 0 AND "deals"."price" > 0),
	CONSTRAINT "deals_buyer_ne_seller" CHECK ("deals"."buyer" <> "deals"."seller"),
	CONSTRAINT "deals_referrer_not_party" CHECK ("deals"."referrer" IS NULL OR ("deals"."referrer" <> "deals"."buyer" AND "deals"."referrer" <> "deals"."seller" AND "deals"."referrer" <> "deals"."seller_payout")),
	CONSTRAINT "deals_status_consistency" CHECK (("deals"."status" <> 'settled' OR ("deals"."settle_tx" IS NOT NULL AND "deals"."settled_at" IS NOT NULL))
      AND ("deals"."status" <> 'refunded' OR ("deals"."refund_tx" IS NOT NULL AND "deals"."refunded_at" IS NOT NULL))),
	CONSTRAINT "deals_escrow_address_addr" CHECK ("escrow_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "deals_buyer_addr" CHECK ("buyer" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "deals_seller_addr" CHECK ("seller" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "deals_token_address_addr" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "deals_pay_token_addr" CHECK ("pay_token" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "deals_seller_payout_addr" CHECK ("seller_payout" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "deals_referrer_addr" CHECK ("referrer" IS NULL OR "referrer" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "deals_relayer_addr" CHECK ("relayer" IS NULL OR "relayer" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "dex_snapshots" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"price_usd" numeric(38, 18) NOT NULL,
	"market_cap_usd" numeric(38, 6),
	"liquidity_usd" numeric(38, 6),
	"volume_24h_usd" numeric(38, 6),
	"change_24h_pct" numeric(12, 4),
	"pool_address" text,
	CONSTRAINT "dex_snapshots_chain_id_token_address_ts_pk" PRIMARY KEY("chain_id","token_address","ts"),
	CONSTRAINT "dex_snapshots_token_address_addr" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key"),
	CONSTRAINT "idempotency_key_len" CHECK (char_length("idempotency_keys"."key") BETWEEN 8 AND 128)
);
--> statement-breakpoint
CREATE TABLE "indexed_blocks" (
	"chain_id" integer NOT NULL,
	"number" bigint NOT NULL,
	"hash" "bytea" NOT NULL,
	"parent_hash" "bytea" NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	CONSTRAINT "indexed_blocks_chain_id_number_pk" PRIMARY KEY("chain_id","number")
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"code" text NOT NULL,
	"asset" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_asset_addr" CHECK ("asset" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "ledger_journals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"deal_id" "bytea",
	"tx_hash" "bytea" NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_postings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"journal_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	CONSTRAINT "ledger_postings_amount_pos" CHECK ("ledger_postings"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"kind" "market_kind" NOT NULL,
	"token_address" text NOT NULL,
	"decimals" smallint NOT NULL,
	"logo_url" text,
	"underlying_symbol" text,
	"exchange" text,
	"permit_supported" boolean DEFAULT false NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_token_address_addr" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "markets_decimals_range" CHECK ("markets"."decimals" BETWEEN 0 AND 36)
);
--> statement-breakpoint
CREATE TABLE "notification_subscriptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"capability_hash" "bytea" NOT NULL,
	"channel" "notify_channel" NOT NULL,
	"destination_enc" "bytea" NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_candles" (
	"market_id" bigint NOT NULL,
	"interval" "candle_interval" NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"open" numeric(38, 18) NOT NULL,
	"high" numeric(38, 18) NOT NULL,
	"low" numeric(38, 18) NOT NULL,
	"close" numeric(38, 18) NOT NULL,
	"volume" numeric(38, 6),
	CONSTRAINT "price_candles_market_id_interval_bucket_pk" PRIMARY KEY("market_id","interval","bucket"),
	CONSTRAINT "price_candles_ohlc" CHECK ("price_candles"."low" <= "price_candles"."open" AND "price_candles"."low" <= "price_candles"."close" AND "price_candles"."high" >= "price_candles"."open" AND "price_candles"."high" >= "price_candles"."close")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_id" text NOT NULL,
	"sender_enc_pub_key" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"quote_token_hash" "bytea" NOT NULL,
	"status" "quote_status" DEFAULT 'sealed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "quotes_pubkey_len" CHECK (octet_length("quotes"."sender_enc_pub_key") = 32),
	CONSTRAINT "quotes_nonce_len" CHECK (octet_length("quotes"."nonce") = 24),
	CONSTRAINT "quotes_ct_len" CHECK (octet_length("quotes"."ciphertext") BETWEEN 16 AND 4096),
	CONSTRAINT "quotes_token_hash_len" CHECK (octet_length("quotes"."quote_token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "relayer_txs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"deal_id" "bytea" NOT NULL,
	"relayer" text NOT NULL,
	"nonce" bigint NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"status" "relayer_tx_status" DEFAULT 'pending' NOT NULL,
	"max_fee_per_gas" numeric(78, 0) NOT NULL,
	"max_priority_fee_per_gas" numeric(78, 0) NOT NULL,
	"gas_limit" numeric(78, 0) NOT NULL,
	"gas_used" numeric(78, 0),
	"replaces_id" bigint,
	"error" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "relayer_txs_relayer_addr" CHECK ("relayer" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "rfqs" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"side" "side" NOT NULL,
	"token_address" text NOT NULL,
	"pay_token" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"size_usd" numeric(38, 6),
	"note" text,
	"enc_pub_key" "bytea" NOT NULL,
	"manage_token_hash" "bytea" NOT NULL,
	"allow_partial" boolean DEFAULT false NOT NULL,
	"filled_amount" numeric(78, 0) DEFAULT '0' NOT NULL,
	"status" "rfq_status" DEFAULT 'open' NOT NULL,
	"quote_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "rfqs_token_address_addr" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "rfqs_pay_token_addr" CHECK ("pay_token" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "rfqs_amount_pos" CHECK ("rfqs"."amount" > 0),
	CONSTRAINT "rfqs_filled_le_amount" CHECK ("rfqs"."filled_amount" >= 0 AND "rfqs"."filled_amount" <= "rfqs"."amount"),
	CONSTRAINT "rfqs_note_len" CHECK ("rfqs"."note" IS NULL OR char_length("rfqs"."note") <= 280),
	CONSTRAINT "rfqs_pubkey_len" CHECK (octet_length("rfqs"."enc_pub_key") = 32),
	CONSTRAINT "rfqs_token_hash_len" CHECK (octet_length("rfqs"."manage_token_hash") = 32),
	CONSTRAINT "rfqs_expiry_after_create" CHECK ("rfqs"."expires_at" > "rfqs"."created_at"),
	CONSTRAINT "rfqs_token_ne_pay" CHECK ("rfqs"."token_address" <> "rfqs"."pay_token")
);
--> statement-breakpoint
CREATE TABLE "settlement_ticks" (
	"ts" timestamp with time zone NOT NULL,
	"deal_id" "bytea" NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"pay_token" text NOT NULL,
	"price" numeric(78, 0) NOT NULL,
	"fee" numeric(78, 0) NOT NULL,
	"price_usd" numeric(38, 6),
	"fee_usd" numeric(38, 6),
	CONSTRAINT "settlement_ticks_deal_id_ts_pk" PRIMARY KEY("deal_id","ts")
);
--> statement-breakpoint
ALTER TABLE "deal_events" ADD CONSTRAINT "deal_events_deal_id_deals_deal_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("deal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_deal_id_deals_deal_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("deal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_journal_id_ledger_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_candles" ADD CONSTRAINT "price_candles_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relayer_txs" ADD CONSTRAINT "relayer_txs_deal_id_deals_deal_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("deal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "burns_ts_idx" ON "burns" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "deal_events_deal_idx" ON "deal_events" USING btree ("deal_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "deal_events_chain_log_uq" ON "deal_events" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "deals_rfq_idx" ON "deals" USING btree ("rfq_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_quote_uq" ON "deals" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "deals_status_deadline_idx" ON "deals" USING btree ("status","deadline");--> statement-breakpoint
CREATE INDEX "deals_referrer_idx" ON "deals" USING btree ("referrer","status");--> statement-breakpoint
CREATE INDEX "deals_settled_at_idx" ON "deals" USING btree ("settled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_settle_tx_uq" ON "deals" USING btree ("settle_tx");--> statement-breakpoint
CREATE INDEX "idempotency_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_uq" ON "ledger_accounts" USING btree ("chain_id","code","asset");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_event_uq" ON "ledger_journals" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "ledger_journals_deal_idx" ON "ledger_journals" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "ledger_postings_journal_idx" ON "ledger_postings" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "ledger_postings_account_idx" ON "ledger_postings" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_chain_token_uq" ON "markets" USING btree ("chain_id","token_address");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_chain_symbol_uq" ON "markets" USING btree ("chain_id","symbol");--> statement-breakpoint
CREATE INDEX "markets_featured_idx" ON "markets" USING btree ("featured","sort_order");--> statement-breakpoint
CREATE INDEX "notify_capability_idx" ON "notification_subscriptions" USING btree ("capability_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "notify_capability_channel_uq" ON "notification_subscriptions" USING btree ("capability_hash","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_token_uq" ON "quotes" USING btree ("quote_token_hash");--> statement-breakpoint
CREATE INDEX "quotes_rfq_idx" ON "quotes" USING btree ("rfq_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "relayer_txs_hash_uq" ON "relayer_txs" USING btree ("chain_id","tx_hash");--> statement-breakpoint
CREATE INDEX "relayer_txs_nonce_idx" ON "relayer_txs" USING btree ("chain_id","relayer","nonce");--> statement-breakpoint
CREATE INDEX "relayer_txs_pending_idx" ON "relayer_txs" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rfqs_manage_token_uq" ON "rfqs" USING btree ("manage_token_hash");--> statement-breakpoint
CREATE INDEX "rfqs_open_feed_idx" ON "rfqs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "rfqs_open_expiry_idx" ON "rfqs" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "rfqs_token_idx" ON "rfqs" USING btree ("chain_id","token_address","status");--> statement-breakpoint
CREATE INDEX "settlement_ticks_token_idx" ON "settlement_ticks" USING btree ("token_address","ts");