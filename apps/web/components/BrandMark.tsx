/**
 * The Forge mark: a spark (the rounded diamond) above two ribbons folded into a loop.
 * Each ribbon starts as a point in a bottom corner, sweeps in along the base, rises across the
 * middle, rounds the opposite lobe and comes down its outer side, ending just above the other
 * ribbon's sweep (the thin cut). "/" lies over "\" where they cross.
 * One colour, drawn as strokes on a 376-unit square: crisp from a 16px favicon to hero size.
 */
import { useId } from "react";

export const MARK_VIEWBOX = "182 178 376 376";
export const MARK = {
  spark: "M350 214Q370 190 390 214L426 274Q436 292 424 308L384 350Q370 366 356 350L316 308Q304 292 314 274Z",
  /** "/" ribbon: bottom-left point, base sweep, up across the middle, round the right lobe, down its side. */
  a: "M212 518C240 534 272 532 296 514L418 407C436 388 470 368 488 392L527 470Q534 486 532 506",
  /** "\" ribbon: the mirror image. */
  b: "M528 518C500 534 468 532 444 514L322 407C304 388 270 368 252 392L213 470Q206 486 208 506",
  /** Pieces that lie on top, used to cut the ribbon underneath. */
  aSweep: "M212 518C240 534 272 532 296 514",
  aRise: "M296 514L418 407",
  bSweep: "M528 518C500 534 468 532 444 514",
  width: 36,
  /** Half-gap where "/" crosses over "\". */
  crossGap: 11,
  /** Half-gap of the thin cut above each base sweep. */
  foldGap: 6,
} as const;

export function ForgeMark({ size = 28, color = "var(--lime)", className, title }: { size?: number | string; color?: string; className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  const W = MARK.width;
  return (
    <svg
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      fill="none"
      stroke={color}
      strokeWidth={W}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <defs>
        {/* "/" is cut only by the base sweep of "\" (bottom-right fold). */}
        <mask id={`fa-${id}`} maskUnits="userSpaceOnUse" x="182" y="178" width="376" height="376">
          <rect x="182" y="178" width="376" height="376" fill="#fff" stroke="none" />
          <path d={MARK.bSweep} stroke="#000" strokeWidth={W + MARK.foldGap * 2} strokeLinecap="butt" />
        </mask>
        {/* "\" is cut by the base sweep of "/" (bottom-left fold) and where "/" crosses it. */}
        <mask id={`fb-${id}`} maskUnits="userSpaceOnUse" x="182" y="178" width="376" height="376">
          <rect x="182" y="178" width="376" height="376" fill="#fff" stroke="none" />
          <path d={MARK.aSweep} stroke="#000" strokeWidth={W + MARK.foldGap * 2} strokeLinecap="butt" />
          <path d={MARK.aRise} stroke="#000" strokeWidth={W + MARK.crossGap * 2} strokeLinecap="butt" />
        </mask>
      </defs>
      <path d={MARK.spark} />
      <path d={MARK.b} mask={`url(#fb-${id})`} />
      <path d={MARK.a} mask={`url(#fa-${id})`} />
    </svg>
  );
}
