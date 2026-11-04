import { MissingPriceError, type TokenId, type UnitPrice } from '@near-autopilot/core';
import { pow10 } from './units';

/**
 * Burrow's own risk arithmetic, reproduced exactly from the contract (S: burrowland actions.rs
 * `compute_max_discount`, asset_config.rs `volatility_ratio`, big_decimal.rs `from_balance_price`):
 *
 *   value(balance)       = balance_inner * price.multiplier / 10^(price.decimals + extra_decimals)
 *   collateral_sum       = sum over COLLATERAL of  value * volatility_ratio / 10000
 *   borrowed_sum         = sum over BORROWED   of  value * 10000 / volatility_ratio
 *   liquidatable  <=>  there is debt AND borrowed_sum > collateral_sum        (equality is safe)
 *   max_discount         = (borrowed_sum - collateral_sum) / borrowed_sum / 2
 *   health factor        = collateral_sum / borrowed_sum                       (README: below 100% = liquidatable)
 *
 * Only COLLATERAL counts; merely supplied balances do not. All values are bigint USD scaled by 10^18, with
 * rounding that can only make a position look WORSE than it is (collateral rounds down, debt rounds up).
 * The contract uses 10^27 truncation, so results can differ from it by far less than 10^-15 USD.
 */

export const USD18 = 10n ** 18n;
const BPS = 10_000n;

export interface RiskAsset {
  readonly tokenId: TokenId;
  readonly extraDecimals: number;
  /** Basis points: weights collateral, divides debt. Must be > 0 for any borrowed asset. */
  readonly volatilityRatioBps: number;
}

export interface RiskBalance {
  readonly tokenId: TokenId;
  /** Burrow inner units (raw * 10^extraDecimals), exactly as `get_account` returns them. */
  readonly inner: bigint;
}

export interface RiskPosition {
  readonly collateral: readonly RiskBalance[];
  readonly borrowed: readonly RiskBalance[];
}

export type PriceTable = ReadonlyMap<TokenId, UnitPrice>;
export type RiskAssets = ReadonlyMap<TokenId, RiskAsset>;

export interface RiskLine {
  readonly tokenId: TokenId;
  readonly volatilityRatioBps: number;
  /** USD * 10^18 after any shock. */
  readonly valueUsd18: bigint;
  /** collateral: value*vr/10000 (down); debt: value*10000/vr (up). */
  readonly adjustedUsd18: bigint;
}

export interface RiskReport {
  readonly collateral: readonly RiskLine[];
  readonly borrowed: readonly RiskLine[];
  readonly collateralValueUsd18: bigint;
  readonly borrowedValueUsd18: bigint;
  readonly adjustedCollateralUsd18: bigint;
  readonly adjustedBorrowedUsd18: bigint;
  readonly hasDebt: boolean;
  /** floor(collateral_sum / borrowed_sum * 10000); null without debt. 10000 = exactly at the liquidation line. */
  readonly healthFactorBps: bigint | null;
  /** The contract's rule, evaluated exactly on the bigint sums (not on the rounded ratio). */
  readonly liquidatable: boolean;
  /** floor((borrowed_sum - collateral_sum) / borrowed_sum / 2 * 10000); 0 when not liquidatable. */
  readonly maxLiquidationDiscountBps: bigint;
  /** ceil(debt value / collateral value * 10000), unweighted. null when there is debt but no collateral. */
  readonly ltvBps: bigint | null;
  /**
   * The LTV at which THIS position (same assets, same relative sizes, same prices) becomes liquidatable:
   * floor(HF * LTV). null without debt or collateral.
   */
  readonly liquidationThresholdBps: bigint | null;
  /** Value-weighted average volatility ratio of the collateral, in bps. null without collateral. */
  readonly blendedCollateralFactorBps: bigint | null;
  /** collateral_sum - borrowed_sum (signed). Negative = liquidatable. */
  readonly headroomAdjustedUsd18: bigint;
  /** Largest uniform collateral price fall (bps) that still leaves the position not liquidatable. */
  readonly collateralDropToLiquidationBps: bigint | null;
  /** Largest uniform debt price rise (bps) that still leaves the position not liquidatable. */
  readonly debtRiseToLiquidationBps: bigint | null;
}

