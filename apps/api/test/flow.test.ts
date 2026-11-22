/**
 * End-to-end desk flow through the HTTP API: post -> sealed answers -> decrypt + verify ->
 * accept (partial fills) -> settle report -> receipt, plus Ghost-mode relay, idempotency,
 * capability auth, rate limits and the SSE stream.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  answerTypedData,
  checkAnswer,
  dealIdOf,
  deliverTypedData,
  generateKeyPair,
  openAnswer,
  sealAnswer,
  toB64,
  type KeyPair,
} from "@sealdesk/crypto";
import { hashToken, type Hex, type Terms } from "@sealdesk/shared";
import { auth, CHAIN_ID, createHarness, ESCROW, idem, RELAYER, STABLE, TSLA, ZERO, type Harness } from "./harness.ts";

const E18 = 10n ** 18n;
const lc = (a: string) => a.toLowerCase() as Hex;

let h: Harness;
let buyerKeys: KeyPair;
let rfqId: string;
let manageToken: string;
const buyer = lc(privateKeyToAccount(generatePrivateKey()).address);
const sellers = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];

function termsFor(sellerPk: Hex, amount: bigint, price: bigint, salt: string, extra: Partial<Terms> = {}): Terms {
  const seller = lc(privateKeyToAccount(sellerPk).address);
  return {
    buyer,
    seller,
    token: TSLA,
    amount: amount.toString(),
    payToken: STABLE,
    price: price.toString(),
    sellerPayout: seller,
    referrer: ZERO,
    relayerFee: "0",
    deadline: Math.floor(h.clock.now / 1000) + 3600,
    salt: `0x${salt.padStart(64, "0")}` as Hex,
    ...extra,
  };
}

/** Answers leave the poster's side (buyer, referrer) empty; the poster fills it on accept. */
async function postAnswer(sellerPk: Hex, terms: Terms) {
  const account = privateKeyToAccount(sellerPk);
  terms = { ...terms, buyer: ZERO };
  const signature = await account.signTypedData(answerTypedData(CHAIN_ID, ESCROW, rfqId, terms));
  const body = sealAnswer({ v: 1, rfqId, terms, signature }, buyerKeys.publicKey);
  const res = await h.app.inject({ method: "POST", url: `/rfqs/${rfqId}/quotes`, headers: idem(), payload: body });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { quoteId: string; quoteToken: string };
}

async function accept(quoteId: string, terms: Terms) {
  return h.app.inject({
    method: "POST",
    url: `/rfqs/${rfqId}/accept`,
    headers: { ...idem(), ...auth(manageToken) },
    payload: { quoteId, terms },
  });
}

const quoteIds: { quoteId: string; quoteToken: string }[] = [];
const acceptedTerms: Terms[] = [];

before(async () => {
  h = await createHarness();
  buyerKeys = generateKeyPair();
});
after(async () => {
  await h.close();
});

