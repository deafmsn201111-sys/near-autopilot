import { describe, expect, it } from 'vitest';
import {
  accountId,
  portfolioDtoSchema,
  proposalDtoSchema,
  policyDtoSchema,
  runDtoSchema,
  type PortfolioSnapshot,
} from '@near-autopilot/core';
import { guardianConfigSchema } from '@near-autopilot/agents';
import { policyConfigSchema } from '@near-autopilot/policy-engine';
import { toPolicyDto, toPortfolioDto, toProposalDto, toRunDto } from '../src/presenters';

const ALICE = accountId('alice.near');
const WNEAR = accountId('wrap.near');
const USDT = accountId('usdt.tether-token.near');
const NOW = new Date('2026-11-03T12:00:00Z');

const snapshot: PortfolioSnapshot = {
  accountId: ALICE,
  takenAt: NOW,
  pricesAsOf: NOW,
  nativeBalance: 10n ** 24n,
  walletBalances: [
    { token: WNEAR, raw: 2n * 10n ** 24n },
    { token: USDT, raw: 5_000_000n },
  ],
  lending: null,
  prices: new Map([[WNEAR, { multiplier: 50_000n, decimals: 28 }]]),
  risk: new Map(),
  tokens: new Map([[WNEAR, { id: WNEAR, symbol: 'wNEAR', decimals: 24 }]]),
};

describe('presenters produce payloads that satisfy the shared wire contract', () => {
  it('portfolio', () => {
    const dto = toPortfolioDto(snapshot, { dataSource: 'simulation', network: 'mainnet' });
    expect(dto).toMatchObject({ dataSource: 'simulation', network: 'mainnet' });
    expect(portfolioDtoSchema.parse(dto)).toEqual(dto);
    expect(dto.walletValueUsd).toBe('10.00');
    expect(dto.healthFactor).toBeNull();
    expect(dto.wallet.find((h) => h.symbol === 'wNEAR')?.valueUsd).toBe('10.00');
    expect(dto.wallet.find((h) => h.token === USDT)?.valueUsd).toBeNull(); // no price => unknown, not zero
  });

  it('proposal and run', () => {
    const proposal = toProposalDto({
      dataSource: 'chain',
      network: 'mainnet',
      id: 'p1',
      runId: 'r1',
      accountId: ALICE,
      agentId: 'guardian',
      kind: 'lending.repay',
      summary: 's',
      reason: 'r',
      intent: {},
      valueUsdMicro: 20_000_000n,
      status: 'rejected',
      violations: [{ rule: 'x', message: 'm', severity: 'reject' }],
      planHash: null,
      executionMode: null,
      txHash: null,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(proposalDtoSchema.parse(proposal).valueUsd).toBe('20.00');
    expect(
      runDtoSchema.parse(
        toRunDto({
          dataSource: 'chain',
          network: 'mainnet',
          id: 'r1',
          accountId: ALICE,
          status: 'completed',
          startedAt: NOW,
          finishedAt: NOW,
          error: null,
          outcome: null,
          proposalCount: 1,
        }),
      ),
    ).toBeTruthy();
  });

  it('policy', () => {
    const policy = policyConfigSchema.parse({
      signerAccountId: ALICE,
      allowedContracts: [WNEAR],
      allowedRecipients: [WNEAR],
      allowedTokens: [WNEAR],
      maxActionUsd: 100,
      dailyLimitUsd: 500,
      approvalThresholdUsd: 75.5,
      maxSlippageBps: 100,
      maxOracleDeviationBps: 200,
    });
    const dto = toPolicyDto(
      policy,
      guardianConfigSchema.parse({ triggerHealthFactor: 1.3, targetHealthFactor: 1.6 }),
      {
        dataSource: 'chain',
        network: 'mainnet',
        executionMode: 'dry-run',
        engine: 'legacy',
        simulationPortfolio: null,
        marketData: 'none',
      },
    );
    expect(policyDtoSchema.parse(dto)).toEqual(dto);
    expect(dto.maxActionUsd).toBe('100.00');
    expect(dto.approvalThresholdUsd).toBe('75.50');
  });
});
