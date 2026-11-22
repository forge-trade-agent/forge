import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { SealedAnswerPlaintext, Terms } from "@sealdesk/shared";
import {
  answerTypedData,
  buildPrivateLink,
  checkAnswer,
  completeTerms,
  dealIdOf,
  decryptBackup,
  deliverTypedData,
  encryptBackup,
  fromB64,
  generateKeyPair,
  open,
  openAnswer,
  parsePrivateLink,
  recoverDeliverSigner,
  seal,
  sealAnswer,
  sortAnswers,
  toB64,
  type PostingView,
} from "../src/index.ts";

// Same constants as contracts/test/CrossLanguage.t.sol.
const VECTOR_TERMS: Terms = {
  buyer: "0x0000000000000000000000000000000000000b0b",
  seller: "0x0000000000000000000000000000000000005e11",
  token: "0x000000000000000000000000000000000007e51a",
  amount: "2500000000000000000000",
  payToken: "0x0000000000000000000000000000000000000005",
  price: "950275000000",
  sellerPayout: "0x0000000000000000000000000000000000005e12",
  referrer: "0x0000000000000000000000000000000000000000",
  relayerFee: "3000000",
  deadline: 1_800_000_000,
  salt: `0x${"ab".repeat(32)}`,
};

test("deal id and Deliver digest match the Solidity contract", () => {
  const id = dealIdOf(VECTOR_TERMS);
  assert.equal(id, "0xc0adde520df2bb94353dc453df96e31349b928bd5b33388ab92686a93621a113");
  const digest = hashTypedData(
    deliverTypedData(4663, "0x00000000000000000000000000000000000e5c0e", id, "0x0000000000000000000000000000000000000e1a", 1_800_000_600n),
  );
  assert.equal(digest, "0x77790f54f63344fe40dedb716f58c8a6f38f7270a40b188079db33d74cf7b1f4");
});

test("seal/open round trip; wrong key, tampered ciphertext and tampered nonce fail closed", () => {
  const alice = generateKeyPair();
  const mallory = generateKeyPair();
  const msg = new TextEncoder().encode("price=380.11");
  const box = seal(msg, alice.publicKey);
  assert.deepEqual(open(box, alice.secretKey), msg);
  assert.equal(open(box, mallory.secretKey), null);

  const ct = box.ciphertext.slice();
  ct[ct.length - 1]! ^= 1;
  assert.equal(open({ ...box, ciphertext: ct }, alice.secretKey), null);

  const nonce = box.nonce.slice();
  nonce[0]! ^= 1;
  assert.equal(open({ ...box, nonce }, alice.secretKey), null);
});

test("every seal uses a fresh ephemeral key and nonce", () => {
  const k = generateKeyPair();
  const a = seal(new Uint8Array([1]), k.publicKey);
  const b = seal(new Uint8Array([1]), k.publicKey);
  assert.notDeepEqual(a.senderEncPubKey, b.senderEncPubKey);
  assert.notDeepEqual(a.nonce, b.nonce);
});

test("the server only sees ciphertext: no plaintext fragment survives in the wire body", () => {
  const k = generateKeyPair();
  const answer: SealedAnswerPlaintext = { v: 1, rfqId: "RFQ1", terms: VECTOR_TERMS };
  const wire = sealAnswer(answer, k.publicKey);
  const raw = Buffer.from(fromB64(wire.ciphertext)).toString("latin1");
  assert.ok(!raw.includes("950275000000"));
  assert.ok(!raw.includes("RFQ1"));
});

test("openAnswer treats decrypted content as hostile", () => {
  const k = generateKeyPair();
  const ok = openAnswer(sealAnswer({ v: 1, rfqId: "R", terms: VECTOR_TERMS }, k.publicKey), k.secretKey);
  assert.ok(ok.ok);

  const garbage = seal(new TextEncoder().encode("{not json"), k.publicKey);
  const g = openAnswer(
    { senderEncPubKey: toB64(garbage.senderEncPubKey), nonce: toB64(garbage.nonce), ciphertext: toB64(garbage.ciphertext) },
    k.secretKey,
  );
  assert.deepEqual(g, { ok: false, reason: "not_json" });

  const evil = seal(new TextEncoder().encode(JSON.stringify({ v: 1, rfqId: "R", terms: { ...VECTOR_TERMS, price: "-1" } })), k.publicKey);
  const e = openAnswer(
    { senderEncPubKey: toB64(evil.senderEncPubKey), nonce: toB64(evil.nonce), ciphertext: toB64(evil.ciphertext) },
    k.secretKey,
  );
  assert.equal(e.ok, false);
  assert.equal(!e.ok && e.reason, "invalid_shape");
});

test("private links keep secrets in the fragment and round-trip", () => {
  const k = generateKeyPair();
  const link = buildPrivateLink("https://desk.example/", "rfq", "01ABC", k.secretKey, "sd_x");
  const url = new URL(link);
  assert.equal(url.pathname, "/rfq/01ABC");
  assert.equal(url.search, "");
  const parsed = parsePrivateLink(link);
  assert.deepEqual(parsed.secretKey, k.secretKey);
  assert.equal(parsed.token, "sd_x");
});

