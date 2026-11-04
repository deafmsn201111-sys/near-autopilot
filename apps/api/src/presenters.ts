import {
  formatMicroUsd,
  type AssetBalance,
  type PolicyDto,
  type PortfolioDto,
  type PortfolioSnapshot,
  type ProposalDto,
  type RunDto,
  type TokenId,
} from '@near-autopilot/core';
import type { GuardianConfig } from '@near-autopilot/agents';
import { valuePortfolio, tokenValueUsd } from '@near-autopilot/financial-engine';
import type { PolicyConfig } from '@near-autopilot/policy-engine';
import type { ProposalRecord, RunRecord } from './repository';

/**
 * Display-only view. Wallet tokens without an oracle price are listed with `valueUsd: null` and
 * excluded from totals, so one unpriced token cannot blank the dashboard. (Policy and agents use
 * the strict valuation, which fails closed instead.) A lending position that cannot be priced
 * still throws: showing a wrong debt figure would be worse than showing an error.
 */
export function toPortfolioDto(snapshot: PortfolioSnapshot): PortfolioDto {
  const valuation = valuePortfolio({
    ...snapshot,
    walletBalances: snapshot.walletBalances.filter((b) => snapshot.prices.has(b.token)),
  });
  const holding = (b: AssetBalance) => ({
    token: b.token,
    symbol: snapshot.tokens.get(b.token as TokenId)?.symbol ?? b.token,
    decimals: snapshot.tokens.get(b.token as TokenId)?.decimals ?? 0,
    raw: b.raw.toString(),
    valueUsd: snapshot.prices.has(b.token)
      ? formatMicroUsd(tokenValueUsd(snapshot.prices, b.token, b.raw))
      : null,
  });
  return {
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
  };
}

export function toProposalDto(p: ProposalRecord): ProposalDto {
  return {
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

export function toRunDto(run: RunRecord & { proposalCount: number }): RunDto {
  return {
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    status: run.status,
    error: run.error,
    proposalCount: run.proposalCount,
  };
}

const usd2 = (n: number): string => n.toFixed(2).replace(/^(-?\d+)$/, '$1.00');

export function toPolicyDto(
  policy: PolicyConfig,
  guardian: GuardianConfig,
  executionMode: 'dry-run' | 'live',
): PolicyDto {
  return {
    enabled: policy.enabled,
    executionMode,
    maxActionUsd: usd2(policy.maxActionUsd),
    dailyLimitUsd: usd2(policy.dailyLimitUsd),
    approvalThresholdUsd: usd2(policy.approvalThresholdUsd),
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
