"use client";
import { BRAND } from "@/lib/config";
import type { Pay } from "./NewBlock";
import { Segmented } from "./ui";

/** ETH, USD or the desk's own token. Paying in the token has its own flat, burned fee. */
export function PayPicker({ value, onChange, label = "Pay with", token }: { value: Pay; onChange: (p: Pay) => void; label?: string; token?: string | null }) {
  // A block can't be paid in the token it trades.
  const options: { value: Pay; label: string }[] = [
    { value: "ETH", label: "ETH" },
    { value: "USD", label: "USD" },
    ...(token && token.toUpperCase() === BRAND.token ? [] : [{ value: "TOKEN" as const, label: BRAND.token }]),
  ];
  return <Segmented value={value} onChange={onChange} label={label} options={options} />;
}

/** One line under the picker when the token is chosen. */
export function PayNote({ pay }: { pay: Pay }) {
  if (pay !== "TOKEN") return null;
  return <span className="hint" style={{ margin: 0 }}>Paying in ${BRAND.token}: a flat 1.5% fee at any size, and the desk&apos;s share is burned in the settlement transaction. The holder discount doesn&apos;t stack.</span>;
}
