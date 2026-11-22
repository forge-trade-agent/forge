import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.ts";

test("GET /health reports chain, contracts and dependency checks", async () => {
  const h = await createHarness();
  const res = await h.app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.chain.id, 4663);
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.ok(res.headers["x-request-id"]);

  h.ctx.checks.db = async () => false;
  const down = await h.app.inject({ method: "GET", url: "/health" });
  assert.equal(down.statusCode, 503);
  await h.close();
});

test("unknown routes return the shared error envelope with the request id", async () => {
  const h = await createHarness();
  const res = await h.app.inject({ method: "GET", url: "/nope?x=1", headers: { "x-request-id": "req_abcdefgh" } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, "NOT_FOUND");
  assert.equal(res.json().error.requestId, "req_abcdefgh");
  await h.close();
});

test("CORS only allows configured origins", async () => {
  const h = await createHarness();
  const ok = await h.app.inject({
    method: "OPTIONS",
    url: "/rfqs",
    headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
  });
  assert.equal(ok.headers["access-control-allow-origin"], "http://localhost:3000");
  const bad = await h.app.inject({
    method: "OPTIONS",
    url: "/rfqs",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  assert.equal(bad.headers["access-control-allow-origin"], undefined);
  await h.close();
});

test("GET /openapi.json documents every route with schemas", async () => {
  const h = await createHarness();
  const res = await h.app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(res.statusCode, 200);
  const doc = res.json();
  assert.equal(doc.openapi, "3.1.0");
  for (const p of ["/rfqs", "/rfqs/{id}/accept", "/relay/deposit", "/receipts/{tx}", "/stream"]) assert.ok(doc.paths[p], p);
  assert.ok(doc.components.schemas.Terms.properties.salt);
  await h.close();
});
