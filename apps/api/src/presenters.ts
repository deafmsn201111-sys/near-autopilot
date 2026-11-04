import {
  formatMicroUsd,
  usdToMicro,
  type AssetBalance,
  type PolicyDto,
  type PortfolioDto,
  type PortfolioSnapshot,
  type ProposalDto,
  type Provenance,
  type RunDto,
} from '@near-autopilot/core';
import type { GuardianConfig } from '@near-autopilot/agents';
import { valuePortfolio, tokenValueUsd } from '@near-autopilot/financial-engine';
import type { PolicyConfig } from '@near-autopilot/policy-engine';
import type { ProposalRecord, RunRecord } from './repository';
import { pricingOf } from './services/outcome';

/**
 * Display-only view. Wallet tokens without an oracle price are listed with `valueUsd: null` and
 * excluded from totals, so one unpriced token cannot blank the dashboard. (Policy and agents use
 * the strict valuation, which fails closed instead.) A lending position that cannot be priced
 * still throws: showing a wrong debt figure would be worse than showing an error.
 */
export function toPortfolioDto(snapshot: PortfolioSnapshot, provenance: Provenance): PortfolioDto {
  const valuation = valuePortfolio({
    ...snapshot,
    walletBalances: snapshot.walletBalances.filter((b) => snapshot.prices.has(b.token)),
  });
  const holding = (b: AssetBalance) => ({
    token: b.token,
    symbol: snapshot.tokens.get(b.token)?.symbol ?? b.token,
    decimals: snapshot.tokens.get(b.token)?.decimals ?? 0,
    raw: b.raw.toString(),
    valueUsd: snapshot.prices.has(b.token)
      ? formatMicroUsd(tokenValueUsd(snapshot.prices, b.token, b.raw))
      : null,
  });
  return {
    ...provenance,
    accountId: snapshot.accountId,
    asOf: snapshot.takenAt.toISOString(),
    pricesAsOf: snapshot.pricesAsOf.toISOString(),
    nativeBalanceYocto: snapshot.nativeBalance.toString(),
    walletValueUsd: formatMicroUsd(valuation.walletUsd),
    suppliedValueUsd: formatMicroUsd(valuation.suppliedUsd + valuation.collateralUsd),
    borrowedValueUsd: formatMicroUsd(valuation.borrowedUsd),
    netValueUsd: formatMicroUsd(valuation.netUsd),
    healthFactor: valuation.healthFactor,
    wallet: snapshot.walletBalances.map(holding),
    collateral: (snapshot.lending?.collateral ?? []).map(holding),
    supplied: (snapshot.lending?.supplied ?? []).map(holding),
    borrowed: (snapshot.lending?.borrowed ?? []).map(holding),
    pricing: pricingOf(snapshot),
  };
}

export function toProposalDto(p: ProposalRecord & Provenance): ProposalDto {
  return {
    dataSource: p.dataSource,
    network: p.network,
    executionMode: p.executionMode,
    id: p.id,
    runId: p.runId,
    agentId: p.agentId,
    kind: p.kind,
    summary: p.summary,
    reason: p.reason,
    status: p.status,
    valueUsd: p.valueUsdMicro === null ? null : formatMicroUsd(p.valueUsdMicro),
    violations: p.violations.map((v) => ({ rule: v.rule, message: v.message })),
    txHash: p.txHash,
    error: p.error,
    createdAt: p.createdAt.toISOString(),
  };
}

export function toRunDto(run: RunRecord & Provenance & { proposalCount: number }): RunDto {
  return {
    dataSource: run.dataSource,
    network: run.network,
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    status: run.status,
    error: run.error,
    outcome: run.outcome,
    proposalCount: run.proposalCount,
  };
}

/** Exact: config USD -> micro-USD (schema-guaranteed representable) -> decimal string. */
const usd = (n: number): string => formatMicroUsd(usdToMicro(n));

export interface SystemInfo extends Provenance {
  readonly executionMode: 'dry-run' | 'live';
  readonly engine: 'legacy' | 'orchestrator';
  readonly simulationPortfolio: string | null;
  readonly marketData: 'none' | 'mainnet-reference' | 'mainnet-live';
}

export function toPolicyDto(
  policy: PolicyConfig,
  guardian: GuardianConfig,
  system: SystemInfo,
): PolicyDto {
  const { executionMode, ...rest } = system;
  return {
    ...rest,
    enabled: policy.enabled,
    executionMode,
    maxActionUsd: usd(policy.maxActionUsd),
    dailyLimitUsd: usd(policy.dailyLimitUsd),
    approvalThresholdUsd: usd(policy.approvalThresholdUsd),
    maxSlippageBps: policy.maxSlippageBps,
    maxOracleDeviationBps: policy.maxOracleDeviationBps,
    cooldownSeconds: policy.cooldownSeconds,
    allowedContracts: [...policy.allowedContracts],
    allowedTokens: [...policy.allowedTokens],
    guardian: {
      triggerHealthFactor: guardian.triggerHealthFactor,
      targetHealthFactor: guardian.targetHealthFactor,
    },
  };
}
