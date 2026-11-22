-- Custom SQL migration: integrity guards and optional TimescaleDB setup.
-- Hand-written; drizzle-kit does not generate triggers, views or hypertables.

-- =============================================================================================
-- 1. Append-only tables. Reorgs and corrections are recorded as NEW rows, never edits.
-- =============================================================================================
CREATE OR REPLACE FUNCTION sealdesk_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% forbidden)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deal_events_append_only BEFORE UPDATE OR DELETE ON deal_events
  FOR EACH ROW EXECUTE FUNCTION sealdesk_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_journals_append_only BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION sealdesk_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_postings_append_only BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION sealdesk_forbid_mutation();
--> statement-breakpoint

-- =============================================================================================
-- 2. Double-entry: every journal must have >= 2 postings and balance per asset.
--    Deferred to COMMIT so postings can be inserted one by one inside a transaction.
-- =============================================================================================
CREATE OR REPLACE FUNCTION sealdesk_check_journal(p_journal bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n_postings int;
  bad_asset text;
BEGIN
  SELECT count(*) INTO n_postings FROM ledger_postings WHERE journal_id = p_journal;
  IF n_postings < 2 THEN
    RAISE EXCEPTION 'ledger journal % has % posting(s); at least 2 required', p_journal, n_postings
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT a.asset INTO bad_asset
  FROM ledger_postings p
  JOIN ledger_accounts a ON a.id = p.account_id
  WHERE p.journal_id = p_journal
  GROUP BY a.asset
  HAVING sum(CASE WHEN p.direction = 'debit' THEN p.amount ELSE -p.amount END) <> 0
  LIMIT 1;

  IF bad_asset IS NOT NULL THEN
    RAISE EXCEPTION 'ledger journal % does not balance for asset %', p_journal, bad_asset
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sealdesk_journal_balanced_from_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sealdesk_check_journal(NEW.journal_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sealdesk_journal_balanced_from_journal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sealdesk_check_journal(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_postings_balanced
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sealdesk_journal_balanced_from_posting();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_journals_have_postings
  AFTER INSERT ON ledger_journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sealdesk_journal_balanced_from_journal();
--> statement-breakpoint

-- Account balances (debit-positive), used by the reconciliation job.
CREATE VIEW ledger_balances AS
SELECT a.id AS account_id, a.chain_id, a.code, a.asset,
       COALESCE(sum(CASE WHEN p.direction = 'debit' THEN p.amount ELSE -p.amount END), 0)::numeric(79,0) AS balance
FROM ledger_accounts a
LEFT JOIN ledger_postings p ON p.account_id = a.id
GROUP BY a.id;
--> statement-breakpoint

-- =============================================================================================
-- 3. Deal lifecycle: only forward transitions.
--    accepted -> payment_locked -> settled | refunded ; accepted -> expired
-- =============================================================================================
CREATE OR REPLACE FUNCTION sealdesk_deal_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'accepted' AND NEW.status IN ('payment_locked', 'expired'))
     OR (OLD.status = 'payment_locked' AND NEW.status IN ('settled', 'refunded')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal deal status transition % -> % for deal %', OLD.status, NEW.status, encode(OLD.deal_id, 'hex')
    USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deals_status_transition BEFORE UPDATE OF status ON deals
  FOR EACH ROW EXECUTE FUNCTION sealdesk_deal_transition();
--> statement-breakpoint

-- Terms of a deal are immutable once written (the deal id is their hash).
CREATE OR REPLACE FUNCTION sealdesk_deal_terms_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.buyer, NEW.seller, NEW.token_address, NEW.amount, NEW.pay_token, NEW.price, NEW.seller_payout,
      NEW.referrer, NEW.relayer_fee, NEW.deadline, NEW.salt, NEW.deal_id, NEW.chain_id, NEW.escrow_address)
     IS DISTINCT FROM
     (OLD.buyer, OLD.seller, OLD.token_address, OLD.amount, OLD.pay_token, OLD.price, OLD.seller_payout,
      OLD.referrer, OLD.relayer_fee, OLD.deadline, OLD.salt, OLD.deal_id, OLD.chain_id, OLD.escrow_address) THEN
    RAISE EXCEPTION 'deal terms are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deals_terms_immutable BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION sealdesk_deal_terms_immutable();
--> statement-breakpoint
CREATE TRIGGER deals_no_delete BEFORE DELETE ON deals
  FOR EACH ROW EXECUTE FUNCTION sealdesk_forbid_mutation();
--> statement-breakpoint

-- =============================================================================================
-- 4. Referral earnings (half the protocol fee, paid by the escrow at settlement).
-- =============================================================================================
CREATE VIEW referral_earnings AS
SELECT d.chain_id, d.referrer, d.pay_token,
       count(*) AS deals,
       sum(d.referrer_fee)::numeric(79,0) AS earned
FROM deals d
WHERE d.status = 'settled' AND d.referrer IS NOT NULL AND d.referrer_fee IS NOT NULL
GROUP BY d.chain_id, d.referrer, d.pay_token;
--> statement-breakpoint

-- =============================================================================================
-- 5. TimescaleDB (optional). On plain Postgres the same names exist as ordinary views,
--    so application code does not care which one it runs on.
-- =============================================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;

    PERFORM create_hypertable('price_candles', by_range('bucket', INTERVAL '30 days'), migrate_data => true);
    PERFORM create_hypertable('dex_snapshots', by_range('ts', INTERVAL '7 days'), migrate_data => true);
    PERFORM create_hypertable('settlement_ticks', by_range('ts', INTERVAL '30 days'), migrate_data => true);

    PERFORM add_retention_policy('dex_snapshots', INTERVAL '180 days');

    EXECUTE $v$
      CREATE MATERIALIZED VIEW desk_volume_daily
      WITH (timescaledb.continuous) AS
      SELECT time_bucket(INTERVAL '1 day', ts) AS day,
             chain_id, pay_token,
             count(*) AS deals,
             sum(price)::numeric(79,0) AS volume,
             sum(fee)::numeric(79,0) AS fees,
             sum(price_usd) AS volume_usd,
             sum(fee_usd) AS fees_usd
      FROM settlement_ticks
      GROUP BY day, chain_id, pay_token
      WITH NO DATA
    $v$;
    PERFORM add_continuous_aggregate_policy('desk_volume_daily',
      start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '15 minutes');
  ELSE
    RAISE NOTICE 'timescaledb not available: using plain tables and a regular view';
    EXECUTE $v$
      CREATE VIEW desk_volume_daily AS
      SELECT date_trunc('day', ts) AS day,
             chain_id, pay_token,
             count(*) AS deals,
             sum(price)::numeric(79,0) AS volume,
             sum(fee)::numeric(79,0) AS fees,
             sum(price_usd) AS volume_usd,
             sum(fee_usd) AS fees_usd
      FROM settlement_ticks
      GROUP BY 1, 2, 3
    $v$;
  END IF;
END
$$;
