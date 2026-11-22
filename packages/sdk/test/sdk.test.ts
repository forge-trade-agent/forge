import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrame, ForgeApi, ForgeError } from "../src/index.ts";

test("parseFrame reads id/event/data and ignores comments and malformed frames", () => {
  assert.deepEqual(parseFrame(`id: 7\nevent: deal.settled\ndata: {"dealId":"0xab"}`), { seq: 7, type: "deal.settled", data: { dealId: "0xab" } });
  assert.equal(parseFrame(": ping 123"), null);
  assert.equal(parseFrame("id: x\ndata: {}"), null);
  assert.equal(parseFrame("id: 1\ndata: {not json"), null);
});

test("retries a 5xx create with the SAME idempotency key, then succeeds", async () => {
  const keys: string[] = [];
  let n = 0;
  const fake = (async (_url: string, init: RequestInit) => {
    keys.push((init.headers as Record<string, string>)["idempotency-key"]!);
    n++;
    if (n === 1) return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }), { status: 503 });
    return new Response(JSON.stringify({ quoteId: "Q", quoteToken: "sd_x" }), { status: 201 });
  }) as unknown as typeof fetch;
  const api = new ForgeApi({ baseUrl: "http://desk.test", fetch: fake, retries: 3 });
  const r = await api.sendQuote("R", { senderEncPubKey: "a", nonce: "b", ciphertext: "c" });
  assert.equal(r.quoteId, "Q");
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "a retried create must reuse its key so it can never run twice");
});

test("4xx errors surface the server's code, request id and problems without retrying", async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ error: { code: "TERMS_MISMATCH", message: "Size must equal the posting", requestId: "req_1", problems: [{ path: "terms.amount", message: "x" }] } }),
      { status: 422 },
    );
  }) as unknown as typeof fetch;
  const api = new ForgeApi({ baseUrl: "http://desk.test", fetch: fake });
  await assert.rejects(api.getRfq("R"), (e: unknown) => {
    assert.ok(e instanceof ForgeError);
    assert.equal(e.code, "TERMS_MISMATCH");
    assert.equal(e.status, 422);
    assert.equal(e.requestId, "req_1");
    assert.equal(e.problems?.[0]?.path, "terms.amount");
    return true;
  });
  assert.equal(calls, 1);
});

test("POSTs without an idempotency key are never retried", async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response("{}", { status: 503 });
  }) as unknown as typeof fetch;
  const api = new ForgeApi({ baseUrl: "http://desk.test", fetch: fake, retries: 3 });
  await assert.rejects(api.reportSettled("R", `0x${"1".repeat(64)}`));
  assert.equal(calls, 1);
});
