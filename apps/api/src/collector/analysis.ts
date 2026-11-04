import type { BurrowAsset } from '@near-autopilot/burrow-adapter';
import { formatDecimal, type Decimal } from '../market-data/decimal';
import type { DemoPortfolio } from '../simulation/demo-portfolios';
import { burrowEstimates, type YieldLimits } from '../yield/burrow';
import { fromRaw, toWad } from '../yield/math';
import type { BlockRef, YieldEstimate } from '../yield/model';
import type { LpSimResult } from './lp';
import type { TokenPrice } from './model';

const num = (d: Decimal | null | undefined): number | null => (d ? Number(toWad(d)) / 1e18 : null);
const text = (d: Decimal | null | undefined): string | null => (d ? formatDecimal(d) : null);

/* ------------------------------ Burrow markets (all of them) ------------------------------ */

export interface BurrowMarketView {
  readonly token: string;
  readonly status: 'OK' | 'LOW_CONFIDENCE' | 'DATA_INVALID' | 'UNPRICED';
  readonly inExecutionAllowlist: boolean;
  readonly supplyApr: string | null;
  readonly borrowApr: string | null;
  /** Valid base reward APR on supplying (no booster); null when no confirmed programme. */
  readonly rewardApr: string | null;
  /** supply APR + confirmed reward APR. */
  readonly netSupplyApr: string | null;
  readonly utilization: string | null;
  readonly availableUsd: string | null;
  /** Burrow `volatility_ratio`: collateral is weighted by it and debt divided by it in the health factor. */
  readonly collateralFactor: number;
  readonly reserveRatio: number;
  readonly canDeposit: boolean;
  readonly canWithdraw: boolean;
  readonly canBorrow: boolean;
  readonly canUseAsCollateral: boolean;
  readonly suppliedLimitInner: string | null;
  readonly borrowedLimitInner: string | null;
  readonly activeRewardProgrammes: number;
  readonly risk: readonly string[];
  readonly reasons: readonly { code: string; detail: string }[];
  readonly note: string;
}

const LIQUIDATION_NOTE =
  'Burrow has no separate liquidation threshold: an account is liquidatable when its health factor (collateral x volatility_ratio / debt / volatility_ratio) falls below 1';

export function burrowMarkets(input: {
  readonly contract: string;
  readonly assets: readonly BurrowAsset[];
  readonly block: BlockRef;
  readonly now: Date;
  readonly decimals: ReadonlyMap<string, number | null>;
  readonly prices: ReadonlyMap<string, TokenPrice>;
  readonly allowlist: ReadonlySet<string>;
  readonly limits: YieldLimits;
}): { markets: BurrowMarketView[]; estimates: YieldEstimate[] } {
  // Analytics view: every market is evaluated (allowedTokens = all); the execution allowlist is reported separately.
  const okPrice = (t: string) => {
    const p = input.prices.get(t);
    return p && p.quality === 'OK' ? p.usd : null;
  };
  const estimates = burrowEstimates({
    network: 'mainnet',
    contract: input.contract,
    assets: input.assets,
    block: input.block,
    now: input.now,
    decimals: input.decimals,
    priceUsd: okPrice,
    allowedTokens: new Set(input.assets.map((a) => a.tokenId)),
    limits: input.limits,
  });
  const markets = input.assets.map((a): BurrowMarketView => {
    const mine = estimates.filter(
      (e) => e.marketId === a.tokenId || e.marketId.startsWith(`${a.tokenId}#`),
    );
    const supply = mine.find((e) => e.yieldType === 'lending_supply');
    const borrow = mine.find((e) => e.yieldType === 'lending_borrow');
    const rewards = mine.filter((e) => e.yieldType === 'lending_reward');
    const validRewards = rewards.filter((e) => e.validationStatus === 'valid' && e.apr);
    const rewardApr = validRewards.reduce((s, e) => s + (num(e.apr) ?? 0), 0);
    const supplyApr = num(supply?.apr);
    const risk: string[] = [];
    const util = num(supply?.utilization);
    if (util !== null && util >= input.limits.maxUtilizationBps / 10_000)
      risk.push('HIGH_UTILIZATION: withdrawals may be blocked');
    if (!a.canWithdraw) risk.push('WITHDRAW_DISABLED');
    if (!a.canDeposit) risk.push('DEPOSIT_DISABLED');
    const priced = input.prices.get(a.tokenId);
    const status: BurrowMarketView['status'] = !priced
      ? 'UNPRICED'
      : priced.quality !== 'OK'
        ? 'LOW_CONFIDENCE'
        : supply?.validationStatus === 'valid'
          ? 'OK'
          : 'DATA_INVALID';
    return {
      token: a.tokenId,
      status,
      inExecutionAllowlist: input.allowlist.has(a.tokenId),
      supplyApr: text(supply?.apr),
      borrowApr: text(borrow?.apr),
      rewardApr: validRewards.length > 0 ? rewardApr.toFixed(18) : null,
      netSupplyApr:
        supplyApr === null
          ? null
          : (supplyApr + (validRewards.length > 0 ? rewardApr : 0)).toFixed(18),
      utilization: text(supply?.utilization),
      availableUsd: text(supply?.liquidityUsd),
      collateralFactor: a.volatilityRatioBps / 10_000,
      reserveRatio: a.reserveRatioBps / 10_000,
      canDeposit: a.canDeposit,
      canWithdraw: a.canWithdraw,
      canBorrow: a.canBorrow,
      canUseAsCollateral: a.canUseAsCollateral,
      suppliedLimitInner: a.suppliedLimitInner?.toString() ?? null,
      borrowedLimitInner: a.borrowedLimitInner?.toString() ?? null,
      activeRewardProgrammes: a.supplyFarms.filter((f) => f.remainingRewards > 0n).length,
      risk,
      reasons: [...(supply?.reasons ?? []), ...rewards.flatMap((e) => e.reasons)],
      note: LIQUIDATION_NOTE,
    };
  });
  return { markets, estimates };
}

