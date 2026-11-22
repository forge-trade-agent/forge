"use client";
/**
 * Pre-launch gate (NEXT_PUBLIC_PRELAUNCH=1): the site is public before the contracts are deployed.
 * Reading pages (landing, markets, docs, admin) work as usual; pages that would sign or send a
 * transaction show a "soon" card instead, so nobody can try to trade against a contract that does not exist.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BRAND, PRELAUNCH } from "@/lib/config";

const TRADING = ["/otc", "/trade", "/rfq", "/mine", "/quote", "/receipt", "/notifications", "/exposure", "/refer"];

export function PrelaunchGate({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  if (!PRELAUNCH || !TRADING.some((p) => path === p || path.startsWith(`${p}/`))) return <>{children}</>;
  return (
    <div className="wrap page">
      <div className="page-head">
        <div className="eyebrow">Coming soon</div>
        <h1 className="display">
          Trading opens<span className="second">when ${BRAND.token} launches.</span>
        </h1>
        <p>
          The desk goes live together with the contracts. Until then you can browse every market with live pool prices and read how a
          sealed block trade works.
        </p>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
        <Link className="btn btn-buy btn-lg" href="/markets">Browse markets</Link>
        <Link className="btn btn-lg" href="/how">How it works</Link>
      </div>
    </div>
  );
}
