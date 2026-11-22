/**
 * End-to-end on a real chain: SDK + API + contracts + indexer + relayer + MCP agents.
 * Skips (with a reason) when anvil is not installed.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Desk, EscrowClient, subscribe, type StreamEvent } from "@sealdesk/sdk";
import type { Hex } from "@sealdesk/shared";
import { Keystore } from "../../../packages/mcp/src/keystore.ts";
import { createMcpServer } from "../../../packages/mcp/src/server.ts";
import { Autopilot, ConfigSchema } from "../../../packages/mcp/src/autopilot.ts";
import { reconcile, ViemContractsReader } from "../../worker/src/jobs/onchain.ts";
import { MemoryCache } from "@sealdesk/infra";
import { burns } from "@sealdesk/db";
import { createLogger } from "@sealdesk/shared";
import { balanceOf, findAnvil, startStack, type Party, type Stack } from "./stack.ts";

const anvil = findAnvil();
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

describe("end to end on anvil", { skip: anvil ? false : "anvil not found (install Foundry or set ANVIL_BIN)" }, () => {
  let s: Stack;
  let buyerDesk: Desk;
  let sellerDesk: Desk;
  let escrow: EscrowClient;

  before(async () => {
    s = await startStack(anvil!);
    buyerDesk = await Desk.connect({ baseUrl: s.apiUrl }, "https://desk.test");
    sellerDesk = await Desk.connect({ baseUrl: s.apiUrl }, "https://desk.test");
    escrow = new EscrowClient(s.pub, s.escrow);
  });
  after(async () => {
    await s?.close();
  });

  const balances = () => ({ balanceOf: (token: Hex, owner: Hex) => balanceOf(s, token, owner) });

  async function bidAndAccept(opts: { amount: bigint; price: bigint; seller: Party; relayerFee?: bigint; deadlineSeconds?: number }) {
    const block = await buyerDesk.postBlock({ side: "buy", token: s.tsla, payToken: s.usd, amount: opts.amount.toString(), replyWindow: "1h" });
    const sent = await sellerDesk.answer({
      rfqId: block.rfq.id,
      signer: opts.seller.account,
      amount: opts.amount.toString(),
      price: opts.price.toString(),
      ...(opts.relayerFee !== undefined ? { relayerFee: opts.relayerFee.toString() } : {}),
      ...(opts.deadlineSeconds ? { deadlineSeconds: opts.deadlineSeconds } : {}),
    });
    const answers = await buyerDesk.readAnswers({ rfqId: block.rfq.id, manageToken: block.manageToken, secretKey: block.secretKey, balances: balances() });
    assert.equal(answers.length, 1);
    const deal = await buyerDesk.accept({ rfqId: block.rfq.id, manageToken: block.manageToken, answer: answers[0]!, wallet: s.buyer.address });
    return { block, sent, answers, deal };
  }

  test("SDK: bid -> sealed answer -> accept -> pay -> deliver settles; receipt, indexer and SSE agree", async () => {
    const amount = 100n * E18;
    const price = 38_011n * E6; // >= 10k tier -> 2.00%
    const events: StreamEvent[] = [];

    const block = await buyerDesk.postBlock({ side: "buy", token: s.tsla, payToken: s.usd, amount: amount.toString(), replyWindow: "1h" });
    const sub = subscribe({ baseUrl: s.apiUrl, channel: `rfq:${block.rfq.id}`, token: block.manageToken, onEvent: (e) => events.push(e) });
    try {

    const sent = await sellerDesk.answer({ rfqId: block.rfq.id, signer: s.seller.account, amount: amount.toString(), price: price.toString() });
    const answers = await buyerDesk.readAnswers({ rfqId: block.rfq.id, manageToken: block.manageToken, secretKey: block.secretKey, balances: balances() });
    assert.equal(answers[0]!.verdict, "signed");
    assert.equal(answers[0]!.funded, true, "seller holds the tokens on-chain");
    assert.deepEqual(answers[0]!.problems, []);

    const deal = await buyerDesk.accept({ rfqId: block.rfq.id, manageToken: block.manageToken, answer: answers[0]!, wallet: s.buyer.address });
    assert.equal(deal.terms.buyer, s.buyer.address);
    const q = await escrow.quote(deal.terms);
    assert.equal(q.fee, (price * 200n) / 10_000n);

    await escrow.depositPayment(s.buyer.wallet, deal.terms);
    assert.equal(await escrow.status(deal.terms), "payment_locked");
    await s.indexAll();

    const sellerView = await sellerDesk.myDeal(sent.quoteId, sent.quoteToken);
    assert.equal(sellerView?.status, "payment_locked", "indexer moved the deal");
    const usdBefore = await balanceOf(s, s.usd, s.seller.address);
    const tx = await escrow.deliver(s.seller.wallet, sellerView!.terms);
    assert.equal(await escrow.status(deal.terms), "settled");

    const reported = await sellerDesk.api.reportSettled(block.rfq.id, tx);
    assert.equal(reported.deal.status, "settled");
    const receipt = await buyerDesk.api.receipt(tx);
    assert.equal(receipt.fees.total, q.fee.toString());
    assert.equal(receipt.sellerProceeds, (price - q.fee).toString());

    assert.equal(await balanceOf(s, s.tsla, s.buyer.address), amount);
    assert.equal((await balanceOf(s, s.usd, s.seller.address)) - usdBefore, price - q.fee);
    assert.equal(await balanceOf(s, s.usd, s.vault), q.fee);

    await s.indexAll();
    if (process.env["E2E_DEBUG"]) {
      console.log("JOURNALS", JSON.stringify((await s.pg.query(`select description, block_number::text from ledger_journals order by id`)).rows));
      console.log("CURSOR", JSON.stringify((await s.pg.query(`select last_block::text from chain_cursors`)).rows), "HEAD", String(await s.pub.getBlockNumber()));
      console.log("EVENTS", JSON.stringify((await s.pg.query(`select kind, source from deal_events order by id`)).rows));
    }
    const bal = await s.pg.query<{ code: string; balance: string }>(
      `select code, balance::text from ledger_balances where asset = $1 and code in ('escrow:locked','vault:fees')`, [s.usd],
    );
    assert.deepEqual(Object.fromEntries(bal.rows.map((r) => [r.code, r.balance])), { "escrow:locked": "0", "vault:fees": q.fee.toString() });
    const tick = await s.pg.query<{ price_usd: string }>(`select price_usd::text from settlement_ticks`);
    assert.deepEqual(tick.rows.map((r) => r.price_usd), ["38011.000000"]);

    for (let i = 0; i < 50 && !events.some((e) => e.type === "deal.settled"); i++) await new Promise((r) => setTimeout(r, 100));
    } finally {
      sub.close();
    }
    const types = events.map((e) => e.type);
    for (const t of ["answer.received", "deal.accepted", "payment.locked", "deal.settled"]) assert.ok(types.includes(t), `missing ${t} in ${types}`);
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "gap-free sequence numbers");
  });

  test("Ghost mode: a one-time wallet with zero ETH delivers through the relayer", async () => {
    const ghost = await s.newParty(0n);
    const amount = 50n * E18;
    await s.mint(s.tsla, ghost.address, amount);
    const price = 19_000n * E6;
    const relayerFee = (price * 10n) / 10_000n;
    const { deal } = await bidAndAccept({ amount, price, seller: ghost, relayerFee });
    await escrow.depositPayment(s.buyer.wallet, deal.terms);

    const req = await escrow.ghostDelivery(ghost.account, s.relayerAddress, deal.terms);
    const queued = await sellerDesk.api.relayDeposit(req);
    const relayerUsd = await balanceOf(s, s.usd, s.relayerAddress);

    const outcome = await s.relayer.processNext("e2e", 0);
    assert.equal(outcome?.kind, "mined", JSON.stringify(outcome));
    assert.equal(await escrow.status(deal.terms), "settled");
    assert.equal(await s.pub.getBalance({ address: ghost.address }), 0n, "the one-time wallet never needed gas");
    assert.equal((await balanceOf(s, s.usd, s.relayerAddress)) - relayerUsd, relayerFee);
    assert.equal((await sellerDesk.api.relayStatus(queued.requestId)).state, "mined");
  });

  test("refund after the deadline returns the payment and the indexer records it", async () => {
    const amount = 10n * E18;
    const price = 3_800n * E6;
    const { deal } = await bidAndAccept({ amount, price, seller: s.seller, deadlineSeconds: 11 * 60 });
    const before = await balanceOf(s, s.usd, s.buyer.address);
    await escrow.depositPayment(s.buyer.wallet, deal.terms);
    await assert.rejects(escrow.refund(s.buyer.wallet, deal.terms), "refund before the deadline must revert");

    await s.rpc("evm_increaseTime", [12 * 60]);
    await s.rpc("evm_mine", []);
    await escrow.refund(s.buyer.wallet, deal.terms);
    assert.equal(await escrow.status(deal.terms), "refunded");
    assert.equal(await balanceOf(s, s.usd, s.buyer.address), before);

    await s.indexAll();
    const r = await s.pg.query<{ status: string }>(`select status from deals where deal_id = decode($1, 'hex')`, [deal.dealId.slice(2)]);
    assert.equal(r.rows[0]!.status, "refunded");
  });

  test("pay with the platform token: flat 1.5% fee burned at settlement; indexer and ledger agree", async () => {
    const DEAD = "0x000000000000000000000000000000000000dead" as Hex;
    const amount = 20n * E18;
    const price = 50_000n * E18; // in the platform token
    await s.mint(s.seal, s.buyer.address, price);
    const deadBefore = await balanceOf(s, s.seal, DEAD);

    const block = await buyerDesk.postBlock({ side: "buy", token: s.tsla, payToken: s.seal, amount: amount.toString(), replyWindow: "1h" });
    await sellerDesk.answer({ rfqId: block.rfq.id, signer: s.seller.account, amount: amount.toString(), price: price.toString() });
    const answers = await buyerDesk.readAnswers({ rfqId: block.rfq.id, manageToken: block.manageToken, secretKey: block.secretKey, balances: balances() });
    const deal = await buyerDesk.accept({ rfqId: block.rfq.id, manageToken: block.manageToken, answer: answers[0]!, wallet: s.buyer.address });

    const q = await escrow.quote(deal.terms);
    assert.equal(q.fee, (price * 150n) / 10_000n, "flat 1.5%");
    await escrow.depositPayment(s.buyer.wallet, deal.terms);
    const tx = await escrow.deliver(s.seller.wallet, deal.terms);
    assert.equal(await escrow.status(deal.terms), "settled");
    assert.equal((await balanceOf(s, s.seal, DEAD)) - deadBefore, q.vaultFee, "protocol share burned");
    assert.equal(await balanceOf(s, s.seal, s.vault), 0n, "nothing went to the vault");

    await s.indexAll();
    const burnRows = await s.db.select().from(burns);
    const row = burnRows.find((b) => Buffer.from(b.txHash).toString("hex") === tx.slice(2).toLowerCase());
    assert.ok(row, "the burn is recorded");
    assert.equal(row!.amountBurned, q.vaultFee.toString());
  });

  test("nightly reconciliation: chain, contract totals and ledger agree", async () => {
    await s.indexAll();
    const report = await reconcile(s.db, new ViemContractsReader(s.pub, s.escrow, s.vault), {
      chainId: 4663, escrow: s.escrow, vault: s.vault, assets: ["0x0000000000000000000000000000000000000000", s.usd, s.seal],
      now: new Date(), log: createLogger("e2e", "silent"), cache: new MemoryCache(),
    });
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  });

  test("MCP: two agents (buyer and seller) trade a block end to end; secrets never reach the agent", async () => {
    const connect = async (party: Party, dir: string) => {
      const keystore = new Keystore(path.join(dir, "keystore.json"));
      const server = createMcpServer({ desk: await Desk.connect({ baseUrl: s.apiUrl }, "https://desk.test"), pub: s.pub, wallet: party.wallet, keystore, stable: s.usd });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: "e2e-agent", version: "1.0.0" });
      await client.connect(ct);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        const text = r.content[0]!.text;
        return { isError: r.isError === true, text, json: r.isError ? null : (JSON.parse(text) as Record<string, any>) };
      };
      return { client, call, keystore, file: path.join(dir, "keystore.json") };
    };
    const buyerDir = await mkdtemp(path.join(tmpdir(), "sd-buyer-"));
    const buyer = await connect(s.buyer, buyerDir);
    const seller = await connect(s.seller, await mkdtemp(path.join(tmpdir(), "sd-seller-")));

    const tools = (await buyer.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      "accept_answer", "deposit_payment", "deposit_tokens", "get_deal_status", "get_token_info", "list_markets",
      "list_open_blocks", "post_block", "read_sealed_answers", "refund_deal", "send_sealed_answer",
    ]);

    const info = await buyer.call("get_token_info", { address: s.tsla });
    assert.equal(info.json!.token.symbol, "TSLA");

    const posted = await buyer.call("post_block", { side: "buy", token: s.tsla, payToken: "USD", amount: (25n * E18).toString(), replyWindow: "1h" });
    const rfqId = posted.json!.rfqId as string;
    const ks = JSON.parse(await readFile(buyer.file, "utf8"));
    assert.ok(!posted.text.includes(ks.blocks[0].manageToken) && !posted.text.includes(ks.blocks[0].secretKey), "no secrets in tool output");

    const open = await seller.call("list_open_blocks", { token: s.tsla });
    assert.ok(open.json!.items.some((r: { id: string }) => r.id === rfqId));
    assert.ok(!/price/i.test(JSON.stringify(open.json!.items)));

    const answered = await seller.call("send_sealed_answer", { rfqId, amount: (25n * E18).toString(), price: (9_500n * E6).toString(), dealDeadlineMinutes: 120 });
    const quoteId = answered.json!.quoteId as string;

    const read = await buyer.call("read_sealed_answers", { rfqId });
    assert.equal(read.json!.answers[0].verdict, "signed");
    assert.equal(read.json!.answers[0].untrusted.price, (9_500n * E6).toString());

    const preview = await buyer.call("accept_answer", { rfqId, quoteId, confirm: false });
    assert.equal(preview.json!.preview, true);
    assert.equal(preview.json!.fees.total, ((9_500n * E6 * 250n) / 10_000n).toString());

    assert.equal((await buyer.call("accept_answer", { rfqId, quoteId, confirm: true })).json!.accepted, true);

    const wrongSide = await seller.call("deposit_payment", { quoteId, confirm: true });
    assert.equal(wrongSide.isError, true);
    assert.match(wrongSide.text, /not the buyer/);

    const early = await seller.call("deposit_tokens", { quoteId, confirm: true });
    assert.equal(early.isError, true, "payment locks first");

    assert.equal((await buyer.call("deposit_payment", { rfqId, confirm: true })).json!.paymentLocked, true);
    const settled = await seller.call("deposit_tokens", { quoteId, confirm: true });
    assert.equal(settled.json!.settled, true, settled.text);
    assert.equal(settled.json!.recorded, true);

    const status = await buyer.call("get_deal_status", { rfqId });
    assert.equal(status.json!.deals[0].onChain, "settled");
    assert.equal(status.json!.deals[0].desk, "settled");
  });

  test("Autopilot: dry run sends nothing; live answers a matching bid by its rules, delivers once paid, settles", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sd-autopilot-"));
    const logs: string[] = [];
    const make = async (live: boolean) => {
      const cfg = ConfigSchema.parse({
        live, dailyMaxUsd: 100_000, dealMinutes: 60,
        rules: [{ token: s.tsla, side: "sell", premiumPct: 2, refPriceUsd: 380, maxUsdPerBlock: 10_000 }],
      });
      return new Autopilot(
        { desk: await Desk.connect({ baseUrl: s.apiUrl }, "https://desk.test"), pub: s.pub, wallet: s.seller.wallet, keystore: new Keystore(path.join(dir, "keystore.json")), stable: s.usd, stateFile: path.join(dir, "autopilot.json"), log: (l) => logs.push(l) },
        cfg,
      );
    };

    const block = await buyerDesk.postBlock({ side: "buy", token: s.tsla, payToken: s.usd, amount: (10n * E18).toString(), replyWindow: "1h" });

    // Dry run: decides, logs, sends nothing.
    const dry = await make(false);
    await dry.start();
    assert.equal((await dry.tick()).answered, 1);
    assert.equal((await buyerDesk.api.getRfq(block.rfq.id)).rfq.quoteCount, 0, "dry run must not answer");
    assert.ok(logs.some((l) => l.startsWith("DRY RUN: would answer")));

    // Live: answers at the reference price plus 2%: 10 x $387.60.
    const live = await make(true);
    await live.start();
    assert.equal((await live.tick()).answered, 1);
    const answers = await buyerDesk.readAnswers({ rfqId: block.rfq.id, manageToken: block.manageToken, secretKey: block.secretKey, balances: balances() });
    assert.equal(answers.length, 1);
    assert.equal(answers[0]!.verdict, "signed");
    assert.equal(answers[0]!.answer.terms.price, (3_876n * E6).toString());
    assert.equal((await live.tick()).answered, 0, "never answers the same block twice");

    const deal = await buyerDesk.accept({ rfqId: block.rfq.id, manageToken: block.manageToken, answer: answers[0]!, wallet: s.buyer.address });
    assert.equal((await live.tick()).actions, 0, "payment locks first: nothing to deliver yet");
    await escrow.depositPayment(s.buyer.wallet, deal.terms);
    assert.equal((await live.tick()).actions, 1);
    assert.equal(await escrow.status(deal.terms), "settled");
    const state = JSON.parse(await readFile(path.join(dir, "autopilot.json"), "utf8"));
    assert.equal(state.answered[0].done, "settled");
    assert.ok(state.spentUsd > 3_875 && state.spentUsd < 3_877);
  });
});