export interface StressScenario {
  readonly name: string;
  /** Price change applied to every collateral asset, in bps (-2000 = -20%). Default 0. */
  readonly collateralShockBps?: number;
  /** Price change applied to every borrowed asset, in bps. Default 0. Accrued interest can be modelled here. */
  readonly debtShockBps?: number;
  /** Per-token override of the two defaults above. */
  readonly tokenShocksBps?: ReadonlyMap<TokenId, number>;
}

export interface StressResult {
  readonly scenario: StressScenario;
  readonly report: RiskReport;
}

type ShockFn = (tokenId: TokenId, side: 'collateral' | 'borrowed') => number;
const noShock: ShockFn = () => 0;

function valueUsd18(
  inner: bigint,
  extraDecimals: number,
  price: UnitPrice,
  rounding: 'floor' | 'ceil',
): bigint {
  const numerator = inner * price.multiplier * USD18;
  const denominator = pow10(price.decimals + extraDecimals);
  const q = numerator / denominator;
  return rounding === 'ceil' && numerator % denominator !== 0n ? q + 1n : q;
}

function shocked(value: bigint, shockBps: number, rounding: 'floor' | 'ceil'): bigint {
  if (!Number.isInteger(shockBps) || shockBps < -10_000)
    throw new RangeError(`Invalid shock ${shockBps} bps (minimum is -10000)`);
  const numerator = value * (BPS + BigInt(shockBps));
  const q = numerator / BPS;
  return rounding === 'ceil' && numerator % BPS !== 0n ? q + 1n : q;
}

function assetOf(assets: RiskAssets, tokenId: TokenId): RiskAsset {
  const asset = assets.get(tokenId);
  if (!asset) throw new MissingPriceError(`${tokenId} (Burrow asset parameters)`);
  return asset;
}

function priceOf(prices: PriceTable, tokenId: TokenId): UnitPrice {
  const price = prices.get(tokenId);
  if (!price || price.multiplier <= 0n) throw new MissingPriceError(tokenId);
  return price;
}

function evaluate(
  position: RiskPosition,
  assets: RiskAssets,
  prices: PriceTable,
  shock: ShockFn,
): RiskReport {
  const collateral: RiskLine[] = [];
  for (const b of position.collateral) {
    if (b.inner <= 0n) continue;
    const a = assetOf(assets, b.tokenId);
    const value = shocked(
      valueUsd18(b.inner, a.extraDecimals, priceOf(prices, b.tokenId), 'floor'),
      shock(b.tokenId, 'collateral'),
      'floor',
    );
    collateral.push({
      tokenId: b.tokenId,
      volatilityRatioBps: a.volatilityRatioBps,
      valueUsd18: value,
      adjustedUsd18: (value * BigInt(a.volatilityRatioBps)) / BPS,
    });
  }
  const borrowed: RiskLine[] = [];
  for (const b of position.borrowed) {
    if (b.inner <= 0n) continue;
    const a = assetOf(assets, b.tokenId);
    if (a.volatilityRatioBps <= 0)
      throw new RangeError(`volatility ratio of borrowed asset ${b.tokenId} must be > 0`);
    const value = shocked(
      valueUsd18(b.inner, a.extraDecimals, priceOf(prices, b.tokenId), 'ceil'),
      shock(b.tokenId, 'borrowed'),
      'ceil',
    );
    const vr = BigInt(a.volatilityRatioBps);
    borrowed.push({
      tokenId: b.tokenId,
      volatilityRatioBps: a.volatilityRatioBps,
      valueUsd18: value,
      adjustedUsd18: (value * BPS + vr - 1n) / vr,
    });
  }

  const sum = (lines: readonly RiskLine[], f: (l: RiskLine) => bigint) =>
    lines.reduce((t, l) => t + f(l), 0n);
  const collateralValue = sum(collateral, (l) => l.valueUsd18);
  const borrowedValue = sum(borrowed, (l) => l.valueUsd18);
  const adjCollateral = sum(collateral, (l) => l.adjustedUsd18);
  const adjBorrowed = sum(borrowed, (l) => l.adjustedUsd18);
  const hasDebt = borrowed.length > 0;
  const liquidatable = hasDebt && adjBorrowed > adjCollateral;
  const headroom = adjCollateral - adjBorrowed;

  return {
    collateral,
    borrowed,
    collateralValueUsd18: collateralValue,
    borrowedValueUsd18: borrowedValue,
    adjustedCollateralUsd18: adjCollateral,
    adjustedBorrowedUsd18: adjBorrowed,
    hasDebt,
    healthFactorBps: hasDebt ? (adjCollateral * BPS) / adjBorrowed : null,
    liquidatable,
    maxLiquidationDiscountBps: liquidatable
      ? ((adjBorrowed - adjCollateral) * BPS) / adjBorrowed / 2n
      : 0n,
    ltvBps: !hasDebt
      ? 0n
      : collateralValue === 0n
        ? null
        : (borrowedValue * BPS + collateralValue - 1n) / collateralValue,
    liquidationThresholdBps:
      hasDebt && collateralValue > 0n
        ? (adjCollateral * borrowedValue * BPS) / (adjBorrowed * collateralValue)
        : null,
    blendedCollateralFactorBps:
      collateralValue > 0n ? (adjCollateral * BPS) / collateralValue : null,
    headroomAdjustedUsd18: headroom,
    collateralDropToLiquidationBps: !hasDebt
      ? null
      : headroom <= 0n || adjCollateral === 0n
        ? 0n
        : (headroom * BPS) / adjCollateral,
    debtRiseToLiquidationBps: !hasDebt
      ? null
      : headroom <= 0n
        ? 0n
        : (headroom * BPS) / adjBorrowed,
  };
}

