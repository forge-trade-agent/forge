"use client";
/**
 * Motion layer:
 *  - Lenis smooth scrolling, driven by GSAP's ticker so ScrollTrigger stays in sync.
 *  - Reveals: any element with data-reveal rises in once when it enters, staggered with its
 *    siblings in the same [data-reveal-group] (heading, then text, then picture). Elements that
 *    mount later (API data) are picked up by a MutationObserver.
 *  - SplitText: headline letters rise out of a mask on load.
 * Content is only hidden after this script runs (html.motion), and never with reduced motion.
 */
import { createElement, useEffect, useRef, type ElementType, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

if (typeof window !== "undefined") gsap.registerPlugin(ScrollTrigger);

let lenis: Lenis | null = null;
export const getLenis = () => lenis;

export function prefersReduced(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** App screens get entrances without per-component wiring: headers, panels and tiles in <main>. */
const AUTO = "main .page-head, main .panel, main .tile, main .grid-tiles > *";

function revealPending(root: ParentNode = document) {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(AUTO))) {
    if (!el.hasAttribute("data-reveal") && !el.closest("[data-reveal], [data-noreveal], .fx-hero, .modal, .drawer")) {
      el.setAttribute("data-reveal", "");
    }
  }
  const els = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]:not([data-revealed])"));
  if (!els.length) return;
  for (const el of els) el.setAttribute("data-revealed", "pending");
  const show = (batch: HTMLElement[]) => {
    // Keep reading order: by position on the page.
    const sorted = batch.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    gsap.to(sorted, {
      opacity: 1,
      y: 0,
      duration: 0.8,
      ease: "expo.out",
      stagger: 0.06,
      overwrite: true,
      onComplete: () => sorted.forEach((el) => el.setAttribute("data-revealed", "done")),
    });
  };
  // Whatever is already on screen comes in now; triggers only fire on scroll.
  const fold = window.innerHeight * 0.95;
  const now = els.filter((el) => el.getBoundingClientRect().top < fold);
  const later = els.filter((el) => !now.includes(el));
  if (now.length) show(now);
  if (later.length) ScrollTrigger.batch(later, { start: "top 90%", once: true, onEnter: (b) => show(b as HTMLElement[]) });
}

export function MotionRoot({ children }: { children: ReactNode }) {
  const path = usePathname();

  useEffect(() => {
    if (prefersReduced()) return;
    document.documentElement.classList.add("motion");
    lenis = new Lenis({ lerp: 0.09, smoothWheel: true, wheelMultiplier: 1 });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis?.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    // Pick up elements that mount later (data from the API, route changes).
    let t: ReturnType<typeof setTimeout> | null = null;
    const mo = new MutationObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        revealPending();
        ScrollTrigger.refresh();
      }, 60);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    revealPending();

    // Anchor links scroll smoothly through Lenis.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.("a[href^='#']") as HTMLAnchorElement | null;
      if (!a || a.getAttribute("href") === "#") return;
      const target = document.querySelector(a.getAttribute("href")!);
      if (target) {
        e.preventDefault();
        lenis?.scrollTo(target as HTMLElement, { offset: -90, duration: 1.2 });
      }
    };
    document.addEventListener("click", onClick);

    return () => {
      mo.disconnect();
      document.removeEventListener("click", onClick);
      gsap.ticker.remove(tick);
      lenis?.destroy();
      lenis = null;
      document.documentElement.classList.remove("motion");
    };
  }, []);

  // New page: start at the top and re-measure every trigger.
  useEffect(() => {
    if (!window.location.hash) lenis?.scrollTo(0, { immediate: true });
    const id = requestAnimationFrame(() => {
      revealPending();
      ScrollTrigger.refresh();
    });
    return () => cancelAnimationFrame(id);
  }, [path]);

  return <>{children}</>;
}

/** Headline whose letters rise out of a mask. Words stay unbroken; screen readers get the plain text. */
export function SplitText({
  text,
  as = "span",
  className,
  delay = 0,
  lines,
}: {
  text: string;
  as?: ElementType;
  className?: string;
  delay?: number;
  /** Optional explicit line breaks: each entry is one line. */
  lines?: string[];
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReduced()) return;
    const chars = el.querySelectorAll(".c");
    gsap.fromTo(chars, { yPercent: 110 }, { yPercent: 0, duration: 1.1, ease: "expo.out", stagger: 0.028, delay });
  }, [delay]);
  const rows = lines ?? [text];
  return createElement(
    as,
    { ref, className: `split ${className ?? ""}`, "aria-label": rows.join(" ") },
    rows.map((row, ri) => (
      <span key={ri} style={{ display: "block" }} aria-hidden className={ri > 0 ? "indent" : undefined}>
        {row.split(" ").map((word, wi) => (
          <span key={wi} className="w">
            {[...word].map((ch, ci) => (
              <span key={ci} className="c">{ch}</span>
            ))}
            {wi < row.split(" ").length - 1 ? <span className="c">&nbsp;</span> : null}
          </span>
        ))}
      </span>
    )),
  );
}

/** Scroll-linked transform on any element (locked to the scrollbar, no smoothing). */
export function useScrub(
  target: React.RefObject<HTMLElement | null>,
  vars: gsap.TweenVars,
  opts: { trigger?: React.RefObject<HTMLElement | null>; start?: string; end?: string } = {},
) {
  useEffect(() => {
    const el = target.current;
    if (!el || prefersReduced()) return;
    const tween = gsap.to(el, {
      ...vars,
      ease: "none",
      scrollTrigger: { trigger: opts.trigger?.current ?? el, start: opts.start ?? "top bottom", end: opts.end ?? "bottom top", scrub: true },
    });
    return () => {
      tween.scrollTrigger?.kill();
      tween.kill();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
