import type { PortfolioSnapshot, TokenId } from '@near-autopilot/core';
import {
  DEFAULT_COLLATERAL_STRESS,
  WAD,
  assessLendingPosition,
  classifyRisk,
  stressTest,
  type LendingAssessment,
  type LendingModel,
  type RiskBands,
} from '@near-autopilot/financial-engine';
import type { OrchestratorConfig } from './config';
import type { RiskLevel, RiskState } from './types';

/**
 * Snapshot -> generic lending model. Burrow's collateral factor plays the role of the liquidation threshold and its
 * borrow factor divides debt (see financial-engine/src/risk.ts). Returns the tokens it could not price instead of
 * guessing: a position that cannot be valued is "unknown", never "healthy".
 */
export function buildLendingModel(
  snapshot: PortfolioSnapshot,
): { ok: true; model: LendingModel } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const collateral: LendingModel['collateral'][number][] = [];
  const debt: LendingModel['debt'][number][] = [];
  for (const c of snapshot.lending?.collateral ?? []) {
    if (c.raw <= 0n) continue;
    const price = snapshot.prices.get(c.token);
    const risk = snapshot.risk.get(c.token);
    if (!price) missing.push(`price:${c.token}`);
    if (!risk) missing.push(`risk:${c.token}`);
    if (price && risk)
      collateral.push({
        id: c.token,
        amount: c.raw,
        price,
        liquidationThresholdBps: risk.collateralFactorBps,
      });
  }
  for (const d of snapshot.lending?.borrowed ?? []) {
    if (d.raw <= 0n) continue;
    const price = snapshot.prices.get(d.token);
    const risk = snapshot.risk.get(d.token);
    if (!price) missing.push(`price:${d.token}`);
    if (!risk) missing.push(`risk:${d.token}`);
    if (price && risk)
      debt.push({ id: d.token, amount: d.raw, price, borrowFactorBps: risk.borrowFactorBps });
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, model: { collateral, debt } };
}

export const bandsFromConfig = (config: OrchestratorConfig): RiskBands => ({
  dangerBelowWad: BigInt(config.risk.dangerBelowBps) * 10n ** 14n,
  watchBelowWad: BigInt(config.risk.watchBelowBps) * 10n ** 14n,
});

function levelOf(assessment: LendingAssessment, config: OrchestratorConfig): RiskLevel {
  const status = classifyRisk(assessment, bandsFromConfig(config));
  switch (status) {
    case 'no-debt':
      return 'none';
    case 'healthy':
      return 'healthy';
    case 'watch':
      return 'watch';
    case 'liquidatable':
      return 'liquidatable';
    case 'danger': {
      const critical = BigInt(config.risk.criticalBelowBps) * 10n ** 14n;
      return assessment.healthFactorWad !== null && assessment.healthFactorWad < critical
        ? 'critical'
        : 'danger';
    }
  }
}

export function assessRisk(snapshot: PortfolioSnapshot, config: OrchestratorConfig): RiskState {
  const empty = {
    healthFactorWad: null,
    ltvBps: null,
    collateralUsdMicro: 0n,
    debtUsdMicro: 0n,
    stress: [],
  } as const;
  if ((snapshot.lending?.borrowed ?? []).every((b) => b.raw <= 0n))
    return { level: 'none', ...empty, note: null };
  const built = buildLendingModel(snapshot);
  if (!built.ok)
    return {
      level: 'unknown',
      ...empty,
      note: `cannot value position: missing ${built.missing.join(', ')}`,
    };
  const a = assessLendingPosition(built.model);
  const bands = bandsFromConfig(config);
  return {
    level: levelOf(a, config),
    healthFactorWad: a.healthFactorWad,
    ltvBps: a.ltvBps,
    collateralUsdMicro: a.collateralUsd,
    debtUsdMicro: a.debtUsd,
    stress: stressTest(built.model, DEFAULT_COLLATERAL_STRESS, bands).map((s) => ({
      scenario: s.scenario.name,
      healthFactorWad: s.assessment.healthFactorWad,
      status: s.status,
    })),
    note: null,
  };
}

/* ------------------------------ hypothetical actions ------------------------------ */

export function afterRepay(model: LendingModel, token: TokenId, amount: bigint): LendingModel {
  return {
    ...model,
    debt: model.debt.map((d) =>
      d.id === token ? { ...d, amount: d.amount > amount ? d.amount - amount : 0n } : d,
    ),
  };
}

export function afterSupply(
  model: LendingModel,
  snapshot: PortfolioSnapshot,
  token: TokenId,
  amount: bigint,
): LendingModel | null {
  const price = snapshot.prices.get(token);
  const risk = snapshot.risk.get(token);
  if (!price || !risk || !risk.canBeCollateral) return null;
  const exists = model.collateral.some((c) => c.id === token);
  return {
    ...model,
    collateral: exists
      ? model.collateral.map((c) => (c.id === token ? { ...c, amount: c.amount + amount } : c))
      : [
          ...model.collateral,
          { id: token, amount, price, liquidationThresholdBps: risk.collateralFactorBps },
        ],
  };
}

/** HF with "no debt" treated as infinitely healthy so comparisons stay total. */
export const hfOrInfinity = (hf: bigint | null): bigint => (hf === null ? 1n << 255n : hf);

/**
 * Smallest amount in [1, max] whose application reaches `targetHfWad`, found by bisection on the exact
 * (monotone) health factor. If even `max` falls short, returns `max` (partial improvement beats none).
 */
export function smallestAmountReaching(
  max: bigint,
  targetHfWad: bigint,
  hfAfter: (amount: bigint) => bigint | null,
): bigint {
  if (max <= 0n) return 0n;
  if (hfOrInfinity(hfAfter(max)) < targetHfWad) return max;
  let lo = 0n; // does not reach
  let hi = max; // reaches
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (hfOrInfinity(hfAfter(mid)) >= targetHfWad) hi = mid;
    else lo = mid;
  }
  return hi;
}

export const targetHfWad = (config: OrchestratorConfig): bigint =>
  BigInt(config.risk.targetHealthFactorBps) * 10n ** 14n;
export { WAD };
