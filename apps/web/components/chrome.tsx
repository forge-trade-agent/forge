"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { API_URL, BRAND, CHAIN_NAME, DEV_BURNER } from "@/lib/config";
import { api } from "@/lib/desk";
import { useAsync } from "@/lib/hooks";
import { referral } from "@/lib/keys";
import { short } from "@/lib/format";
import { HEADER, SITEMAP, type SiteGroup } from "@/lib/sitemap";
import { useWallet } from "@/lib/wallet";
import { prefersReduced, useScrub } from "./motion";
import { SoundChip } from "./sound";
import { AddressPill, Copy } from "./ui";
import { shortCa, useSiteCa } from "./SiteCa";
import { ForgeMark } from "./BrandMark";

const isHere = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** A header menu: opens on hover, focus or click, closes on Escape or a click outside. */
function NavGroup({ group, n, path }: { group: SiteGroup; n: number; path: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hover = useRef(false);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const here = group.links.some((l) => isHere(path, l.href));
  return (
    <div
      ref={ref}
      className="navgroup"
      onPointerEnter={(e) => { if (e.pointerType === "mouse") { hover.current = true; setOpen(true); } }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") { hover.current = false; setOpen(false); } }}
    >
      {/* With a mouse the menu is already open on hover, so a click keeps it open; touch and keyboard toggle. */}
      <button type="button" className="navbtn" aria-expanded={open} aria-current={here ? "page" : undefined} onClick={() => setOpen((o) => (hover.current ? true : !o))}>
        <span className="n" aria-hidden>+ {String(n).padStart(2, "0")}</span>
        <span>{group.label} <span className="caret-down" aria-hidden>▾</span></span>
      </button>
      {open && (
        <div className="navdrop" role="menu">
          {group.links.map((l) => (
            <Link key={l.href} href={l.href} role="menuitem" aria-current={isHere(path, l.href) ? "page" : undefined}>
              <strong>{l.label}</strong>
              <span>{l.desc}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function useHealth() {
  return useAsync(() => api.health(), []);
}

export function AnnouncementBar() {
  const { ca, loading } = useSiteCa();
  return (
    <div className="announce">
      <div className="wrap">
        <span style={{ color: "var(--accent)" }}>${BRAND.token}</span>
        <span className="dim">CA</span>
        {ca ? (
          <>
            <span className="num ca-full">{ca.address}</span>
            <span className="num ca-short">{shortCa(ca.address, 4)}</span>
            <Copy text={ca.address} label="Copy token address" />
            {ca.link && <a href={ca.link} target="_blank" rel="noreferrer noopener" className="link hide-sm">Chart ↗</a>}
          </>
        ) : (
          <span className="dim">{loading ? "…" : "Coming soon"}</span>
        )}
        <Link href="/stats" className="link">
          Burn tracker →
        </Link>
      </div>
    </div>
  );
}

export function ConnectButton({ compact }: { compact?: boolean }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  if (w.address) {
    return (
      <div style={{ position: "relative" }}>
        <button className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="dot" /> {short(w.address)}
        </button>
        {open && (
          <div className="panel" style={{ position: "absolute", right: 0, top: 46, padding: 12, width: 260, zIndex: 50 }}>
            <div className="stack" style={{ ["--g" as string]: "10px" }}>
              <div className="label">{w.kind === "burner" ? "Dev burner wallet" : "Browser wallet"}</div>
              <AddressPill address={w.address} n={6} />
              {DEV_BURNER && (
                <button className="btn btn-sm" onClick={() => void w.fund()}>
                  Fund from dev faucet
                </button>
              )}
              <button className="btn btn-sm btn-ghost" onClick={() => { w.disconnect(); setOpen(false); }}>
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="row" style={{ ["--g" as string]: "6px" }}>
      {DEV_BURNER && (!w.hasInjected || !compact) && (
        <button className="btn" onClick={() => void w.connect("burner")} disabled={w.connecting} title="Local dev stack only">
          Dev wallet
        </button>
      )}
      {w.hasInjected && (
        <button className="btn" onClick={() => void w.connect("injected")} disabled={w.connecting}>
          {w.connecting ? "Connecting…" : "Connect"}
        </button>
      )}
      {!w.hasInjected && !DEV_BURNER && (
        <button className="btn" onClick={() => void w.connect("injected")}>
          Connect
        </button>
      )}
    </div>
  );
}

export function Header() {
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const { data, error } = useHealth();
  useEffect(() => setMenu(false), [path]);
  useEffect(() => referral.capture(window.location.search), [path]);
  const marketing = path === "/" || ["/how", "/security", "/docs", "/roadmap", "/developers"].includes(path);
  return (
    <>
      <header className="header">
        <div className="wrap">
          <Link href="/" className="logo" aria-label={`${BRAND.name} home`}>
            <span className="logo-mark">
              <ForgeMark size={30} />
            </span>
            {BRAND.name}
          </Link>
          <nav className="nav" aria-label="Main">
            {HEADER.map((item, i) =>
              "group" in item ? (
                <NavGroup key={item.group.key} group={item.group} n={i + 1} path={path} />
              ) : (
                <Link key={item.link.href} href={item.link.href} aria-current={isHere(path, item.link.href) ? "page" : undefined}>
                  <span className="n" aria-hidden>+ {String(i + 1).padStart(2, "0")}</span>
                  {item.link.label}
                </Link>
              ),
            )}
          </nav>
          <div className="row hide-sm">
            <a className="iconbtn" href={BRAND.github} target="_blank" rel="noreferrer noopener" aria-label="Source code">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 0a8 8 0 00-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.34.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82a7.6 7.6 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 008 0z"/></svg>
            </a>
            <span className="netpill" title={error ? "API unreachable" : "Connected to the desk"}>
              <span className={`dot${error ? " off" : ""}`} /> {data?.chain.name ?? CHAIN_NAME}
            </span>
          </div>
          {marketing ? (
            <Link href="/app" className="btn btn-buy hide-sm">
              Launch app
            </Link>
          ) : (
            <span className="hide-sm">
              <ConnectButton compact />
            </span>
          )}
          <button className="iconbtn burger" onClick={() => setMenu((m) => !m)} aria-label="Menu" aria-expanded={menu}>
            <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
              <rect y="0" width="16" height="2" fill="currentColor" />
              <rect y="5" width="16" height="2" fill="currentColor" />
              <rect y="10" width="10" height="2" fill="var(--lime)" />
            </svg>
          </button>
        </div>
      </header>
      {menu && (
        <nav className="mobile-nav" aria-label="Mobile">
          {SITEMAP.map((g) => (
            <div key={g.key} className="mobile-group">
              <span className="label">{g.label}</span>
              {g.links.map((l) => (
                <Link key={l.href} href={l.href}>{l.label}</Link>
              ))}
            </div>
          ))}
          <div style={{ marginTop: 16 }}>
            <ConnectButton />
          </div>
        </nav>
      )}
    </>
  );
}

function FooterWord() {
  const ref = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useScrub(ref, { scale: 1, y: 0 }, { trigger: wrap, start: "top bottom", end: "bottom bottom" });
  useEffect(() => {
    if (ref.current && !prefersReduced()) ref.current.style.transform = "scale(0.82) translateY(30px)";
  }, []);
  return (
    <div ref={wrap} style={{ overflow: "hidden" }}>
      <div ref={ref} className="footer-word silver" aria-hidden>
        {BRAND.name}
      </div>
    </div>
  );
}

export function Footer() {
  const { data } = useHealth();
  const { ca } = useSiteCa();
  return (
    <footer className="footer">
      <FooterWord />
      <div className="wrap row between" style={{ marginBottom: 28, flexWrap: "wrap" }}>
        <span className="muted" style={{ maxWidth: 520 }}>Sealed-bid block trades for Robinhood Chain stock tokens. No price shown, no counterparty risk. Every fee burns $FORGE.</span>
        <SoundChip />
      </div>
      <nav className="wrap footer-cols" aria-label="Footer">
        {SITEMAP.map((g) => (
          <div key={g.key}>
            <span className="label">{g.label}</span>
            {g.links.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
          </div>
        ))}
        <div>
          <span className="label">Build</span>
          <Link href="/developers#mcp">MCP server</Link>
          <a href={`${API_URL}/sdk/forge.mjs`}>SDK</a>
          <a href={`${API_URL}/openapi.json`}>OpenAPI</a>
          <a href={BRAND.github} target="_blank" rel="noreferrer noopener">Source code</a>
        </div>
      </nav>
      <div className="wrap grid">
        <div className="stack" style={{ ["--g" as string]: "6px" }}>
          <div className="label">${BRAND.token} token{ca?.network ? ` (${ca.network})` : ""}</div>
          {ca ? <span className="addr num">{shortCa(ca.address, 8)} <Copy text={ca.address} label="Copy token address" /></span> : <span className="dim">CA coming soon</span>}
        </div>
        <div className="stack" style={{ ["--g" as string]: "6px" }}>
          <div className="label">Settlement contract (OtcEscrow)</div>
          {data && <AddressPill address={data.contracts.escrow} n={8} />}
        </div>
        <div className="stack" style={{ ["--g" as string]: "6px" }}>
          <div className="label">Fee vault</div>
          {data && <AddressPill address={data.contracts.feeVault} n={8} />}
        </div>
        <div className="row" style={{ flexWrap: "wrap", ["--g" as string]: "14px" }}>
          <Link href="/security" className="link">Security</Link>
          <Link href="/developers" className="link">Developers</Link>
          <a href={BRAND.github} className="link" target="_blank" rel="noreferrer noopener">Source</a>
          <a href={BRAND.x} className="link" target="_blank" rel="noreferrer noopener">X</a>
        </div>
      </div>
    </footer>
  );
}
