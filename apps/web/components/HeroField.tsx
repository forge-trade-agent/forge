"use client";
/**
 * Hero background: a quiet dot field. A soft spotlight follows the pointer (or drifts on its own),
 * and every few seconds a "sealed bid" lands somewhere and sends a ripple through the dots.
 * One 2D canvas, a few thousand dots at most, paused when off screen or in a background tab.
 * Reduced motion: one still frame.
 */
import { useEffect, useRef } from "react";
import { prefersReduced } from "./motion";

const GAP = 30; // px between dots
const LIME = [212, 255, 58] as const;
const INK = [236, 236, 230] as const;

interface Ripple { x: number; y: number; t0: number }

export function HeroField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const still = prefersReduced();

    let w = 0, h = 0, dpr = 1;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    // Pointer, eased towards its target so the light glides instead of jumping.
    const target = { x: w * 0.68, y: h * 0.42, active: false };
    const light = { x: target.x, y: target.y };
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      target.x = e.clientX - r.left;
      target.y = e.clientY - r.top;
      target.active = true;
    };
    const onLeave = () => { target.active = false; };

    const ripples: Ripple[] = [];
    let nextRipple = 900;
    const spawn = (t: number) => {
      // Land in the open right-hand part of the field, away from the headline.
      ripples.push({ x: w * (0.45 + Math.random() * 0.5), y: h * (0.15 + Math.random() * 0.7), t0: t });
      if (ripples.length > 4) ripples.shift();
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      // Idle drift: a slow figure-eight when the pointer is away.
      if (!target.active) {
        target.x = w * (0.66 + 0.16 * Math.sin(t / 5200));
        target.y = h * (0.45 + 0.18 * Math.sin(t / 3700));
      }
      light.x += (target.x - light.x) * 0.06;
      light.y += (target.y - light.y) * 0.06;

      if (t > nextRipple) {
        spawn(t);
        nextRipple = t + 2600 + Math.random() * 1800;
      }

      const spot = Math.max(220, Math.min(w, h) * 0.42);
      const cols = Math.ceil(w / GAP) + 1, rows = Math.ceil(h / GAP) + 1;
      const ox = (w - (cols - 1) * GAP) / 2, oy = (h - (rows - 1) * GAP) / 2;

      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = ox + i * GAP, y = oy + j * GAP;
          const dx = x - light.x, dy = y - light.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          const s = d < spot ? 1 - d / spot : 0; // spotlight 0..1
          let wave = 0;
          for (const r of ripples) {
            const age = (t - r.t0) / 1000;
            const front = age * 260; // px per second
            const fade = Math.max(0, 1 - age / 3.2);
            if (fade <= 0) continue;
            const rd = Math.hypot(x - r.x, y - r.y);
            const band = Math.abs(rd - front);
            if (band < 36) wave = Math.max(wave, (1 - band / 36) * fade);
          }
          // Vignette: dots fade towards the edges and under the headline column.
          const ex = Math.min(x, w - x) / (w * 0.18), ey = Math.min(y, h - y) / (h * 0.22);
          const edge = Math.min(1, ex, ey);
          const base = 0.085 + s * s * 0.55;
          const a = Math.min(1, (base + wave * 0.9) * edge);
          if (a < 0.02) continue;
          const mix = Math.min(1, wave * 1.2 + s * 0.35);
          const c0 = Math.round(INK[0] + (LIME[0] - INK[0]) * mix);
          const c1 = Math.round(INK[1] + (LIME[1] - INK[1]) * mix);
          const c2 = Math.round(INK[2] + (LIME[2] - INK[2]) * mix);
          // A gentle lens: lit dots lean away from the light.
          const push = s * 3 + wave * 2;
          const px = d > 0 ? x + (dx / d) * push : x, py = d > 0 ? y + (dy / d) * push : y;
          const size = 1 + s * 0.9 + wave * 1.1;
          ctx.fillStyle = `rgba(${c0},${c1},${c2},${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(px, py, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // The seal itself: a thin ring at each landing point that opens and fades.
      for (const r of ripples) {
        const age = (t - r.t0) / 1000;
        if (age > 1.4) continue;
        const k = age / 1.4;
        ctx.strokeStyle = `rgba(${LIME[0]},${LIME[1]},${LIME[2]},${(0.5 * (1 - k)).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 4 + k * 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(${LIME[0]},${LIME[1]},${LIME[2]},${(0.9 * (1 - k)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    if (still) {
      draw(0);
      const onResize = () => { resize(); draw(0); };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }

    let raf = 0, visible = true, start = performance.now();
    const loop = (now: number) => {
      draw(now - start);
      raf = requestAnimationFrame(loop);
    };
    const play = () => { if (!raf && visible && !document.hidden) { start = performance.now() - 1; raf = requestAnimationFrame(loop); } };
    const pause = () => { cancelAnimationFrame(raf); raf = 0; ripples.length = 0; nextRipple = 600; };
    const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; if (visible) play(); else pause(); });
    io.observe(canvas);
    const onVis = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", onVis);
    const host = canvas.parentElement ?? canvas;
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    play();

    return () => {
      pause();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden />;
}