describe("posting", () => {
  test("create a bid: 201, manage token returned once, public view has no price", async () => {
    const headers = idem();
    const payload = {
      side: "buy",
      token: TSLA,
      payToken: STABLE,
      amount: (2500n * E18).toString(),
      sizeUsd: "950275.00",
      encPubKey: toB64(buyerKeys.publicKey),
      replyWindow: "1h",
      allowPartial: true,
    };
    const res = await h.app.inject({ method: "POST", url: "/rfqs", headers, payload });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    rfqId = body.rfq.id;
    manageToken = body.manageToken;
    assert.match(manageToken, /^sd_/);
    assert.equal(body.token.symbol, "TSLA");

    // retry with the same key replays the same response
    const again = await h.app.inject({ method: "POST", url: "/rfqs", headers, payload });
    assert.equal(again.statusCode, 201);
    assert.equal(again.headers["idempotent-replayed"], "true");
    assert.equal(again.json().rfq.id, rfqId);

    // same key, different body -> conflict
    const conflict = await h.app.inject({ method: "POST", url: "/rfqs", headers, payload: { ...payload, replyWindow: "4h" } });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");

    const list = await h.app.inject({ method: "GET", url: "/rfqs" });
    assert.equal(list.json().items.length, 1);
    assert.deepEqual(list.json().counts, { open: 1, buying: 1, selling: 0, sealed: 0 });
    assert.ok(!/price/i.test(JSON.stringify(list.json().items)));
  });

  test("validation: idempotency key required, unsupported pay token, token without code", async () => {
    const base = { side: "sell", token: TSLA, payToken: STABLE, amount: "1", encPubKey: toB64(buyerKeys.publicKey), replyWindow: "15m" };
    const noKey = await h.app.inject({ method: "POST", url: "/rfqs", payload: base });
    assert.equal(noKey.statusCode, 400);

    const badPay = await h.app.inject({ method: "POST", url: "/rfqs", headers: idem(), payload: { ...base, payToken: TSLA.replace("3", "4") } });
    assert.equal(badPay.json().error.code, "UNSUPPORTED_PAY_TOKEN");

    const eoa = await h.app.inject({
      method: "POST", url: "/rfqs", headers: idem(), payload: { ...base, token: "0x00000000000000000000000000000000000000aa" },
    });
    assert.equal(eoa.json().error.code, "TOKEN_NOT_CONTRACT");

    const bad = await h.app.inject({ method: "POST", url: "/rfqs", headers: idem(), payload: { ...base, amount: "1e18" } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.problems[0].path, "amount");
  });
});

describe("site CA (/admin)", () => {
  const TOKEN = "test-admin-token-0123456789abcdef";
  let a: Harness;
  before(async () => {
    a = await createHarness({ adminTokenHash: hashToken(TOKEN) });
  });
  after(() => a.close());
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  test("nothing posted: /site is empty", async () => {
    const r = await a.app.inject({ method: "GET", url: "/site" });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ca: null });
  });

  test("writes need the admin token", async () => {
    const none = await a.app.inject({ method: "PUT", url: "/admin/ca", payload: { address: ZERO } });
    assert.equal(none.statusCode, 401);
    const wrong = await a.app.inject({ method: "PUT", url: "/admin/ca", headers: bearer("nope-nope-nope-nope-nope"), payload: { address: ZERO } });
    assert.equal(wrong.statusCode, 401);
    assert.equal((await a.app.inject({ method: "GET", url: "/admin/session", headers: bearer(TOKEN) })).statusCode, 200);
  });

  test("post, update, validate and remove", async () => {
    const evm = "0x1111111111111111111111111111111111111111";
    const put = await a.app.inject({ method: "PUT", url: "/admin/ca", headers: bearer(TOKEN), payload: { address: evm, network: "Robinhood Chain" } });
    assert.equal(put.statusCode, 200);
    let site = (await a.app.inject({ method: "GET", url: "/site" })).json();
    assert.equal(site.ca.address, evm);
    assert.equal(site.ca.network, "Robinhood Chain");

    const sol = "So11111111111111111111111111111111111111112";
    await a.app.inject({ method: "PUT", url: "/admin/ca", headers: bearer(TOKEN), payload: { address: sol, link: "https://example.com/chart" } });
    site = (await a.app.inject({ method: "GET", url: "/site" })).json();
    assert.equal(site.ca.address, sol);
    assert.equal(site.ca.network, undefined, "an update replaces the old fields");

    const bad = await a.app.inject({ method: "PUT", url: "/admin/ca", headers: bearer(TOKEN), payload: { address: "not-an-address" } });
    assert.equal(bad.statusCode, 400);
    const http = await a.app.inject({ method: "PUT", url: "/admin/ca", headers: bearer(TOKEN), payload: { address: evm, link: "http://insecure.example" } });
    assert.equal(http.statusCode, 400);

    assert.equal((await a.app.inject({ method: "DELETE", url: "/admin/ca", headers: bearer(TOKEN) })).statusCode, 200);
    assert.deepEqual((await a.app.inject({ method: "GET", url: "/site" })).json(), { ca: null });
  });

  test("wrong tokens are rate limited per address", async () => {
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await a.app.inject({ method: "GET", url: "/admin/session", headers: bearer(`wrong-token-number-${i}-xxxxx`) })).statusCode;
    assert.equal(last, 429);
  });

  test("admin is off when no token is configured", async () => {
    const r = await h.app.inject({ method: "GET", url: "/admin/session", headers: bearer(TOKEN) });
    assert.equal(r.statusCode, 404);
  });
});

