export interface CostAmount {
  readonly raw: string;
  readonly human: number;
  readonly symbol: string;
  readonly usd?: number;
}

export interface SwapCost {
  readonly slippageBps: number;
  readonly estReceived: CostAmount;
  readonly minReceived: CostAmount;
  readonly priceImpactPct: number | null;
}

export const usdOf = (human: number, price?: number) =>
  price !== undefined && price > 0 ? { usd: human * price } : {};

const amountOf = (raw: bigint, decimals: number, symbol: string, price?: number): CostAmount => {
  const human = Number(raw) / 10 ** decimals;
  return { raw: raw.toString(), human, symbol, ...usdOf(human, price) };
};

/**
 * What a swap gives for the review sheet: expected and minimum output (in USD where the collector has a confirmed
 * price) and the price impact, including the pool fee, against the pool's mid-price. `reserves` only for a
 * constant-product pool: a stable pool's reserve ratio is not its price, so it gets no impact rather than a wrong one.
 */
export function swapCost(p: {
  amountIn: bigint;
  decIn: number;
  priceIn?: number;
  amountOut: bigint;
  decOut: number;
  symOut: string;
  priceOut?: number;
  slippageBps: number;
  reserves: { in: bigint; out: bigint } | null;
}): SwapCost {
  const minOut = (p.amountOut * BigInt(10_000 - p.slippageBps)) / 10_000n;
  let priceImpactPct: number | null = null;
  if (p.reserves && p.reserves.in > 0n && p.reserves.out > 0n && p.amountIn > 0n) {
    const spot = Number(p.reserves.out) / 10 ** p.decOut / (Number(p.reserves.in) / 10 ** p.decIn);
    const exec = Number(p.amountOut) / 10 ** p.decOut / (Number(p.amountIn) / 10 ** p.decIn);
    priceImpactPct = Math.max(0, (1 - exec / spot) * 100);
  }
  return {
    slippageBps: p.slippageBps,
    estReceived: amountOf(p.amountOut, p.decOut, p.symOut, p.priceOut),
    minReceived: amountOf(minOut, p.decOut, p.symOut, p.priceOut),
    priceImpactPct,
  };
}
