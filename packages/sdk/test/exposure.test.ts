import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExposure, type ExposureReader, type TransferLog } from "../src/index.ts";
import type { Hex, Terms } from "../src/types.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const ONE = A(1), MAIN = A(2), MIXER = A(3), FRIEND = A(4), ESCROW = A(9), TOKEN = A(100);
let tx = 0;
const log = (from: Hex, to: Hex, block = 50n): TransferLog => ({ token: TOKEN, from, to, value: 1n, block, tx: `0x${(++tx).toString(16).padStart(64, "0")}` as Hex });

function reader(logs: TransferLog[], opts: { nonce?: number; eth?: bigint } = {}): ExposureReader & { queries: number } {
  const r = {
    queries: 0,
    latestBlock: async () => 100n,
    blockAt: async (ts: number) => BigInt(Math.max(0, Math.floor(ts / 1000) % 100)),
    async transfers(q: { from?: Hex; to?: Hex; fromBlock: bigint; toBlock: bigint }) {
      r.queries++;
      return { logs: logs.filter((l) => (!q.from || l.from === q.from) && (!q.to || l.to === q.to) && l.block >= q.fromBlock && l.block <= q.toBlock), partial: false };
    },
    nonce: async () => opts.nonce ?? 0,
    ethBalance: async () => opts.eth ?? 0n,
  };
  return r;
}

const terms = (payout: Hex): Terms => ({
  buyer: A(5), seller: ONE, token: TOKEN, amount: "1", payToken: A(0), price: "1", sellerPayout: payout,
  referrer: A(0), relayerFee: "0", deadline: 0, salt: `0x${"0".repeat(64)}` as Hex,
});
const since = new Date(0);

test("payout to your own wallet is a direct link", async () => {
  const r = await checkExposure(reader([log(MIXER, ONE)]), { oneTime: ONE, terms: terms(MAIN), mine: [MAIN], since });
  assert.equal(r.level, "exposed");
  assert.equal(r.findings[0]!.severity, "direct");
  assert.deepEqual(r.findings[0]!.path, [MAIN, ONE]);
});

test("funding straight from your wallet is a direct link, with the transaction", async () => {
  const fund = log(MAIN, ONE);
  const r = await checkExposure(reader([fund]), { oneTime: ONE, terms: terms(FRIEND), mine: [MAIN], since });
  assert.equal(r.level, "exposed");
  const f = r.findings.find((x) => x.title.startsWith("Funded straight"));
  assert.equal(f?.tx, fund.tx);
});

test("a funder that once traded with your wallet is a two-hop link", async () => {
  const r = await checkExposure(reader([log(MAIN, MIXER, 10n), log(MIXER, ONE)]), { oneTime: ONE, terms: terms(ONE), mine: [MAIN], since });
  assert.equal(r.level, "weak");
  assert.deepEqual(r.findings[0]!.path, [MAIN, MIXER, ONE]);
});

test("tokens sent back to your wallet after the deal are a direct link", async () => {
  const r = await checkExposure(reader([log(MIXER, ONE), log(ONE, MAIN, 80n)]), { oneTime: ONE, mine: [MAIN], since });
  assert.equal(r.level, "exposed");
  assert.match(r.findings[0]!.title, /sent back/);
});

test("escrow and relayer are not counterparties; unrelated funder is clean", async () => {
  const r = await checkExposure(reader([log(MIXER, ONE), log(ONE, ESCROW, 70n)]), { oneTime: ONE, terms: terms(ONE), mine: [MAIN], since, ignore: [ESCROW] });
  assert.equal(r.level, "clean");
  assert.ok(!r.findings.some((f) => f.detail.includes(ESCROW.slice(0, 6) + "…" + ESCROW.slice(-4))));
});

test("unfunded wallet, ETH activity and no wallets to compare are reported as info", async () => {
  const r = await checkExposure(reader([], { nonce: 2 }), { oneTime: ONE, mine: [], since });
  assert.equal(r.level, "clean");
  const titles = r.findings.map((f) => f.title);
  assert.ok(titles.includes("Not funded yet"));
  assert.ok(titles.includes("Sent 2 transactions itself"));
  assert.ok(titles.includes("No wallet to compare with"));
});
