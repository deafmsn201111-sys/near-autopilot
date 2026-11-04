import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadApiEnv, type ApiEnv } from '@near-autopilot/config';
import { accountId, portfolioDtoSchema } from '@near-autopilot/core';
import { SilentLogger } from '@near-autopilot/core/testing';
import { parseAutopilotConfig } from '../src/autopilot-config';
import { toPortfolioDto } from '../src/presenters';
import { wire } from '../src/wiring';
import { InMemoryRepository } from './in-memory-repository';

/**
 * End to end, offline: the production composition root with DATA_SOURCE=simulation. Every adapter, the Burrow
 * deployment verifier, the planners, the policy engine and the dry-run executor are the real ones; only the NEAR RPC
 * is the in-process mock. Nothing here touches a network.
 */
const ACCOUNT = 'your-account.testnet';
const readConfig = (file: string) =>
  parseAutopilotConfig(
    JSON.parse(
      readFileSync(new URL(`../../../config/${file}`, import.meta.url), 'utf8'),
    ) as unknown,
    accountId(ACCOUNT),
  );
const testnetConfig = readConfig('autopilot.testnet.example.json');

const envFor = (over: Record<string, string>): ApiEnv =>
  loadApiEnv({
    API_TOKEN: 'test-token-test-token-test-token-test',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    AUTOPILOT_ACCOUNT_ID: ACCOUNT,
    NEAR_NETWORK: 'testnet',
    // Deliberately unroutable: proves the simulation never uses it.
    NEAR_RPC_URL: 'https://rpc.must-not-be-contacted.invalid',
    RHEA_CONTRACT_ID: 'ref-finance-101.testnet',
    BURROW_CONTRACT_ID: 'contract.1638481328.burrow.testnet',
    BURROW_ORACLE_ID: 'priceoracle.testnet',
    DATA_SOURCE: 'simulation',
    ...over,
  });

const simulate = async (over: Record<string, string>) => {
  const repo = new InMemoryRepository({ dataSource: 'simulation', network: 'testnet' });
  // Any real network call would go through this and fail the test.
  const fetchImpl: typeof fetch = async () => {
    throw new Error('network access attempted during simulation');
  };
  const wired = await wire(envFor(over), testnetConfig, repo, new SilentLogger(), { fetchImpl });
  const result = await wired.cycle.run();
  return { ...wired, result, repo };
};

describe.each(['legacy', 'orchestrator'])('simulation, %s engine', (engine) => {
  it('demo-500: the guardian repays ~$40, policy approves, the dry-run executor never sends', async () => {
    const { result, simulation } = await simulate({
      AUTOPILOT_ENGINE: engine,
      SIMULATION_PORTFOLIO: 'demo-500',
    });
    expect(result.run.status).toBe('completed');
    expect(result.proposals).toHaveLength(1);
    const [p] = result.proposals;
    expect(p).toMatchObject({
      kind: 'lending.repay',
      status: 'dry_run',
      executionMode: 'dry-run',
      txHash: null,
    });
    // 200 USDt debt / 0.95 vs 120 wNEAR x $3 x 0.75: repaying ~39.7 USDt restores HF 1.6.
    expect(p?.valueUsdMicro).toBeGreaterThan(39_000_000n);
    expect(p?.valueUsdMicro).toBeLessThan(41_000_000n);
    expect(new Set(simulation?.methods)).toEqual(new Set(['status', 'query']));
  });

  it('demo-5000: the needed repay (~$464) exceeds the $100 per-action limit and policy rejects it', async () => {
    const { result } = await simulate({
      AUTOPILOT_ENGINE: engine,
      SIMULATION_PORTFOLIO: 'demo-5000',
    });
    const repay = result.proposals.find((p) => p.kind === 'lending.repay');
    expect(repay?.status).toBe('rejected');
    expect(repay?.violations.map((v) => v.rule)).toContain('max_action_value');
    // The orchestrator then tries its next-ranked de-risk (a collateral top-up); it is just as oversized. Nothing
    // passes policy, so nothing reaches the executor.
    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    for (const p of result.proposals) {
      expect(p.status).toBe('rejected');
      expect(p.txHash).toBeNull();
    }
  });
});

describe('simulation data is labelled and valued as documented', () => {
  it.each([
    ['demo-500', { wallet: '140.00', supplied: '360.00', borrowed: '200.00', net: '300.00' }],
    ['demo-5000', { wallet: '1500.00', supplied: '3500.00', borrowed: '2000.00', net: '3000.00' }],
  ] as const)('%s', async (portfolio, expected) => {
    const { snapshots } = await simulate({ SIMULATION_PORTFOLIO: portfolio });
    const dto = toPortfolioDto(await snapshots.take(), {
      dataSource: 'simulation',
      network: 'testnet',
    });
    expect(portfolioDtoSchema.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({
      dataSource: 'simulation',
      walletValueUsd: expected.wallet,
      suppliedValueUsd: expected.supplied,
      borrowedValueUsd: expected.borrowed,
      netValueUsd: expected.net,
    });
  });

  it('refuses to start when the policy allowlists do not admit the demo assets', async () => {
    const narrowed = {
      ...testnetConfig,
      policy: { ...testnetConfig.policy, allowedTokens: [accountId('usdt.fakes.testnet')] },
    };
    await expect(
      wire(envFor({}), narrowed, new InMemoryRepository(), new SilentLogger()),
    ).rejects.toThrow('policy allowlists must include wrap.testnet');
  });
});