async function signedAnswer(pk: Hex, rfqId: string, terms: Terms): Promise<SealedAnswerPlaintext> {
  const account = privateKeyToAccount(pk);
  const signature = await account.signTypedData(answerTypedData(4663, "0x00000000000000000000000000000000000e5c0e", rfqId, terms));
  return { v: 1, rfqId, terms, signature };
}

const ESCROW = "0x00000000000000000000000000000000000e5c0e" as const;

test("checkAnswer: signed by the seller on a bid ranks first; forged and mismatched answers rank last", async () => {
  const sellerPk = generatePrivateKey();
  const seller = privateKeyToAccount(sellerPk).address.toLowerCase() as `0x${string}`;
  const posting: PostingView = {
    id: "RFQ1",
    side: "buy",
    token: VECTOR_TERMS.token,
    payToken: VECTOR_TERMS.payToken,
    amount: VECTOR_TERMS.amount,
    filledAmount: "0",
    allowPartial: false,
  };
  const now = 1_799_990_000_000;
  const terms = { ...VECTOR_TERMS, seller, buyer: "0x0000000000000000000000000000000000000000" as const };
  const balances = { balanceOf: async () => 10n ** 30n };

  const good = await checkAnswer(posting, await signedAnswer(sellerPk, "RFQ1", terms), { chainId: 4663, escrow: ESCROW, now, balances });
  assert.equal(good.verdict, "signed");
  assert.equal(good.funded, true);
  assert.equal(good.rank, 0);

  const forged = await checkAnswer(posting, await signedAnswer(generatePrivateKey(), "RFQ1", terms), { chainId: 4663, escrow: ESCROW, now });
  assert.equal(forged.verdict, "unverified");
  assert.equal(forged.rank, 3);

  const unsigned = await checkAnswer(posting, { v: 1, rfqId: "RFQ1", terms }, { chainId: 4663, escrow: ESCROW, now });
  assert.equal(unsigned.rank, 2);

  const wrongToken = await checkAnswer(
    posting,
    await signedAnswer(sellerPk, "RFQ1", { ...terms, token: "0x0000000000000000000000000000000000000bad" }),
    { chainId: 4663, escrow: ESCROW, now },
  );
  assert.equal(wrongToken.rank, 3);
  assert.ok(wrongToken.problems.includes("token does not match the posting"));

  const empty = await checkAnswer(posting, await signedAnswer(sellerPk, "RFQ1", terms), {
    chainId: 4663, escrow: ESCROW, now, balances: { balanceOf: async () => 0n },
  });
  assert.equal(empty.funded, false);
  assert.equal(empty.rank, 2);

  const prefilled = await checkAnswer(posting, await signedAnswer(sellerPk, "RFQ1", { ...terms, buyer: VECTOR_TERMS.buyer }), {
    chainId: 4663, escrow: ESCROW, now,
  });
  assert.equal(prefilled.rank, 3);
  assert.match(prefilled.problems.join(), /pre-fills the poster's side \(buyer\)/);

  const done = completeTerms("buy", terms, { wallet: VECTOR_TERMS.buyer, referrer: "0x00000000000000000000000000000000000004eF" });
  assert.equal(done.buyer, VECTOR_TERMS.buyer);
  assert.equal(done.referrer, "0x00000000000000000000000000000000000004ef");
  assert.equal(done.seller, seller);

  const sorted = sortAnswers("buy", [unsigned, forged, good, empty]);
  assert.equal(sorted[0], good);
  assert.equal(sorted.at(-1), forged);
});

test("recoverDeliverSigner returns the one-time wallet", async () => {
  const pk = generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  const id = dealIdOf(VECTOR_TERMS);
  const sig = await acct.signTypedData(deliverTypedData(4663, ESCROW, id, "0x0000000000000000000000000000000000000e1a", 99n));
  const who = await recoverDeliverSigner(4663, ESCROW, id, "0x0000000000000000000000000000000000000e1a", 99n, sig);
  assert.equal(who, acct.address);
  const other = await recoverDeliverSigner(4663, ESCROW, id, "0x0000000000000000000000000000000000000e1b", 99n, sig);
  assert.notEqual(other, acct.address);
});

test("backup round trip; wrong passphrase fails", async () => {
  const entries = [{ kind: "rfq" as const, id: "RFQ1", link: "https://desk.example/rfq/RFQ1#k=abc&t=sd_x", createdAt: new Date().toISOString() }];
  const kdf = { t: 1, m: 256, p: 1 }; // small for test speed; production uses DEFAULT_KDF
  const file = await encryptBackup(entries, "correct horse battery staple", kdf);
  assert.ok(!JSON.stringify(file).includes("sd_x"));
  assert.deepEqual(await decryptBackup(file, "correct horse battery staple"), entries);
  await assert.rejects(decryptBackup(file, "wrong passphrase!!"), /wrong passphrase/);
  await assert.rejects(encryptBackup(entries, "short"), /at least 12/);
});