describe("alerts", () => {
  const cap = () => ({ kind: "rfq", id: rfqId });
  test("subscribe, list without the destination, send a test, remove; the token is required", async () => {
    const noAuth = await h.app.inject({ method: "POST", url: "/notifications", payload: { capability: cap(), channel: "email", destination: "a@b.co" } });
    assert.equal(noAuth.statusCode, 401, noAuth.body);
    const empty = await h.app.inject({ method: "POST", url: "/notifications/test", headers: auth(manageToken), payload: { capability: cap() } });
    assert.equal(empty.statusCode, 400, empty.body);

    const sub = await h.app.inject({ method: "POST", url: "/notifications", headers: auth(manageToken), payload: { capability: cap(), channel: "email", destination: "a@b.co" } });
    assert.equal(sub.statusCode, 201, sub.body);
    const list = await h.app.inject({ method: "GET", url: `/notifications?kind=rfq&id=${rfqId}`, headers: auth(manageToken) });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().items.map((i: { channel: string }) => i.channel), ["email"]);
    assert.ok(!list.body.includes("a@b.co"), "destination never returned");

    const t = await h.app.inject({ method: "POST", url: "/notifications/test", headers: auth(manageToken), payload: { capability: cap() } });
    assert.equal(t.statusCode, 200, t.body);
    const ev = await h.bus.read("notify", 0, 0);
    assert.ok(ev.some((e) => e.type === "notify.test" && e.data["channel"] === `rfq:${rfqId}`));
    for (let i = 0; i < 2; i++) await h.app.inject({ method: "POST", url: "/notifications/test", headers: auth(manageToken), payload: { capability: cap() } });
    const limited = await h.app.inject({ method: "POST", url: "/notifications/test", headers: auth(manageToken), payload: { capability: cap() } });
    assert.equal(limited.statusCode, 429);

    const rm = await h.app.inject({ method: "POST", url: "/notifications/remove", headers: auth(manageToken), payload: { capability: cap(), channel: "email" } });
    assert.equal(rm.statusCode, 200);
    const after = await h.app.inject({ method: "GET", url: `/notifications?kind=rfq&id=${rfqId}`, headers: auth(manageToken) });
    assert.deepEqual(after.json().items, []);
  });

  test("channels the desk has switched off are refused; health lists the enabled ones", async () => {
    const h2 = await createHarness({ notify: { channels: ["webhook"], telegramBot: "forge_alerts_bot" } });
    const health = await h2.app.inject({ method: "GET", url: "/health" });
    assert.deepEqual(health.json().notifications, { channels: ["webhook"], telegramBot: "forge_alerts_bot" });
    const res = await h2.app.inject({ method: "POST", url: "/notifications", headers: auth("x".repeat(43)), payload: { capability: { kind: "rfq", id: "0".repeat(26) }, channel: "telegram", destination: "12345" } });
    assert.equal(res.statusCode, 400, res.body);
    await h2.app.close();
  });
});

describe("sealed answers", () => {
  test("sellers answer; only the manage token can read; the poster decrypts and verifies", async () => {
    quoteIds.push(await postAnswer(sellers[0]!, termsFor(sellers[0]!, 1000n * E18, 380_100_000_000n, "1")));
    quoteIds.push(await postAnswer(sellers[1]!, termsFor(sellers[1]!, 1500n * E18, 570_300_000_000n, "2")));

    const anon = await h.app.inject({ method: "GET", url: `/rfqs/${rfqId}/quotes` });
    assert.equal(anon.statusCode, 401);
    const wrong = await h.app.inject({ method: "GET", url: `/rfqs/${rfqId}/quotes`, headers: auth(quoteIds[0]!.quoteToken) });
    assert.equal(wrong.statusCode, 401);

    const res = await h.app.inject({ method: "GET", url: `/rfqs/${rfqId}/quotes`, headers: auth(manageToken) });
    assert.equal(res.statusCode, 200);
    const items = res.json().items as { id: string; sealed: { senderEncPubKey: string; nonce: string; ciphertext: string } }[];
    assert.equal(items.length, 2);
    assert.ok(!JSON.stringify(items).includes("380100000000"), "server response must not contain plaintext price");

    const rfq = (await h.app.inject({ method: "GET", url: `/rfqs/${rfqId}` })).json().rfq;
    assert.equal(rfq.quoteCount, 2);
    for (const it of items) {
      const opened = openAnswer(it.sealed, buyerKeys.secretKey);
      assert.ok(opened.ok);
      const checked = await checkAnswer(rfq, opened.answer, { chainId: CHAIN_ID, escrow: ESCROW, now: h.clock.now });
      assert.equal(checked.verdict, "signed");
      assert.deepEqual(checked.problems, []);
    }
  });
});

