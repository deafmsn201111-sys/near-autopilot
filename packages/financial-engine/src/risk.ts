import { USD_SCALE, type UnitPrice } from '@near-autopilot/core';
import { assertBps, BPS, divRound, mulDiv, WAD } from './fixed';

/**
 * Generic over-collateralised lending risk: health factor, LTV, distance to liquidation, price shocks, stress tests
 * and a liquidation simulation. All bigint. Protocol-specific rules (e.g. Burrow's volatility ratio, or Aave's
 * per-asset liquidation thresholds) are expressed through two per-asset parameters:
 *
 *   collateral:  liquidationThresholdBps  - fraction of the collateral's value that counts against debt
 *   debt:        borrowFactorBps          - debt value is divided by it (10000 = plain debt)
 *
 *   adjustedCollateral = Σ value_c * liquidationThreshold / 10000        (rounded DOWN)
 *   adjustedDebt       = Σ value_d * 10000 / borrowFactor                (rounded UP)
 *   healthFactor       = adjustedCollateral / adjustedDebt                (rounded DOWN, WAD)
 *   liquidatable      <=> debt exists AND adjustedCollateral < adjustedDebt   (HF exactly 1.0 is NOT liquidatable)
 *
 * Rounding only ever makes a position look slightly worse. USD values are micro-USD (10^-6) using the oracle price
 * convention shared with the rest of the repo: usd = raw * multiplier / 10^decimals.
 *
 * Not modelled: interest accrual beyond what a scenario states, oracle latency/manipulation, liquidity of the
 * collateral during a liquidation, bad debt, and protocol-specific liquidation incentives beyond the two parameters
 * accepted by `simulateLiquidation`. There is deliberately NO probability-of-liquidation figure: it would need a
 * volatility/return distribution, which is an estimate this module refuses to invent.
 */

export interface CollateralAsset {
  readonly id: string;
  readonly amount: bigint;
  readonly price: UnitPrice;
  readonly liquidationThresholdBps: number;
}

export interface DebtAsset {
  readonly id: string;
  readonly amount: bigint;
  readonly price: UnitPrice;
  /** Default 10000. Must be > 0. */
  readonly borrowFactorBps?: number;
}

export interface LendingModel {
  readonly collateral: readonly CollateralAsset[];
  readonly debt: readonly DebtAsset[];
}

const pow10 = (n: number): bigint => {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('invalid decimals');
  return 10n ** BigInt(n);
};

export function usdValue(raw: bigint, price: UnitPrice, rounding: 'floor' | 'ceil'): bigint {
  if (raw < 0n) throw new RangeError('amount must be non-negative');
  return divRound(raw * price.multiplier * USD_SCALE, pow10(price.decimals), rounding);
}

function validate(model: LendingModel): void {
  const seen = new Set<string>();
  for (const c of model.collateral) {
    if (seen.has(`c:${c.id}`)) throw new RangeError(`duplicate collateral id ${c.id}`);
    seen.add(`c:${c.id}`);
    assertBps(c.liquidationThresholdBps, `liquidationThresholdBps(${c.id})`);
    if (c.amount < 0n || c.price.multiplier < 0n)
      throw new RangeError(`invalid collateral ${c.id}`);
  }
  for (const d of model.debt) {
    if (seen.has(`d:${d.id}`)) throw new RangeError(`duplicate debt id ${d.id}`);
    seen.add(`d:${d.id}`);
    const bf = d.borrowFactorBps ?? 10_000;
    if (!Number.isInteger(bf) || bf <= 0 || bf > 10_000)
      throw new RangeError(`borrowFactorBps(${d.id}) must be in (0, 10000]`);
    if (d.amount < 0n || d.price.multiplier < 0n) throw new RangeError(`invalid debt ${d.id}`);
  }
}

export interface LendingAssessment {
  readonly collateralUsd: bigint;
  readonly debtUsd: bigint;
  readonly adjustedCollateralUsd: bigint;
  readonly adjustedDebtUsd: bigint;
  /** null when there is no debt. WAD: 1.0 = exactly at the liquidation line. */
  readonly healthFactorWad: bigint | null;
  /** debt / collateral, bps, rounded up. 0 without debt. null if debt exists but collateral is worth nothing. */
  readonly ltvBps: bigint | null;
  /** Value-weighted average liquidation threshold of the collateral, bps (floor). null without collateral value. */
  readonly weightedLiquidationThresholdBps: bigint | null;
  /** adjustedCollateral - adjustedDebt (signed). Negative = liquidatable. */
  readonly headroomUsd: bigint;
  readonly liquidatable: boolean;
}

