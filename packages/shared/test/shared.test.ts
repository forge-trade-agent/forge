import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AcceptBody,
  base32,
  hashToken,
  loadEnv,
  newCapabilityToken,
  newId,
  RfqCreate,
  tokenMatches,
  Uint256,
} from "../src/index.ts";

test("ids are 26-char Crockford base32", () => {
  const id = newId();
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(base32(new Uint8Array([0xff])), "ZW");
});

test("capability tokens verify only against their own hash", () => {
  const { token, hash } = newCapabilityToken();
  assert.match(token, /^sd_[A-Za-z0-9_-]{43}$/);
  assert.ok(tokenMatches(token, hash));
  assert.ok(!tokenMatches(newCapabilityToken().token, hash));
  assert.ok(!tokenMatches("garbage", hash));
  assert.equal(hashToken(token).length, 32);
});

test("uint256 strings are bounded", () => {
  assert.ok(Uint256.safeParse("0").success);
  assert.ok(Uint256.safeParse((2n ** 256n - 1n).toString()).success);
  assert.ok(!Uint256.safeParse((2n ** 256n).toString()).success);
  assert.ok(!Uint256.safeParse("01").success);
  assert.ok(!Uint256.safeParse("-1").success);
  assert.ok(!Uint256.safeParse("1e18").success);
});

test("RfqCreate normalises addresses and checks key length", () => {
  const ok = RfqCreate.parse({
    side: "buy",
    token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    payToken: "0x0000000000000000000000000000000000000000",
    amount: "2500000000000000000000",
    encPubKey: Buffer.alloc(32, 7).toString("base64"),
    replyWindow: "1h",
  });
  assert.equal(ok.token, "0x322f0929c4625ed5bad873c95208d54e1c003b2d");
  assert.equal(ok.allowPartial, false);
  const bad = RfqCreate.safeParse({ ...ok, encPubKey: Buffer.alloc(31).toString("base64") });
  assert.ok(!bad.success);
});

test("AcceptBody rejects malformed salt", () => {
  const terms = {
    buyer: "0x" + "1".repeat(40),
    seller: "0x" + "2".repeat(40),
    token: "0x" + "3".repeat(40),
    amount: "1",
    payToken: "0x" + "0".repeat(40),
    price: "1000",
    sellerPayout: "0x" + "2".repeat(40),
    referrer: "0x" + "0".repeat(40),
    relayerFee: "0",
    deadline: 1_800_000_000,
    salt: "0x" + "ab".repeat(32),
  };
  assert.ok(AcceptBody.safeParse({ quoteId: "Q1", terms }).success);
  assert.ok(!AcceptBody.safeParse({ quoteId: "Q1", terms: { ...terms, salt: "0x12" } }).success);
});

test("loadEnv lists every problem and never echoes secrets", () => {
  assert.throws(
    () => loadEnv("relayer", { DATABASE_URL: "nope", RELAYER_PRIVATE_KEY: "0xdeadbeef" }),
    (err: Error) => {
      assert.match(err.message, /DATABASE_URL/);
      assert.match(err.message, /RELAYER_PRIVATE_KEY/);
      assert.doesNotMatch(err.message, /deadbeef/);
      return true;
    },
  );
});

test("loadEnv parses a complete api env", () => {
  const env = loadEnv("api", {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    CHAIN_ID: "4663",
    RPC_URLS: "https://a.example, https://b.example",
    ESCROW_ADDRESS: "0x41C1dcd0bf252C86C4b0cb78dec42830DD1d0865",
    VAULT_ADDRESS: "0x" + "2".repeat(40),
    STABLE_ADDRESS: "0x" + "3".repeat(40),
    PLATFORM_TOKEN_ADDRESS: "0x" + "4".repeat(40),
    API_PUBLIC_URL: "http://localhost:8080",
    CORS_ORIGINS: "http://localhost:3000",
    NOTIFY_ENCRYPTION_KEY: "a".repeat(64),
  });
  assert.equal(env.CHAIN_ID, 4663);
  assert.deepEqual(env.RPC_URLS, ["https://a.example", "https://b.example"]);
  assert.equal(env.ESCROW_ADDRESS, "0x41c1dcd0bf252c86c4b0cb78dec42830dd1d0865");
  assert.equal(env.API_PORT, 8080);
  assert.equal(env.ESCROW_DEPLOY_BLOCK, 0n);
});
