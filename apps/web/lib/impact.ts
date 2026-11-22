/**
 * Price impact of a market order on a token's DEX pool, the model shared by the slippage
 * calculator, the order forms and the stats: constant product with half the pool's liquidity (Y)
 * on each side. Buying $S costs about S/Y more than the pool price; selling returns about
 * S/(Y+S) less. At S >= Y a buy would empty that side of the pool: "too thin". Estimate only.
 */
export type ImpactSide = "buy" | "sell";

export function priceImpact(side: ImpactSide, sizeUsd: number, liquidityUsd: number): number | null {
  const y = liquidityUsd / 2;
  if (!(y > 0) || !(sizeUsd > 0)) return null;
  if (side === "buy") return sizeUsd >= y ? null : sizeUsd / y;
  return sizeUsd / (y + sizeUsd);
}
