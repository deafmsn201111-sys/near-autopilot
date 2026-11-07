import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadApiEnv } from '@near-autopilot/config';
import { accountId } from '@near-autopilot/core';
import { SilentLogger } from '@near-autopilot/core/testing';
import { parseAutopilotConfig } from '../src/autopilot-config';
import { UserRequestService } from '../src/services/requests';
import { systemClock, uuidGenerator, wire } from '../src/wiring';
import { InMemoryRepository } from './in-memory-repository';

/**
 * "Let the agent do it", end to end on the in-process simulation (no network): the request goes through the real
 * Burrow planner, the real policy engine (testnet example limits: auto-approve up to $50, at most $100 per action)
 * and the real dry-run executor.
 */
const ACCOUNT = 'your-account.testnet';
const USDT = accountId('usdt.fakes.testnet');
const noNetwork: typeof fetch = async () => {
  throw new Error('network access attempted');
};

async function service() {
  const config = parseAutopilotConfig(
    JSON.parse(
      readFileSync(
        new URL('../../../config/autopilot.testnet.example.json', import.meta.url),
        'utf8',
      ),
    ) as unknown,
    accountId(ACCOUNT),
  );
  const env = loadApiEnv({
    API_TOKEN: 'request-token-request-token-request-token',
    DATABASE_URL: 'postgres://u:p@localhost:5432/x',
    AUTOPILOT_ACCOUNT_ID: ACCOUNT,
    NEAR_NETWORK: 'testnet',
    NEAR_RPC_URL: 'https://rpc.must-not-be-contacted.invalid',
    RHEA_CONTRACT_ID: 'ref-finance-101.testnet',
    BURROW_CONTRACT_ID: 'contract.1638481328.burrow.testnet',
    BURROW_ORACLE_ID: 'priceoracle.testnet',
    DATA_SOURCE: 'simulation',
    SIMULATION_PORTFOLIO: 'demo-500',
  });
  const repo = new InMemoryRepository({ dataSource: 'simulation', network: 'testnet' });
  const w = await wire(env, config, repo, new SilentLogger(), {
    fetchImpl: noNetwork,
    marketFetchImpl: noNetwork,
    mainnetFetchImpl: noNetwork,
  });
  return {
    repo,
    s: new UserRequestService({
      policy: w.policy,
      planners: w.planners,
      executor: w.executor,
      snapshots: w.snapshots,
      repo,
      accountId: w.accountId,
      clock: systemClock,
      ids: uuidGenerator,
      logger: new SilentLogger(),
    }),
  };
}

describe('let the agent do it (simulation, dry-run)', () => {
  it('a small deposit passes the 12 checks and is executed as a dry run; the verdict is stored first', async () => {
    const { s, repo } = await service();
    const r = await s.request({ kind: 'supply', token: USDT, usd: 20, by: 'tester' });
    expect(r).toMatchObject({ status: 'done', verdict: 'ALLOW', mode: 'dry-run', txHash: null });
    expect(repo.verdicts.at(-1)).toMatchObject({ verdict: 'ALLOW', runId: `request:${r.id}` });
  });

  it('above the auto-approval threshold it waits for the user, and runs once confirmed', async () => {
    const { s } = await service();
    const r = await s.request({ kind: 'repay', token: USDT, usd: 70, by: 'tester' });
    expect(r.status).toBe('needs_approval');
    const done = await s.confirm(r.id, 'tester');
    expect(done).toMatchObject({ status: 'done', mode: 'dry-run' });
    expect((await s.confirm(r.id, 'tester')).status).toBe('failed'); // once only
  });

  it('above the per-action limit it is blocked, and no confirmation can override it', async () => {
    const { s } = await service();
    const r = await s.request({ kind: 'repay', token: USDT, usd: 150, by: 'tester' });
    expect(r).toMatchObject({ status: 'blocked', verdict: 'BLOCK' });
    expect(r.reasons.join(' ')).toMatch(/limit/);
    expect((await s.confirm(r.id, 'tester')).status).toBe('failed');
  });
});