export function assessLendingPosition(model: LendingModel): LendingAssessment {
  validate(model);
  let collateralUsd = 0n;
  let adjustedCollateralUsd = 0n;
  for (const c of model.collateral) {
    const v = usdValue(c.amount, c.price, 'floor');
    collateralUsd += v;
    adjustedCollateralUsd += (v * BigInt(c.liquidationThresholdBps)) / BPS;
  }
  let debtUsd = 0n;
  let adjustedDebtUsd = 0n;
  for (const d of model.debt) {
    const v = usdValue(d.amount, d.price, 'ceil');
    debtUsd += v;
    adjustedDebtUsd += divRound(v * BPS, BigInt(d.borrowFactorBps ?? 10_000), 'ceil');
  }
  const hasDebt = adjustedDebtUsd > 0n;
  return {
    collateralUsd,
    debtUsd,
    adjustedCollateralUsd,
    adjustedDebtUsd,
    healthFactorWad: hasDebt ? mulDiv(adjustedCollateralUsd, WAD, adjustedDebtUsd, 'floor') : null,
    ltvBps: !hasDebt
      ? 0n
      : collateralUsd === 0n
        ? null
        : divRound(debtUsd * BPS, collateralUsd, 'ceil'),
    weightedLiquidationThresholdBps:
      collateralUsd === 0n ? null : (adjustedCollateralUsd * BPS) / collateralUsd,
    headroomUsd: adjustedCollateralUsd - adjustedDebtUsd,
    liquidatable: hasDebt && adjustedCollateralUsd < adjustedDebtUsd,
  };
}

// ----------------------------------------------------------------------------------------------------------
// Shocks and stress tests
// ----------------------------------------------------------------------------------------------------------

export interface Scenario {
  readonly name: string;
  /** Price change for every collateral asset, bps (-2000 = -20%). */
  readonly collateralShockBps?: number;
  /** Price change for every debt asset, bps. */
  readonly debtShockBps?: number;
  /** Per-asset override (keyed by asset id) of the two defaults above. */
  readonly assetShocksBps?: ReadonlyMap<string, number>;
  /** Interest accrued on every debt, bps of principal (rounded up). */
  readonly debtInterestBps?: number;
}

function shockedPrice(price: UnitPrice, shockBps: number): UnitPrice {
  if (!Number.isInteger(shockBps) || shockBps < -10_000)
    throw new RangeError(`shock ${shockBps} bps is below -100% or not an integer`);
  // Exact: multiply the multiplier and add 4 decimals instead of dividing by 10000 (no rounding at all).
  return { multiplier: price.multiplier * BigInt(10_000 + shockBps), decimals: price.decimals + 4 };
}

/** Applies a scenario and returns a new model. Inputs are never mutated. */
export function applyScenario(model: LendingModel, scenario: Scenario): LendingModel {
  const interest = scenario.debtInterestBps ?? 0;
  if (!Number.isInteger(interest) || interest < 0)
    throw new RangeError('debtInterestBps must be a non-negative integer');
  return {
    collateral: model.collateral.map((c) => ({
      ...c,
      price: shockedPrice(
        c.price,
        scenario.assetShocksBps?.get(c.id) ?? scenario.collateralShockBps ?? 0,
      ),
    })),
    debt: model.debt.map((d) => ({
      ...d,
      amount: divRound(d.amount * (BPS + BigInt(interest)), BPS, 'ceil'),
      price: shockedPrice(
        d.price,
        scenario.assetShocksBps?.get(d.id) ?? scenario.debtShockBps ?? 0,
      ),
    })),
  };
}

export type RiskStatus = 'no-debt' | 'liquidatable' | 'danger' | 'watch' | 'healthy';

export interface RiskBands {
  /** HF below this (but >= 1) is "danger". */
  readonly dangerBelowWad: bigint;
  /** HF below this is "watch". */
  readonly watchBelowWad: bigint;
}

/** POLICY DEFAULTS, not protocol facts: operators should set their own. */
export const DEFAULT_RISK_BANDS: RiskBands = {
  dangerBelowWad: (WAD * 110n) / 100n,
  watchBelowWad: (WAD * 150n) / 100n,
};

export function classifyRisk(
  assessment: LendingAssessment,
  bands: RiskBands = DEFAULT_RISK_BANDS,
): RiskStatus {
  if (bands.dangerBelowWad > bands.watchBelowWad)
    throw new RangeError('dangerBelow must not exceed watchBelow');
  if (assessment.healthFactorWad === null) return 'no-debt';
  if (assessment.liquidatable) return 'liquidatable';
  if (assessment.healthFactorWad < bands.dangerBelowWad) return 'danger';
  if (assessment.healthFactorWad < bands.watchBelowWad) return 'watch';
  return 'healthy';
}