/** Current risk metrics. Throws `MissingPriceError` for any priced asset without a price or parameters (fail closed). */
export function computeRisk(
  position: RiskPosition,
  assets: RiskAssets,
  prices: PriceTable,
): RiskReport {
  return evaluate(position, assets, prices, noShock);
}

/** Re-evaluates the position under each scenario. Never mutates inputs; every scenario is independent. */
export function runStressScenarios(
  position: RiskPosition,
  assets: RiskAssets,
  prices: PriceTable,
  scenarios: readonly StressScenario[],
): StressResult[] {
  return scenarios.map((scenario) => ({
    scenario,
    report: evaluate(position, assets, prices, (token, side) => {
      const override = scenario.tokenShocksBps?.get(token);
      if (override !== undefined) return override;
      return (side === 'collateral' ? scenario.collateralShockBps : scenario.debtShockBps) ?? 0;
    }),
  }));
}

export const DEFAULT_STRESS_SCENARIOS: readonly StressScenario[] = [
  { name: 'collateral -10%', collateralShockBps: -1_000 },
  { name: 'collateral -20%', collateralShockBps: -2_000 },
  { name: 'collateral -30%', collateralShockBps: -3_000 },
  { name: 'collateral -50%', collateralShockBps: -5_000 },
  { name: 'debt +10%', debtShockBps: 1_000 },
  { name: 'debt +25%', debtShockBps: 2_500 },
  { name: 'collateral -20% and debt +10%', collateralShockBps: -2_000, debtShockBps: 1_000 },
];

/**
 * The largest single-asset price move, in bps, that still leaves the position NOT liquidatable
 * (a fall for a collateral token, a rise for a debt token). `null` means no move of that asset alone can
 * cause liquidation (a collateral price cannot fall below zero; or the asset is not in the position).
 * Already-liquidatable positions return 0n. Closed form from the contract's linear sums.
 */
export function breakevenMoveBps(
  position: RiskPosition,
  assets: RiskAssets,
  prices: PriceTable,
  tokenId: TokenId,
  side: 'collateral' | 'borrowed',
): bigint | null {
  const report = computeRisk(position, assets, prices);
  if (!report.hasDebt) return null;
  if (report.headroomAdjustedUsd18 <= 0n) return 0n;
  const lines = side === 'collateral' ? report.collateral : report.borrowed;
  const adjusted = lines
    .filter((l) => l.tokenId === tokenId)
    .reduce((t, l) => t + l.adjustedUsd18, 0n);
  if (adjusted === 0n) return null;
  const move = (report.headroomAdjustedUsd18 * BPS) / adjusted;
  if (side === 'collateral' && move >= BPS) return null; // even a total loss of this asset keeps the position safe
  return move;
}