/* ------------------------------ strategy comparison (per demo portfolio) ------------------------------ */

export interface StrategyRow {
  readonly strategy:
    'HOLD' | 'CURRENT_STRUCTURE' | 'BURROW_SUPPLY_AS_IS' | 'BURROW_SUPPLY_BEST' | 'RHEA_LP_BEST';
  readonly label: string;
  readonly capitalUsd: number;
  readonly horizonDays: number;
  readonly grossReturnUsd: number | null;
  readonly feesUsd: number;
  readonly rewardsUsd: number;
  readonly impermanentLossUsd: number;
  readonly gasUsd: number;
  readonly slippageUsd: number;
  readonly netReturnUsd: number | null;
  readonly liquidityRisk: string;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  readonly basis: string;
  readonly reasonCodes: readonly string[];
}

export interface StrategyInput {
  readonly portfolio: DemoPortfolio;
  readonly tokens: { readonly near: string; readonly usdt: string };
  readonly prices: ReadonlyMap<string, TokenPrice>;
  readonly markets: readonly BurrowMarketView[];
  readonly capitalUsd: number;
  readonly horizonDays: number;
  readonly gasUsdPerTx: number;
  /** Cost of swapping `capitalUsd` of wNEAR into the best stable through an allowlisted pool, if computable. */
  readonly swapToBest: {
    readonly token: string;
    readonly costUsd: number;
    readonly pool: string;
  } | null;
  readonly bestLp: LpSimResult | null;
}