export interface StressResult {
  readonly scenario: Scenario;
  readonly assessment: LendingAssessment;
  readonly status: RiskStatus;
}

export const DEFAULT_COLLATERAL_STRESS: readonly Scenario[] = [
  { name: 'collateral -10%', collateralShockBps: -1_000 },
  { name: 'collateral -20%', collateralShockBps: -2_000 },
  { name: 'collateral -30%', collateralShockBps: -3_000 },
  { name: 'collateral -50%', collateralShockBps: -5_000 },
  { name: 'debt +25%', debtShockBps: 2_500 },
  { name: 'collateral -30% and debt +10%', collateralShockBps: -3_000, debtShockBps: 1_000 },
];

export function stressTest(
  model: LendingModel,
  scenarios: readonly Scenario[],
  bands: RiskBands = DEFAULT_RISK_BANDS,
): StressResult[] {
  return scenarios.map((scenario) => {
    const assessment = assessLendingPosition(applyScenario(model, scenario));
    return { scenario, assessment, status: classifyRisk(assessment, bands) };
  });
}

// ----------------------------------------------------------------------------------------------------------
// Distance to liquidation
// ----------------------------------------------------------------------------------------------------------

export type LiquidationBuffer =
  | { readonly kind: 'no-debt' }
  | { readonly kind: 'liquidatable' }
  | { readonly kind: 'buffer'; readonly bps: number; readonly capped: boolean };

/** Largest integer-bps move, found by exact search over the real (rounded) assessment, so it is self-consistent. */
function largestSafeShock(
  model: LendingModel,
  make: (bps: number) => Scenario,
  maxBps: number,
): LiquidationBuffer {
  const base = assessLendingPosition(model);
  if (base.healthFactorWad === null) return { kind: 'no-debt' };
  if (base.liquidatable) return { kind: 'liquidatable' };
  const safe = (bps: number): boolean =>
    !assessLendingPosition(applyScenario(model, make(bps))).liquidatable;
  if (safe(maxBps)) return { kind: 'buffer', bps: maxBps, capped: true };
  let lo = 0; // safe
  let hi = maxBps; // unsafe
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (safe(mid)) lo = mid;
    else hi = mid;
  }
  return { kind: 'buffer', bps: lo, capped: false };
}

/** Largest uniform fall of every collateral price (bps) that leaves the position not liquidatable. */
export function collateralDropBuffer(model: LendingModel): LiquidationBuffer {
  return largestSafeShock(model, (bps) => ({ name: 'drop', collateralShockBps: -bps }), 10_000);
}

/** Largest uniform rise of every debt price (bps) that leaves the position not liquidatable. Capped at +1000x. */
export function debtRiseBuffer(model: LendingModel): LiquidationBuffer {
  return largestSafeShock(model, (bps) => ({ name: 'rise', debtShockBps: bps }), 10_000_000);
}

export type LiquidationPrice =
  | {
      readonly kind: 'price';
      readonly multiplier: bigint;
      readonly decimals: number;
      readonly moveToLiquidationBps: bigint;
    }
  | { readonly kind: 'already-liquidatable' }
  | { readonly kind: 'never' }
  | { readonly kind: 'no-debt' };

/**
 * The price (same `decimals` as today's oracle price) at which ONE asset's move alone makes the position
 * liquidatable, other prices held fixed. For collateral it is the smallest safe multiplier; for debt, the largest.
 * `moveToLiquidationBps` is how far the price must move from today (fall for collateral, rise for debt), rounded up.
 * Resolution is one unit of the multiplier.
 */
export function liquidationPrice(
  model: LendingModel,
  side: 'collateral' | 'debt',
  assetId: string,
): LiquidationPrice {
  const base = assessLendingPosition(model);
  if (base.healthFactorWad === null) return { kind: 'no-debt' };
  if (base.liquidatable) return { kind: 'already-liquidatable' };
  const asset = (side === 'collateral' ? model.collateral : model.debt).find(
    (a) => a.id === assetId,
  );
  if (!asset) throw new RangeError(`unknown ${side} asset ${assetId}`);
  const current = asset.price.multiplier;
  if (current === 0n) throw new RangeError('current price is zero');

  const withMultiplier = (m: bigint): LendingModel => {
    const price = { multiplier: m, decimals: asset.price.decimals };
    return side === 'collateral'
      ? {
          ...model,
          collateral: model.collateral.map((c) => (c.id === assetId ? { ...c, price } : c)),
        }
      : { ...model, debt: model.debt.map((d) => (d.id === assetId ? { ...d, price } : d)) };
  };
  const safe = (m: bigint): boolean => !assessLendingPosition(withMultiplier(m)).liquidatable;

  if (side === 'collateral') {
    if (safe(0n)) return { kind: 'never' }; // other collateral alone covers the debt
    let lo = 0n; // unsafe
    let hi = current; // safe
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (safe(mid)) hi = mid;
      else lo = mid;
    }
    return {
      kind: 'price',
      multiplier: hi,
      decimals: asset.price.decimals,
      moveToLiquidationBps: divRound((current - hi) * BPS, current, 'ceil'),
    };
  }
  let lo = current; // safe
  let hi = current * 10_000_000n; // assumed unsafe
  if (safe(hi)) return { kind: 'never' };
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (safe(mid)) lo = mid;
    else hi = mid;
  }
  return {
    kind: 'price',
    multiplier: lo,
    decimals: asset.price.decimals,
    moveToLiquidationBps: divRound((lo - current) * BPS, current, 'ceil'),
  };
}

