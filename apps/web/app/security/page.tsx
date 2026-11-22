import type { Metadata } from "next";
import { ContentPage } from "@/components/Content";
import { ControlPanel } from "@/components/ControlPanel";

export const metadata: Metadata = { title: "Security" };

export default function SecurityPage() {
  return (
    <ContentPage
      eyebrow="Security"
      title="Nobody can take your funds. Nobody can read your price."
      intro="What the contracts guarantee, what the cryptography guarantees, and what we are upfront about."
      lead={<ControlPanel />}
      sections={[
        { id: "contract", title: "What the contract guarantees", body: <ul><li>No owner, no admin key, no pause, no upgrade.</li><li>Funds move only to settle a deal or refund it after the deadline.</li><li>The deal id is the hash of its terms: terms can&apos;t be changed after the fact.</li><li>Fees are capped at 2.5% in the code. Payouts a receiver refuses are held for them to claim, so nobody can block the other side.</li></ul> },
        { id: "sealed", title: "Sealed means sealed", body: <><p>Answers are encrypted in the sender&apos;s browser (X25519 + XSalsa20-Poly1305) to a key that exists only in the private link&apos;s URL fragment. Browsers never send the fragment to servers, and every page sets <code>Referrer-Policy: no-referrer</code>.</p><p>Each answer is signed by its wallet (EIP-712). Tampered or forged answers are flagged and ranked last, and accepting one needs an explicit confirmation.</p></> },
        { id: "server", title: "If our server were compromised", body: <p>An attacker would see which blocks exist, their token, side and size, and encrypted blobs. They could not read prices, move funds or change terms. The settlement contract does not trust the server for anything.</p> },
        { id: "upfront", title: "What we're upfront about", body: <ul><li>Private, not anonymous: once a side deposits, the deal is public on-chain like any transaction.</li><li>The contracts have an internal review and an extensive test suite. An independent third-party audit is required before large sizes.</li><li>Ghost mode only helps if the one-time wallet is funded through a path that isn&apos;t linked to you.</li></ul> },
      ]}
    />
  );
}
