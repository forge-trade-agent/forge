/**
 * Applies every migration to an in-process PostgreSQL (PGlite) and checks that the
 * integrity guards actually hold. TimescaleDB paths are exercised in CI on real Postgres.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_DIR } from "../src/migrate.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const H = (n: number) => `\\x${n.toString(16).padStart(64, "0")}`;
const BUYER = A(0xb0b);
const SELLER = A(0x5e11);
const TOKEN = A(0x7e51a);
const USD = A(0x05d);
const ESCROW = A(0xe5c);

let pg: PGlite;

async function rejects(sqlText: string, pattern: RegExp, params: unknown[] = []) {
  await assert.rejects(pg.query(sqlText, params), (err: Error) => {
    assert.match(err.message, pattern);
    return true;
  });
}

before(async () => {
  pg = new PGlite();
  await migrate(drizzle(pg), { migrationsFolder: MIGRATIONS_DIR });

  await pg.exec(`
    INSERT INTO rfqs (id, chain_id, side, token_address, pay_token, amount, enc_pub_key, manage_token_hash, expires_at)
    VALUES ('RFQ1', 4663, 'buy', '${TOKEN}', '${USD}', 1000, '${H(1)}'::bytea, '${H(2)}'::bytea, now() + interval '1 hour');
    INSERT INTO quotes (id, rfq_id, sender_enc_pub_key, nonce, ciphertext, quote_token_hash)
    VALUES ('Q1', 'RFQ1', '${H(3)}'::bytea, decode(repeat('ab', 24), 'hex'), decode(repeat('cd', 64), 'hex'), '${H(4)}'::bytea);
    INSERT INTO deals (deal_id, chain_id, escrow_address, rfq_id, quote_id, buyer, seller, token_address, amount,
                       pay_token, price, seller_payout, deadline, salt)
    VALUES ('${H(10)}'::bytea, 4663, '${ESCROW}', 'RFQ1', 'Q1', '${BUYER}', '${SELLER}', '${TOKEN}', 1000,
            '${USD}', 5000000000, '${SELLER}', now() + interval '1 hour', '${H(11)}'::bytea);
  `);
});

after(async () => {
  await pg.close();
});

test("all tables and views exist", async () => {
  const res = await pg.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const names = new Set(res.rows.map((r) => r.name));
  for (const t of [
    "markets", "rfqs", "quotes", "deals", "deal_events", "chain_cursors", "indexed_blocks",
    "ledger_accounts", "ledger_journals", "ledger_postings", "relayer_txs", "notification_subscriptions",
    "idempotency_keys", "price_candles", "dex_snapshots", "settlement_ticks", "burns",
    "ledger_balances", "referral_earnings", "desk_volume_daily",
  ]) {
    assert.ok(names.has(t), `missing ${t}`);
  }
});

test("addresses must be lower-case 0x + 40 hex", async () => {
  await rejects(
    `INSERT INTO markets (chain_id, symbol, name, kind, token_address, decimals) VALUES (1, 'X', 'X', 'token', '0xABC', 18)`,
    /markets_token_address_addr/,
  );
});

test("sealed answers enforce nonce and ciphertext sizes", async () => {
  await rejects(
    `INSERT INTO quotes (id, rfq_id, sender_enc_pub_key, nonce, ciphertext, quote_token_hash)
     VALUES ('Q2', 'RFQ1', '${H(5)}'::bytea, decode('00', 'hex'), decode(repeat('cd', 64), 'hex'), '${H(6)}'::bytea)`,
    /quotes_nonce_len/,
  );
  await rejects(
    `INSERT INTO quotes (id, rfq_id, sender_enc_pub_key, nonce, ciphertext, quote_token_hash)
     VALUES ('Q3', 'RFQ1', '${H(5)}'::bytea, decode(repeat('ab', 24), 'hex'), decode(repeat('cd', 5000), 'hex'), '${H(7)}'::bytea)`,
    /quotes_ct_len/,
  );
});

test("referrer can't be a party to the deal", async () => {
  await rejects(
    `INSERT INTO deals (deal_id, chain_id, escrow_address, rfq_id, quote_id, buyer, seller, token_address, amount,
                        pay_token, price, seller_payout, referrer, deadline, salt)
     VALUES ('${H(20)}'::bytea, 4663, '${ESCROW}', 'RFQ1', 'Q1', '${BUYER}', '${SELLER}', '${TOKEN}', 1,
             '${USD}', 1, '${SELLER}', '${BUYER}', now(), '${H(21)}'::bytea)`,
    /deals_referrer_not_party/,
  );
});

test("deal status only moves forward", async () => {
  await pg.query(`UPDATE deals SET status = 'payment_locked' WHERE deal_id = '${H(10)}'::bytea`);
  await rejects(`UPDATE deals SET status = 'accepted' WHERE deal_id = '${H(10)}'::bytea`, /illegal deal status transition/);
  await rejects(`UPDATE deals SET status = 'settled' WHERE deal_id = '${H(10)}'::bytea`, /deals_status_consistency/);
  await pg.query(
    `UPDATE deals SET status = 'settled', settle_tx = '${H(30)}'::bytea, settled_at = now() WHERE deal_id = '${H(10)}'::bytea`,
  );
  await rejects(`UPDATE deals SET status = 'refunded' WHERE deal_id = '${H(10)}'::bytea`, /illegal deal status transition/);
});

test("deal terms are immutable and deals can't be deleted", async () => {
  await rejects(`UPDATE deals SET price = 1 WHERE deal_id = '${H(10)}'::bytea`, /deal terms are immutable/);
  await rejects(`DELETE FROM deals WHERE deal_id = '${H(10)}'::bytea`, /append-only/);
});

test("deal events are append-only", async () => {
  await pg.query(
    `INSERT INTO deal_events (deal_id, kind, source, chain_id, tx_hash, log_index, block_number)
     VALUES ('${H(10)}'::bytea, 'Settled', 'chain', 4663, '${H(30)}'::bytea, 0, 100)`,
  );
  await rejects(`UPDATE deal_events SET kind = 'x'`, /append-only/);
  await rejects(`DELETE FROM deal_events`, /append-only/);
  // the same chain log can't be recorded twice
  await rejects(
    `INSERT INTO deal_events (deal_id, kind, source, chain_id, tx_hash, log_index, block_number)
     VALUES ('${H(10)}'::bytea, 'Settled', 'chain', 4663, '${H(30)}'::bytea, 0, 100)`,
    /deal_events_chain_log_uq/,
  );
});

test("balanced ledger journals commit", async () => {
  await pg.exec(`
    INSERT INTO ledger_accounts (chain_id, code, asset) VALUES
      (4663, 'escrow:locked', '${USD}'), (4663, 'external:${BUYER}', '${USD}');
  `);
  await pg.transaction(async (tx) => {
    const j = await tx.query<{ id: string }>(
      `INSERT INTO ledger_journals (chain_id, tx_hash, log_index, block_number, description)
       VALUES (4663, '${H(40)}'::bytea, 0, 100, 'PaymentLocked') RETURNING id`,
    );
    const id = j.rows[0]!.id;
    await tx.query(
      `INSERT INTO ledger_postings (journal_id, account_id, direction, amount)
       SELECT $1, id, 'debit', 5000 FROM ledger_accounts WHERE code = 'escrow:locked'`,
      [id],
    );
    await tx.query(
      `INSERT INTO ledger_postings (journal_id, account_id, direction, amount)
       SELECT $1, id, 'credit', 5000 FROM ledger_accounts WHERE code = 'external:${BUYER}'`,
      [id],
    );
  });
  const bal = await pg.query<{ code: string; balance: string }>(`SELECT code, balance::text FROM ledger_balances ORDER BY code`);
  assert.deepEqual(
    bal.rows.map((r) => [r.code, r.balance]),
    [["escrow:locked", "5000"], [`external:${BUYER}`, "-5000"]],
  );
});

test("unbalanced ledger journals are rejected at commit", async () => {
  await assert.rejects(
    pg.transaction(async (tx) => {
      const j = await tx.query<{ id: string }>(
        `INSERT INTO ledger_journals (chain_id, tx_hash, log_index, block_number, description)
         VALUES (4663, '${H(41)}'::bytea, 0, 101, 'bad') RETURNING id`,
      );
      const id = j.rows[0]!.id;
      await tx.query(
        `INSERT INTO ledger_postings (journal_id, account_id, direction, amount)
         SELECT $1, id, 'debit', 5000 FROM ledger_accounts WHERE code = 'escrow:locked'`,
        [id],
      );
      await tx.query(
        `INSERT INTO ledger_postings (journal_id, account_id, direction, amount)
         SELECT $1, id, 'credit', 4999 FROM ledger_accounts WHERE code = 'external:${BUYER}'`,
        [id],
      );
    }),
    /does not balance/,
  );
});

test("journals without postings are rejected at commit", async () => {
  await assert.rejects(
    pg.query(
      `INSERT INTO ledger_journals (chain_id, tx_hash, log_index, block_number, description)
       VALUES (4663, '${H(42)}'::bytea, 0, 102, 'empty')`,
    ),
    /at least 2 required/,
  );
});

test("referral earnings view sums settled referrer fees", async () => {
  const r = await pg.query(`SELECT * FROM referral_earnings`);
  assert.equal(r.rows.length, 0); // the settled deal above has no referrer
});
