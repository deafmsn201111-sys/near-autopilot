/**
 * LOOPING on Burrow (simulation only: the autopilot's safety policy has no borrow action, so it can never run this).
 *
 * A loop deposits an asset as collateral, borrows the same asset against it, deposits that again, and repeats, so the
 * deposit earns the supply rate on L x the equity while (L - 1) x the equity pays the borrow rate:
 *
 *   net APR on equity = L x supply - (L - 1) x borrow
 *
 * Burrow's health factor is  sum(collateral x vr) / sum(debt / vr)  (vr = the asset's volatility_ratio, shown as the
 * collateral factor). With the same asset on both sides the price cancels:  HF = L x vr^2 / (L - 1),  so a target HF h
 * gives the leverage exactly:  L = h / (h - vr^2). Each round borrows r = vr^2 / h of the previous deposit; the rounds
 * needed to reach 99 % of L set the gas.
 *
 * Same-asset loops only: no swap, no price risk between the two sides. What remains is RATE risk: when the borrow rate
 * is above h x the supply rate, debt grows faster than the weighted collateral and the health factor drifts down
 * without any price move. Both the break-even borrow rate and that drift are reported.
 */
export interface LoopMarket {
  readonly token: string;
  readonly status?: string;
  readonly supplyApr?: string | null;
  readonly netSupplyApr?: string | null;
  readonly borrowApr?: string | null;
  readonly collateralFactor?: number;
  readonly canUseAsCollateral?: boolean;
  readonly canBorrow?: boolean;
  readonly canDeposit?: boolean;
  readonly availableUsd?: string | null;
}

export interface LoopResult {
  readonly token: string;
  readonly equityUsd: number;
  readonly targetHealthFactor: number;
  readonly leverage: number;
  readonly rounds: number;
  readonly depositedUsd: number;
  readonly borrowedUsd: number;
  readonly supplyApr: number;
  readonly borrowApr: number;
  readonly netApr: number;
  readonly horizonDays: number;
  readonly grossUsd: number;
  readonly borrowCostUsd: number;
  readonly gasUsd: number;
  readonly netUsd: number;
  /** The loop stops paying above this borrow rate. */
  readonly breakEvenBorrowApr: number;
  /** Days until the health factor reaches 1.0 from rate drift alone (null: it does not drift down). */
  readonly daysToLiquidationFromRates: number | null;
  /** Borrowed amount fits in the market's available liquidity. */
  readonly fitsLiquidity: boolean;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function loopFor(
  m: LoopMarket,
  o: { equityUsd: number; targetHealthFactor: number; gasUsdPerTx: number; horizonDays: number },
): LoopResult | null {
  if (m.status !== 'OK' || !m.canUseAsCollateral || !m.canBorrow || m.canDeposit === false)
    return null;
  const vr = m.collateralFactor ?? 0;
  const s = num(m.netSupplyApr) ?? num(m.supplyApr);
  const b = num(m.borrowApr);
  const h = o.targetHealthFactor;
  const k = vr * vr;
  if (s === null || b === null || vr <= 0 || h <= k || o.equityUsd <= 0) return null;
  const L = h / (h - k);
  const r = k / h;
  let rounds = 0;
  let total = 1;
  for (let term = 1; total < 0.99 * L && rounds < 50; rounds += 1) {
    term *= r;
    total += term;
  }
  const H = o.horizonDays / 365;
  const E = o.equityUsd;
  const netApr = L * s - (L - 1) * b;
  // enter: deposit + `rounds` x (borrow + deposit); exit: the same in reverse
  const gasUsd = 2 * (1 + 2 * rounds) * o.gasUsdPerTx;
  const grossUsd = E * L * s * H;
  const borrowCostUsd = E * (L - 1) * b * H;
  const drift = b - h * s;
  return {
    token: m.token,
    equityUsd: E,
    targetHealthFactor: h,
    leverage: L,
    rounds,
    depositedUsd: E * L,
    borrowedUsd: E * (L - 1),
    supplyApr: s,
    borrowApr: b,
    netApr,
    horizonDays: o.horizonDays,
    grossUsd,
    borrowCostUsd,
    gasUsd,
    netUsd: grossUsd - borrowCostUsd - gasUsd,
    breakEvenBorrowApr: (L * s) / (L - 1),
    daysToLiquidationFromRates: drift > 0 ? ((h - 1) / drift) * 365 : null,
    fitsLiquidity: (num(m.availableUsd) ?? 0) >= E * (L - 1),
  };
}

/** Every same-asset loop Burrow allows, best net result first. */
export function loopStrategies(
  markets: readonly LoopMarket[],
  o: { equityUsd: number; targetHealthFactor: number; gasUsdPerTx: number; horizonDays: number },
): LoopResult[] {
  return markets
    .flatMap((m) => {
      const r = loopFor(m, o);
      return r ? [r] : [];
    })
    .sort((a, b) => b.netUsd - a.netUsd);
}
