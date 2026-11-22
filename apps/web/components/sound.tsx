"use client";
/**
 * Optional interface sound: a short synthesized tick on press and a softer one on hover of
 * buttons and links. Off by default (browsers block audio before a gesture anyway); the choice
 * is remembered in this browser. No audio files are loaded.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface SoundCtx {
  on: boolean;
  toggle(): void;
  tick(kind?: "press" | "hover"): void;
}
const Ctx = createContext<SoundCtx>({ on: false, toggle() {}, tick() {} });
const KEY = "sealdesk.sound.v1";

export function SoundProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(false);
  const ac = useRef<AudioContext | null>(null);
  const last = useRef(0);

  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(KEY) === "1");
    } catch {
      /* storage blocked */
    }
  }, []);

  const tick = useCallback(
    (kind: "press" | "hover" = "press") => {
      if (!on) return;
      const now = performance.now();
      if (kind === "hover" && now - last.current < 70) return;
      last.current = now;
      try {
        ac.current ??= new AudioContext();
        const ctx = ac.current;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = kind === "press" ? "square" : "sine";
        o.frequency.setValueAtTime(kind === "press" ? 1900 : 2600, ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(kind === "press" ? 700 : 1800, ctx.currentTime + 0.05);
        g.gain.setValueAtTime(kind === "press" ? 0.045 : 0.015, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.07);
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.08);
      } catch {
        /* audio unavailable */
      }
    },
    [on],
  );

  const toggle = useCallback(() => {
    setOn((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(KEY, next ? "1" : "0");
      } catch {
        /* storage blocked */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!on) return;
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest?.("button, a, [role=button]")) tick("press");
    };
    const over = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest?.(".btn, .nav > a, .navbtn, .tk, .hx-pill")) tick("hover");
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerover", over);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerover", over);
    };
  }, [on, tick]);

  return <Ctx.Provider value={{ on, toggle, tick }}>{children}</Ctx.Provider>;
}

export const useSound = () => useContext(Ctx);

export function SoundChip() {
  const { on, toggle } = useSound();
  return (
    <button type="button" className="soundchip" aria-pressed={on} onClick={toggle} aria-label={`Interface sound ${on ? "on" : "off"}`}>
      <span className="xh" style={{ top: -6, left: -6 }} />
      <span className="xh" style={{ bottom: -6, right: -6 }} />
      <span className="bars" aria-hidden>
        <i /> <i /> <i />
      </span>
      Sound: {on ? "on" : "off"}
    </button>
  );
}