// ----------------------------------------------------------------------------------------------------------
// Liquidation simulation
// ----------------------------------------------------------------------------------------------------------

export interface LiquidationOutcome {
  readonly repaidDebtAmount: bigint;
  readonly repaidUsd: bigint;
  readonly seizedCollateralAmount: bigint;
  readonly seizedUsd: bigint;
  /** seized - repaid: the value the borrower hands to the liquidator (the incentive), micro-USD. */
  readonly borrowerLossUsd: bigint;
  /** True if the borrower's collateral of that asset was exhausted before the full repay could be matched. */
  readonly collateralExhausted: boolean;
  readonly after: LendingModel;
  readonly assessmentAfter: LendingAssessment;
}

/**
 * One Aave-style liquidation call: a liquidator repays up to `closeFactorBps` of one debt asset and seizes one
 * collateral asset worth (1 + bonus) times what was repaid. Parameters are inputs because they are protocol- and
 * asset-specific. Throws if the position is not liquidatable.
 */
export function simulateLiquidation(
  model: LendingModel,
  args: { debtId: string; collateralId: string; closeFactorBps: number; bonusBps: number },
): LiquidationOutcome {
  assertBps(args.closeFactorBps, 'closeFactorBps');
  assertBps(args.bonusBps, 'bonusBps', 100_000);
  const before = assessLendingPosition(model);
  if (!before.liquidatable) throw new RangeError('position is not liquidatable');
  const debt = model.debt.find((d) => d.id === args.debtId);
  const col = model.collateral.find((c) => c.id === args.collateralId);
  if (!debt || !col) throw new RangeError('unknown debt or collateral asset');
  if (debt.price.multiplier === 0n || col.price.multiplier === 0n)
    throw new RangeError('zero price');

  let repay = (debt.amount * BigInt(args.closeFactorBps)) / BPS;
  const bonusFactor = BPS + BigInt(args.bonusBps);
  // Collateral needed for this repay (rounded up, favouring the liquidator = worst case for the borrower).
  const seizedValueFor = (r: bigint) =>
    divRound(usdValue(r, debt.price, 'floor') * bonusFactor, BPS, 'ceil');
  const rawForUsd = (usd: bigint, price: UnitPrice) =>
    divRound(usd * pow10(price.decimals), price.multiplier * USD_SCALE, 'ceil');
  let seizedAmount = rawForUsd(seizedValueFor(repay), col.price);
  let exhausted = false;
  if (seizedAmount > col.amount) {
    exhausted = true;
    seizedAmount = col.amount;
    // Repay only what the held collateral can cover: value held / (1 + bonus), rounded down.
    const heldUsd = usdValue(col.amount, col.price, 'floor');
    const repayUsd = divRound(heldUsd * BPS, bonusFactor, 'floor');
    repay = divRound(
      repayUsd * pow10(debt.price.decimals),
      debt.price.multiplier * USD_SCALE,
      'floor',
    );
  }
  const repaidUsd = usdValue(repay, debt.price, 'floor');
  const seizedUsd = usdValue(seizedAmount, col.price, 'floor');
  const after: LendingModel = {
    collateral: model.collateral.map((c) =>
      c.id === col.id ? { ...c, amount: c.amount - seizedAmount } : c,
    ),
    debt: model.debt.map((d) => (d.id === debt.id ? { ...d, amount: d.amount - repay } : d)),
  };
  return {
    repaidDebtAmount: repay,
    repaidUsd,
    seizedCollateralAmount: seizedAmount,
    seizedUsd,
    borrowerLossUsd: seizedUsd > repaidUsd ? seizedUsd - repaidUsd : 0n,
    collateralExhausted: exhausted,
    after,
    assessmentAfter: assessLendingPosition(after),
  };
}