describe("accept and partial fills", () => {
  test("terms that don't match the posting are rejected", async () => {
    const t = termsFor(sellers[0]!, 1000n * E18, 1n, "1");
    const wrongToken = await accept(quoteIds[0]!.quoteId, { ...t, token: STABLE, payToken: ZERO });
    assert.equal(wrongToken.json().error.code, "TERMS_MISMATCH");
    const tooSoon = await accept(quoteIds[0]!.quoteId, { ...t, deadline: Math.floor(h.clock.now / 1000) + 60 });
    assert.equal(tooSoon.json().error.code, "TERMS_MISMATCH");
    const tooBig = await accept(quoteIds[0]!.quoteId, { ...t, amount: (2501n * E18).toString() });
    assert.equal(tooBig.json().error.code, "TERMS_MISMATCH");
    const noAuth = await h.app.inject({ method: "POST", url: `/rfqs/${rfqId}/accept`, headers: idem(), payload: { quoteId: "x", terms: t } });
    assert.equal(noAuth.statusCode, 401);
  });

  test("two partial accepts fill the posting; deal ids equal keccak(abi.encode(terms))", async () => {
    const t1 = termsFor(sellers[0]!, 1000n * E18, 380_100_000_000n, "1");
    const r1 = await accept(quoteIds[0]!.quoteId, t1);
    assert.equal(r1.statusCode, 201, r1.body);
    assert.equal(r1.json().deal.dealId, dealIdOf(t1));
    acceptedTerms.push(t1);

    const again = await accept(quoteIds[0]!.quoteId, t1);
    assert.equal(again.json().error.code, "QUOTE_ALREADY_ACCEPTED");

    let rfq = (await h.app.inject({ method: "GET", url: `/rfqs/${rfqId}` })).json().rfq;
    assert.equal(rfq.status, "open");
    assert.equal(rfq.filledAmount, (1000n * E18).toString());

    // relayer fee >= 10 bps so this deal can be delivered in Ghost mode later
    const price2 = 570_300_000_000n;
    const t2 = termsFor(sellers[1]!, 1500n * E18, price2, "2", { relayerFee: ((price2 * 10n) / 10_000n).toString() });
    const r2 = await accept(quoteIds[1]!.quoteId, t2);
    assert.equal(r2.statusCode, 201, r2.body);
    acceptedTerms.push(t2);

    rfq = (await h.app.inject({ method: "GET", url: `/rfqs/${rfqId}` })).json().rfq;
    assert.equal(rfq.status, "filled");

    const late = await h.app.inject({
      method: "POST",
      url: `/rfqs/${rfqId}/quotes`,
      headers: idem(),
      payload: sealAnswer({ v: 1, rfqId, terms: termsFor(sellers[2]!, 1n, 1n, "3") }, buyerKeys.publicKey),
    });
    assert.equal(late.json().error.code, "RFQ_CLOSED");

    const deals = (await h.app.inject({ method: "GET", url: `/rfqs/${rfqId}/deals`, headers: auth(manageToken) })).json().items;
    assert.equal(deals.length, 2);
  });

  test("the answerer sees the accepted terms with its quote token only", async () => {
    const res = await h.app.inject({ method: "GET", url: `/quotes/${quoteIds[0]!.quoteId}`, headers: auth(quoteIds[0]!.quoteToken) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().quote.status, "accepted");
    assert.equal(res.json().deal.terms.price, acceptedTerms[0]!.price);
    const other = await h.app.inject({ method: "GET", url: `/quotes/${quoteIds[0]!.quoteId}`, headers: auth(quoteIds[1]!.quoteToken) });
    assert.equal(other.statusCode, 401);
  });
});

describe("settlement", () => {
  const tx = `0x${"77".repeat(32)}` as Hex;

  test("a reported settlement is verified against the chain before it is recorded", async () => {
    const t = acceptedTerms[0]!;
    const unknown = await h.app.inject({ method: "POST", url: `/rfqs/${rfqId}/settled`, payload: { txHash: tx } });
    assert.equal(unknown.json().error.code, "TX_NOT_SETTLEMENT");

    const fee = (BigInt(t.price) * 250n) / 10_000n;
    h.chain.settlements.set(tx, {
      txHash: tx, blockNumber: 123n, timestamp: Math.floor(h.clock.now / 1000), escrow: ESCROW, dealId: dealIdOf(t),
      buyer: t.buyer, seller: t.seller, token: t.token, amount: BigInt(t.amount), payToken: t.payToken, price: BigInt(t.price),
      fee, referrerFee: 0n, relayerFee: 0n, relayer: ZERO,
    });
    const ok = await h.app.inject({ method: "POST", url: `/rfqs/${rfqId}/settled`, payload: { txHash: tx } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().deal.status, "settled");
    assert.equal(ok.json().deal.fee, fee.toString());

    const twice = await h.app.inject({ method: "POST", url: `/rfqs/${rfqId}/settled`, payload: { txHash: tx } });
    assert.equal(twice.json().deal.status, "settled");
  });

  test("public receipt shows the fee split", async () => {
    const res = await h.app.inject({ method: "GET", url: `/receipts/${tx}` });
    assert.equal(res.statusCode, 200);
    const t = acceptedTerms[0]!;
    const fee = (BigInt(t.price) * 250n) / 10_000n;
    assert.equal(res.json().fees.vault, fee.toString());
    assert.equal(res.json().sellerProceeds, (BigInt(t.price) - fee).toString());
    const byDeal = await h.app.inject({ method: "GET", url: `/deals/${dealIdOf(t)}/receipt` });
    assert.equal(byDeal.json().txHash, tx);
  });

  test("stats count accepted and settled deals", async () => {
    const s = (await h.app.inject({ method: "GET", url: "/stats" })).json();
    assert.equal(s.deals.accepted, 2);
    assert.equal(s.deals.settled, 1);
    assert.equal(s.sealedAnswers, 2);
  });
});

describe("ghost mode relay", () => {
  test("queues a correctly signed delivery for the configured relayer only", async () => {
    const t = acceptedTerms[1]!;
    const id = dealIdOf(t);
    const authDeadline = BigInt(Math.floor(h.clock.now / 1000) + 600);
    const seller = privateKeyToAccount(sellers[1]!);
    const sig = await seller.signTypedData(deliverTypedData(CHAIN_ID, ESCROW, id, RELAYER, authDeadline));
    const body = { terms: t, permit: null, authDeadline: authDeadline.toString(), signature: sig };

    const notLocked = await h.app.inject({ method: "POST", url: "/relay/deposit", headers: idem(), payload: body });
    assert.equal(notLocked.json().error.code, "TERMS_MISMATCH");

    h.chain.statuses.set(id, "payment_locked");
    const forged = await privateKeyToAccount(generatePrivateKey()).signTypedData(deliverTypedData(CHAIN_ID, ESCROW, id, RELAYER, authDeadline));
    const bad = await h.app.inject({ method: "POST", url: "/relay/deposit", headers: idem(), payload: { ...body, signature: forged } });
    assert.equal(bad.json().error.code, "SIG_INVALID");

    const cheap = await h.app.inject({
      method: "POST", url: "/relay/deposit", headers: idem(), payload: { ...body, terms: { ...t, relayerFee: "1" } },
    });
    assert.equal(cheap.json().error.code, "RELAY_FEE_TOO_LOW");

    const ok = await h.app.inject({ method: "POST", url: "/relay/deposit", headers: idem(), payload: body });
    assert.equal(ok.statusCode, 202, ok.body);
    assert.equal(h.relay.pending, 1);
    const status = await h.app.inject({ method: "GET", url: `/relay/requests/${ok.json().requestId}` });
    assert.equal(status.json().state, "queued");
  });
});

describe("realtime stream", () => {
  test("SSE replays history with sequence ids and resumes from Last-Event-ID", async () => {
    const address = await h.app.listen({ port: 0, host: "127.0.0.1" });
    const read = async (headers: Record<string, string>) => {
      const ac = new AbortController();
      const res = await fetch(`${address}/stream?channel=rfq:${rfqId}`, { headers, signal: ac.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      const reader = res.body!.getReader();
      let text = "";
      while (!text.includes("event: deal.settled")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      ac.abort();
      return text;
    };
    const all = await read(auth(manageToken));
    const ids = [...all.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids.slice(0, 2), [1, 2]);
    assert.ok(all.includes("event: answer.received"));
    assert.ok(all.includes("event: deal.accepted"));

    const resumed = await read({ ...auth(manageToken), "last-event-id": "2" });
    const firstId = Number(/^id: (\d+)$/m.exec(resumed)![1]);
    assert.equal(firstId, 3);

    const denied = await fetch(`${address}/stream?channel=rfq:${rfqId}`);
    assert.equal(denied.status, 401);
  });
});

describe("abuse controls", () => {
  test("per-IP rate limit on posting returns 429 with Retry-After", async () => {
    const limited = await createHarness({
      limits: {
        global: { limit: 1000, windowMs: 60_000 },
        createRfq: { limit: 2, windowMs: 60_000 },
        createQuote: { limit: 60, windowMs: 60_000 },
        relay: { limit: 30, windowMs: 60_000 },
      },
    });
    const payload = { side: "sell", token: TSLA, payToken: STABLE, amount: "1", encPubKey: toB64(buyerKeys.publicKey), replyWindow: "15m" };
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await limited.app.inject({ method: "POST", url: "/rfqs", headers: idem(), payload })).statusCode);
    }
    assert.deepEqual(codes, [201, 201, 429]);
    const last = await limited.app.inject({ method: "POST", url: "/rfqs", headers: idem(), payload });
    assert.ok(Number(last.headers["retry-after"]) > 0);
    limited.clock.now += 61_000;
    assert.equal((await limited.app.inject({ method: "POST", url: "/rfqs", headers: idem(), payload })).statusCode, 201);
    await limited.close();
  });

  test("cancel requires the manage token and only works once", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/rfqs", headers: idem(),
      payload: { side: "sell", token: TSLA, payToken: ZERO, amount: "5", encPubKey: toB64(buyerKeys.publicKey), replyWindow: "15m" },
    });
    const { rfq, manageToken: tok } = res.json();
    assert.equal((await h.app.inject({ method: "POST", url: `/rfqs/${rfq.id}/cancel` })).statusCode, 401);
    const ok = await h.app.inject({ method: "POST", url: `/rfqs/${rfq.id}/cancel`, headers: auth(tok) });
    assert.equal(ok.json().rfq.status, "cancelled");
    const again = await h.app.inject({ method: "POST", url: `/rfqs/${rfq.id}/cancel`, headers: auth(tok) });
    assert.equal(again.json().error.code, "RFQ_CLOSED");
  });

  test("an expired posting reads as expired and refuses answers", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/rfqs", headers: idem(),
      payload: { side: "buy", token: TSLA, payToken: ZERO, amount: "5", encPubKey: toB64(buyerKeys.publicKey), replyWindow: "15m" },
    });
    const id = res.json().rfq.id;
    h.clock.now += 16 * 60_000;
    assert.equal((await h.app.inject({ method: "GET", url: `/rfqs/${id}` })).json().rfq.status, "expired");
    const late = await h.app.inject({
      method: "POST", url: `/rfqs/${id}/quotes`, headers: idem(),
      payload: sealAnswer({ v: 1, rfqId: id, terms: termsFor(sellers[2]!, 5n, 1n, "9", { payToken: ZERO }) }, buyerKeys.publicKey),
    });
    assert.equal(late.json().error.code, "RFQ_EXPIRED");
  });
});