/** Hold / current structure / Burrow supply / Rhea LP on the same capital, horizon and market snapshot. */
export function compareStrategies(i: StrategyInput): StrategyRow[] {
  const H = i.horizonDays / 365;
  const apr = (t: string, field: 'supplyApr' | 'borrowApr' | 'netSupplyApr') => {
    const m = i.markets.find((x) => x.token === t);
    const v = m?.[field];
    return m && m.status === 'OK' && v !== null && v !== undefined ? Number(v) : null;
  };
  const price = (t: string) => {
    const p = i.prices.get(t);
    return p && p.quality === 'OK' ? Number(toWad(p.usd)) / 1e18 : null;
  };
  const pNear = price(i.tokens.near);
  const pUsdt = price(i.tokens.usdt);
  const rows: StrategyRow[] = [
    {
      strategy: 'HOLD',
      label: 'Hold the capital as it is (no yield, price exposure only)',
      capitalUsd: i.capitalUsd,
      horizonDays: i.horizonDays,
      grossReturnUsd: 0,
      feesUsd: 0,
      rewardsUsd: 0,
      impermanentLossUsd: 0,
      gasUsd: 0,
      slippageUsd: 0,
      netReturnUsd: 0,
      liquidityRisk: 'none',
      confidence: 'HIGH',
      basis: 'no action',
      reasonCodes: [],
    },
  ];
  // Current structure: the demo Burrow position's carry (collateral earns supply APR, debt pays borrow APR).
  const cNear = num(fromRaw(i.portfolio.collateral.near, 24));
  const dUsdt = num(fromRaw(i.portfolio.borrowed.usdt, 6));
  const sUsdt = num(fromRaw(i.portfolio.supplied.usdt, 6));
  const supNear = apr(i.tokens.near, 'supplyApr');
  const supUsdt = apr(i.tokens.usdt, 'supplyApr');
  const borUsdt = apr(i.tokens.usdt, 'borrowApr');
  const carryOk =
    pNear !== null && pUsdt !== null && supNear !== null && supUsdt !== null && borUsdt !== null;
  rows.push({
    strategy: 'CURRENT_STRUCTURE',
    label: 'Current structure: keep the Burrow position (collateral carry minus debt cost)',
    capitalUsd: i.capitalUsd,
    horizonDays: i.horizonDays,
    grossReturnUsd: carryOk
      ? ((cNear ?? 0) * (pNear ?? 0) * (supNear ?? 0) +
          (sUsdt ?? 0) * (pUsdt ?? 0) * (supUsdt ?? 0)) *
        H
      : null,
    feesUsd: 0,
    rewardsUsd: 0,
    impermanentLossUsd: 0,
    gasUsd: 0,
    slippageUsd: 0,
    netReturnUsd: carryOk
      ? ((cNear ?? 0) * (pNear ?? 0) * (supNear ?? 0) +
          (sUsdt ?? 0) * (pUsdt ?? 0) * (supUsdt ?? 0) -
          (dUsdt ?? 0) * (pUsdt ?? 0) * (borUsdt ?? 0)) *
        H
      : null,
    liquidityRisk: 'liquidation risk of the existing loan (see Guardian)',
    confidence: carryOk ? 'MEDIUM' : null,
    basis: 'whole demo Burrow position, not the comparison capital; current APRs held constant',
    reasonCodes: carryOk ? [] : ['INSUFFICIENT_DATA'],
  });
  const nearApr = apr(i.tokens.near, 'netSupplyApr');
  rows.push({
    strategy: 'BURROW_SUPPLY_AS_IS',
    label: 'Supply the capital to Burrow in wNEAR (no swap)',
    capitalUsd: i.capitalUsd,
    horizonDays: i.horizonDays,
    grossReturnUsd: nearApr === null ? null : i.capitalUsd * nearApr * H,
    feesUsd: 0,
    rewardsUsd: 0,
    impermanentLossUsd: 0,
    gasUsd: 2 * i.gasUsdPerTx,
    slippageUsd: 0,
    netReturnUsd: nearApr === null ? null : i.capitalUsd * nearApr * H - 2 * i.gasUsdPerTx,
    liquidityRisk: 'Burrow utilisation (see market)',
    confidence: nearApr === null ? null : 'MEDIUM',
    basis: 'current supply APR held constant; simple (not compounded)',
    reasonCodes: nearApr === null ? ['INSUFFICIENT_DATA'] : [],
  });
  const best = i.swapToBest;
  const bestApr = best ? apr(best.token, 'netSupplyApr') : null;
  rows.push({
    strategy: 'BURROW_SUPPLY_BEST',
    label: best
      ? `Swap wNEAR to ${best.token.slice(0, 12)}… via ${best.pool}, supply to Burrow`
      : 'Swap to best stable and supply',
    capitalUsd: i.capitalUsd,
    horizonDays: i.horizonDays,
    grossReturnUsd: bestApr === null ? null : i.capitalUsd * bestApr * H,
    feesUsd: 0,
    rewardsUsd: 0,
    impermanentLossUsd: 0,
    gasUsd: 3 * i.gasUsdPerTx,
    slippageUsd: best?.costUsd ?? 0,
    netReturnUsd:
      bestApr === null || !best
        ? null
        : i.capitalUsd * bestApr * H - best.costUsd - 3 * i.gasUsdPerTx,
    liquidityRisk: 'Burrow utilisation; stablecoin peg',
    confidence: bestApr === null ? null : 'MEDIUM',
    basis:
      'swap cost from the allowlisted pool reserves (fee + impact vs reference price); current supply APR',
    reasonCodes: bestApr === null ? ['INSUFFICIENT_DATA'] : [],
  });
  const lp = i.bestLp;
  rows.push({
    strategy: 'RHEA_LP_BEST',
    label: lp && lp.status === 'OK' ? `Best Rhea LP entry: ${lp.poolKey}` : 'Best Rhea LP entry',
    capitalUsd: i.capitalUsd,
    horizonDays: i.horizonDays,
    grossReturnUsd: lp?.expectedFeesUsd ? Number(lp.expectedFeesUsd) : null,
    feesUsd: lp?.expectedFeesUsd ? Number(lp.expectedFeesUsd) : 0,
    rewardsUsd: 0,
    impermanentLossUsd: lp?.impermanentLossUsd ? Number(lp.impermanentLossUsd) : 0,
    gasUsd: lp?.gasUsd ? Number(lp.gasUsd) : 0,
    slippageUsd: lp ? Number(lp.entryCostUsd ?? 0) + Number(lp.exitCostUsd ?? 0) : 0,
    netReturnUsd: lp?.netReturnUsd ? Number(lp.netReturnUsd) : null,
    liquidityRisk: lp?.risks.join('; ') || 'see pool',
    confidence: lp?.confidence ?? null,
    basis: lp?.window
      ? `fees: realised ${lp.window} window, extrapolated linearly (NOT a forecast)`
      : 'no LP_SIMULATION_ELIGIBLE pool with fee history',
    reasonCodes: lp && lp.status === 'OK' ? [] : ['INSUFFICIENT_DATA'],
  });
  return rows;
}
