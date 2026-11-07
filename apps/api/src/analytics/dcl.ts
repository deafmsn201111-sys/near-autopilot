import {
  depositPerUnitLiquidityX96,
  feeToPointDelta,
  floorToPointDelta,
  Q96,
} from '@near-autopilot/rhea-dcl-adapter';

/**
 * DCL (Rhea concentrated liquidity) LP ENTRY ESTIMATE. Analysis only: nothing here can be executed.
 *
 * Method (stated in every result): a BACKTEST on the stored pool observations of the window. A position of `capitalUsd`
 * is opened at the window's first observation in a range of ±w around that price. For every interval between two
 * observations it earns the LP part of the fees the pool charged in that interval (total_fee_x/y_charged deltas, minus
 * the protocol's share) times its share of the active liquidity, ONLY if the price was inside its range. Fees are
 * scaled linearly from the window to the horizon. Divergence loss is the concentrated-liquidity loss against holding,
 * for a price move equal to the largest move seen in the window scaled by sqrt(horizon / window), the worse of up and
 * down. Entry/exit: half the capital swapped through this pool each way (pool fee; price impact ignored for amounts this
 * small against the pool), and the network fees of the transactions. Liquidity per unit is the contract's own
 * arithmetic (`compute_deposit_xy_per_unit`, rhea-dcl-adapter). Farm rewards are not included.
 */

/** Rhea DCL `get_metadata().protocol_fee_rate` (2000 of 10,000 = 20 %, read on mainnet 2026-11-08). */
export const DCL_PROTOCOL_FEE_SHARE = 0.2;
/** Ranges simulated: ± this share of the entry price. */
export const DCL_RANGES = [0.05, 0.15, 0.5] as const;
/** Transactions of an entry and an exit: swap, two token transfers, add; remove, two withdrawals, swap back. */
export const DCL_TRANSACTIONS = 8;
const MIN_POINTS = 48;
const MIN_WINDOW_SECONDS = 86_400;
const LN_BASE = Math.log(1.0001);

export interface DclPoint {
  readonly at: Date;
  readonly point: number;
  readonly liquidity: bigint;
  readonly feeX: bigint;
  readonly feeY: bigint;
}

export interface DclRangeResult {
  /** ± share of the entry price. */
  readonly width: number;
  readonly leftPoint: number;
  readonly rightPoint: number;
  /** Share of the window's time the price spent inside the range. */
  readonly inRangeShare: number;
  /** Average share of the active liquidity the position would have held while in range. */
  readonly liquidityShare: number;
  readonly feesUsd: number;
  readonly divergenceLossUsd: number;
  readonly swapUsd: number;
  readonly gasUsd: number;
  readonly netUsd: number;
  readonly netApr: number;
  /** Fees alone, annualised on the capital. */
  readonly feeApr: number;
  /** What actually happened over the window, unscaled: entered at its start, valued at its end. */
  readonly backtest: {
    readonly feesUsd: number;
    readonly divergenceLossUsd: number;
    readonly netUsd: number;
  };
}

export interface DclEstimate {
  readonly status: 'OK' | 'INSUFFICIENT_DATA';
  readonly reason: string | null;
  readonly capitalUsd: number;
  readonly horizonDays: number;
  readonly windowSeconds: number;
  readonly observations: number;
  /** Largest relative price move seen in the window (either way). */
  readonly maxMove: number;
  /** LP fees (after the protocol's share) the whole pool earned over the window, USD. */
  readonly poolLpFeesUsd: number;
  readonly ranges: readonly DclRangeResult[];
  readonly method: string;
}

const METHOD =
  'backtest on stored observations: fees only while in range, by share of active liquidity, after the 20% protocol share; divergence loss for the largest observed move scaled to the horizon; half the capital swapped each way through the pool; gas per transaction; no farm rewards';

/** Token amounts (decimal units) of one unit of liquidity in [l, r) at point p: the contract's per-unit arithmetic. */
function perUnit(
  l: number,
  r: number,
  p: number,
  dec: readonly [number, number],
): { x: number; y: number } {
  const per = depositPerUnitLiquidityX96(l, r, p);
  return {
    x: Number(per.x) / Number(Q96) / 10 ** dec[0],
    y: Number(per.y) / Number(Q96) / 10 ** dec[1],
  };
}

/** Price of one token X in token Y (decimal units) at point p: 1.0001^p raw Y per raw X. */
export const priceXinY = (p: number, dec: readonly [number, number]): number =>
  Math.pow(1.0001, p) * 10 ** (dec[0] - dec[1]);

/**
 * Loss against holding, as a share of the value held, for a move of the pool price from point p0 to p1 of a position
 * entered at p0 in [l, r). Exact in the pool's own terms (valued in token Y at the price of p1): no USD price enters.
 */
export function divergenceShare(
  l: number,
  r: number,
  p0: number,
  p1: number,
  dec: readonly [number, number],
): number {
  const a = perUnit(l, r, p0, dec);
  const b = perUnit(l, r, Math.min(Math.max(p1, l), r - 1), dec);
  const px = priceXinY(p1, dec);
  const hold = a.x * px + a.y;
  const lp = b.x * px + b.y;
  return hold > 0 ? Math.max(0, 1 - lp / hold) : 0;
}

