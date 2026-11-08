import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadApiEnv, type ApiEnv } from '@near-autopilot/config';
import { accountId } from '@near-autopilot/core';
import { SilentLogger } from '@near-autopilot/core/testing';
import { parseAutopilotConfig } from '../src/autopilot-config';
import { wire } from '../src/wiring';
import { InMemoryRepository } from './in-memory-repository';

/**
 * T3.1 — orchestrator-as-primary, de-risked.
 *
 * Before the multi-agent orchestrator can replace the legacy engine as the default, it must run end-to-end through
 * the real composition root (`wire`) and uphold the same safety invariants. These tests run a full cycle on each
 * engine over the same deterministic simulated portfolio — no network — and assert that:
 *   - both engines complete a cycle and persist a run;
 *   - the orchestrated path is actually exercised (engine tag = 'orchestrator');
 *   - neither engine produces a transaction hash (the dry-run invariant holds regardless of engine).
 * This is equivalence of SAFETY, not of output: the two engines have different agents and will not propose the same
 * things. The point is that switching the default never weakens the guarantees.
 */

const ACCOUNT = 'your-account.near';
const config = parseAutopilotConfig(
  JSON.parse(
    readFileSync(new URL('../../../config/autopilot.example.json', import.meta.url), 'utf8'),
  ) as unknown,
  accountId(ACCOUNT),
);

/** A fetch that answers `status` with a mainnet chain id, so the chain-id guard passes without a real RPC. */
const statusRpc =
  (chainId = 'mainnet'): typeof fetch =>
  async (_url, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { id: number };
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { chain_id: chainId } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

/** Simulation + no market data: the snapshot is the deterministic demo portfolio, so the cycle needs no network. */
const envFor = (engine: 'legacy' | 'orchestrator'): ApiEnv =>
  loadApiEnv({
    API_TOKEN: 'test-token-test-token-test-token-test',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    AUTOPILOT_ACCOUNT_ID: ACCOUNT,
    NEAR_NETWORK: 'mainnet',
    NEAR_RPC_URL: 'https://rpc.example.invalid',
    AUTOPILOT_ENGINE: engine,
    DATA_SOURCE: 'simulation',
    SIMULATION_PORTFOLIO: 'demo-5000',
    EXECUTION_MODE: 'dry-run',
    MARKET_DATA: 'none',
  });

async function runOneCycle(engine: 'legacy' | 'orchestrator') {
  const repo = new InMemoryRepository({ dataSource: 'simulation', network: 'mainnet' });
  const wired = await wire(envFor(engine), config, repo, new SilentLogger(), {
    fetchImpl: statusRpc(),
  });
  const result = await wired.cycle.run();
  return { repo, result };
}

describe('orchestrated cycle (T3.1 safety equivalence)', () => {
  it('runs a full cycle through the orchestrator engine and persists a completed run', async () => {
    const { repo, result } = await runOneCycle('orchestrator');
    expect(result.run.status).toBe('completed');
    const snapshot = repo.snapshots.get(result.run.id) as { engine?: string } | undefined;
    expect(snapshot?.engine).toBe('orchestrator');
  });

  it('runs a full cycle through the legacy engine and persists a completed run', async () => {
    const { result } = await runOneCycle('legacy');
    expect(result.run.status).toBe('completed');
  });

  it('never produces a transaction hash on either engine (dry-run invariant)', async () => {
    for (const engine of ['legacy', 'orchestrator'] as const) {
      const { repo, result } = await runOneCycle(engine);
      expect(result.run.status).toBe('completed');
      for (const p of repo.proposals.values()) {
        expect(p.txHash).toBeNull();
        expect(p.executionMode).not.toBe('live');
      }
    }
  });
});
