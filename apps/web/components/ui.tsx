"use client";
import { ForgeMark } from "./BrandMark";
import { useEffect, useState, type ReactNode } from "react";
import { BRAND, explorerAddr } from "@/lib/config";
import { LOGOS } from "@/lib/logos";
import { short } from "@/lib/format";

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
      aria-label={label}
    >
      {done ? "ok" : "⧉"}
    </button>
  );
}

export function AddressPill({ address, n = 4, copy = true }: { address: string; n?: number; copy?: boolean }) {
  const href = explorerAddr(address);
  return (
    <span className="addr">
      {href ? (
        <a className="link" href={href} target="_blank" rel="noreferrer noopener">
          {short(address, n)} ↗
        </a>
      ) : (
        <span>{short(address, n)}</span>
      )}
      {copy && <Copy text={address} label="Copy address" />}
    </span>
  );
}

export function Sealed({ label = "PRICE" }: { label?: string }) {
  return (
    <span className="chip">
      {label} <span className="sealed">••••••</span>
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  tone,
  block,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  tone?: "sell";
  block?: boolean;
  label?: string;
}) {
  return (
    <div className={`seg${tone === "sell" ? " sell" : ""}${block ? " block" : ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Countdown({ from, to, now }: { from: number; to: number; now: number }) {
  const pct = Math.max(0, Math.min(100, ((to - now) / Math.max(1, to - from)) * 100));
  return (
    <div className="cbar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

const PALETTE = ["#3ddc97", "#8fd3ff", "#ff6b81", "#f0c48e", "#8b97ff", "#c7a0ff"];

/** Relative luminance of a #rrggbb colour, to pick a readable glyph colour. */
function lum(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function TokenAvatar({ symbol, size, logoUrl }: { symbol: string; size?: "sm" | "lg"; logoUrl?: string | null }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const cls = `avatar logo${size ? ` ${size}` : ""}`;
  if (symbol === BRAND.token) {
    // The desk's own token: the Forge mark.
    return (
      <span className={cls} style={{ background: "#0b0f00", borderColor: "var(--lime)" }} aria-hidden>
        <ForgeMark size="64%" />
      </span>
    );
  }
  const icon = LOGOS[symbol];
  if (icon) {
    const light = lum(icon.hex) > 0.6;
    const dark = lum(icon.hex) < 0.02;
    return (
      <span className={cls} style={{ background: `#${icon.hex}`, borderColor: dark ? "rgba(255,255,255,0.18)" : `#${icon.hex}` }} title={icon.title} aria-hidden>
        <svg viewBox="0 0 24 24" width="56%" height="56%"><path d={icon.path} fill={light ? "#0b0b0b" : "#ffffff"} /></svg>
      </span>
    );
  }
  // The issuer's own logo (Robinhood's CDN), when there is no brand icon here.
  if (logoUrl && !logoFailed && logoUrl.startsWith("https://cdn.robinhood.com/")) {
    return (
      <span className={cls} style={{ background: "#141414", borderColor: "rgba(255,255,255,0.12)" }} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl} alt="" width="100%" height="100%" loading="lazy" decoding="async" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} onError={() => setLogoFailed(true)} />
      </span>
    );
  }
  // No logo available: a round lettered badge in the same shape, text sized to fit the symbol.
  const c = PALETTE[[...symbol].reduce((a, ch) => a + ch.charCodeAt(0), 0) % PALETTE.length];
  const text = symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 4);
  return (
    <span className={cls} style={{ background: "#141414", borderColor: `${c}66`, color: c }} aria-hidden>
      <svg viewBox="0 0 40 40" width="100%" height="100%">
        <text x="20" y="21" textAnchor="middle" dominantBaseline="middle" fill="currentColor" fontWeight="700" fontSize={text.length <= 2 ? 15 : text.length === 3 ? 12 : 9.5} fontFamily="var(--font-sans), sans-serif">{text}</text>
      </svg>
    </span>
  );
}

export function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Panel"}>
        <div className="drawer-head">
          <strong style={{ fontSize: 18 }}>{title}</strong>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  );
}

export function Modal({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </>
  );
}

export function Sparkline({ points, width = 80, height = 24 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * width},${height - ((p - min) / span) * (height - 2) - 1}`).join(" ");
  const up = points.at(-1)! >= points[0]!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline points={d} fill="none" stroke={up ? "var(--buy)" : "var(--sell)"} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function Skeleton({ h = 16, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skel" style={{ height: h, width: w }} />;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as { message?: string; code?: string };
  return <div className="errbox" role="alert">{e.code ? `${e.code}: ` : ""}{e.message ?? String(error)}</div>;
}
