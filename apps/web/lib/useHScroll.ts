"use client";
/**
 * Horizontal strip that scrolls without a scrollbar:
 *  - mouse wheel: vertical wheel moves the strip sideways (eased), until it reaches an end,
 *    then the page scrolls as usual;
 *  - mouse drag: grab and throw, with a little momentum; a drag never counts as a click;
 *  - touch and trackpads keep their native sideways scrolling.
 */
import { useEffect, type RefObject } from "react";

export function useHScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let target = el.scrollLeft;
    let raf = 0;
    const max = () => el.scrollWidth - el.clientWidth;
    const glide = () => {
      const d = target - el.scrollLeft;
      if (Math.abs(d) < 0.5) {
        el.scrollLeft = target;
        raf = 0;
        return;
      }
      el.scrollLeft += d * 0.18;
      raf = requestAnimationFrame(glide);
    };
    const go = (to: number) => {
      target = Math.max(0, Math.min(max(), to));
      if (!raf) raf = requestAnimationFrame(glide);
    };

    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // trackpad sideways: native
      const base = raf ? target : el.scrollLeft;
      const atStart = base <= 0 && e.deltaY < 0;
      const atEnd = base >= max() - 1 && e.deltaY > 0;
      if (atStart || atEnd || max() <= 0) return; // let the page scroll on
      e.preventDefault();
      e.stopPropagation();
      go(base + e.deltaY * (e.deltaMode === 1 ? 32 : 1));
    };

    let down = false, moved = false, startX = 0, startLeft = 0, lastX = 0, lastT = 0, v = 0;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      down = true;
      moved = false;
      startX = lastX = e.clientX;
      startLeft = el.scrollLeft;
      lastT = performance.now();
      v = 0;
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) > 5) {
        moved = true;
        el.classList.add("dragging");
        el.setPointerCapture(e.pointerId);
      }
      if (!moved) return;
      el.scrollLeft = startLeft - dx;
      const now = performance.now();
      v = (lastX - e.clientX) / Math.max(1, now - lastT);
      lastX = e.clientX;
      lastT = now;
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      down = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (moved) {
        el.classList.remove("dragging");
        go(el.scrollLeft + v * 260); // momentum
      }
    };
    // A drag ends with a click on whatever was under the pointer: swallow it.
    const onClick = (e: MouseEvent) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    };
    const onScroll = () => {
      if (!raf && !down) target = el.scrollLeft;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClick, true);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("scroll", onScroll);
    };
  }, [ref]);
}