export function estimateDcl(i: {
  points: readonly DclPoint[];
  feePpm: number;
  decimals: readonly [number, number];
  /** Current USD price of token X and token Y (confirmed). */
  pricesUsd: readonly [number, number];
  capitalUsd: number;
  horizonDays: number;
  gasUsdPerTx: number;
}): DclEstimate {
  const pts = [...i.points].sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = pts[0];
  const last = pts[pts.length - 1];
  const windowSeconds = first && last ? (last.at.getTime() - first.at.getTime()) / 1000 : 0;
  const base = {
    capitalUsd: i.capitalUsd,
    horizonDays: i.horizonDays,
    windowSeconds,
    observations: pts.length,
    method: METHOD,
  };
  const insufficient = (reason: string): DclEstimate => ({
    ...base,
    status: 'INSUFFICIENT_DATA',
    reason,
    maxMove: 0,
    poolLpFeesUsd: 0,
    ranges: [],
  });
  if (!first || !last || pts.length < MIN_POINTS || windowSeconds < MIN_WINDOW_SECONDS)
    return insufficient(
      `needs at least ${MIN_POINTS} observations over 24 hours (has ${pts.length} over ${(windowSeconds / 3600).toFixed(1)} h)`,
    );
  if (i.capitalUsd <= 0) return insufficient('no capital to simulate');
  let delta: number;
  try {
    delta = feeToPointDelta(i.feePpm);
  } catch {
    return insufficient(`unknown fee tier ${i.feePpm}`);
  }
  const { decimals: dec, pricesUsd: usd } = i;
  const feeUsd = (dx: bigint, dy: bigint) =>
    (Number(dx) / 10 ** dec[0]) * usd[0] + (Number(dy) / 10 ** dec[1]) * usd[1];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    if (a && b && (b.feeX < a.feeX || b.feeY < a.feeY))
      return insufficient('the fee counters went backwards: data not usable');
  }
  const poolLpFeesUsd =
    feeUsd(last.feeX - first.feeX, last.feeY - first.feeY) * (1 - DCL_PROTOCOL_FEE_SHARE);
  const maxMove = Math.max(
    ...pts.map((p) => Math.abs(Math.pow(1.0001, p.point - first.point) - 1)),
  );
  const scale = (i.horizonDays * 86_400) / windowSeconds;
  const stableX = Math.abs(usd[0] - 1) < 0.02;
  const entryUsd: readonly [number, number] = stableX
    ? [usd[0], usd[0] / priceXinY(first.point, dec)]
    : [usd[1] * priceXinY(first.point, dec), usd[1]];
  const movePoints = Math.round((Math.log(1 + maxMove) / LN_BASE) * Math.sqrt(Math.max(1, scale)));

  const ranges = DCL_RANGES.map((w): DclRangeResult => {
    const half = Math.round(Math.log(1 + w) / LN_BASE);
    const leftPoint = floorToPointDelta(first.point - half, delta);
    const rightPoint = floorToPointDelta(first.point + half, delta) + delta;
    // Sized at ENTRY prices: the stablecoin side (or Y) keeps its USD price, the other follows the pool price then.
    const unit = perUnit(leftPoint, rightPoint, first.point, dec);
    const [ux, uy] = entryUsd;
    const unitUsd = unit.x * ux + unit.y * uy;
    const lPos = unitUsd > 0 ? i.capitalUsd / unitUsd : 0;
    let fees = 0;
    let inSeconds = 0;
    let shareTime = 0;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      if (!a || !b) continue;
      const dt = (b.at.getTime() - a.at.getTime()) / 1000;
      // In range over the interval: the price at both ends inside (a conservative reading of a 15-minute step).
      const inside = (p: number) => p >= leftPoint && p < rightPoint;
      if (!inside(a.point) || !inside(b.point)) continue;
      const active = (Number(a.liquidity) + Number(b.liquidity)) / 2;
      const share = lPos / (active + lPos);
      fees += feeUsd(b.feeX - a.feeX, b.feeY - a.feeY) * (1 - DCL_PROTOCOL_FEE_SHARE) * share;
      inSeconds += dt;
      shareTime += share * dt;
    }
    const feesUsd = fees * scale;
    const divergenceLossUsd =
      i.capitalUsd *
      Math.max(
        divergenceShare(leftPoint, rightPoint, first.point, first.point + movePoints, dec),
        divergenceShare(leftPoint, rightPoint, first.point, first.point - movePoints, dec),
      );
    const realisedLoss =
      i.capitalUsd * divergenceShare(leftPoint, rightPoint, first.point, last.point, dec);
    const swapUsd = 2 * 0.5 * i.capitalUsd * (i.feePpm / 1_000_000);
    const gasUsd = DCL_TRANSACTIONS * i.gasUsdPerTx;
    const netUsd = feesUsd - divergenceLossUsd - swapUsd - gasUsd;
    const annual = 365 / i.horizonDays;
    return {
      width: w,
      leftPoint,
      rightPoint,
      inRangeShare: inSeconds / windowSeconds,
      liquidityShare: inSeconds > 0 ? shareTime / inSeconds : 0,
      feesUsd,
      divergenceLossUsd,
      swapUsd,
      gasUsd,
      netUsd,
      netApr: (netUsd / i.capitalUsd) * annual,
      feeApr: (feesUsd / i.capitalUsd) * annual,
      backtest: {
        feesUsd: fees,
        divergenceLossUsd: realisedLoss,
        netUsd: fees - realisedLoss - swapUsd - gasUsd,
      },
    };
  });
  return { ...base, status: 'OK', reason: null, maxMove, poolLpFeesUsd, ranges };
}
