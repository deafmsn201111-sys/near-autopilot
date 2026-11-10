import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadApiEnv, type ApiEnv } from '@near-autopilot/config';
import { accountId, portfolioDtoSchema } from '@near-autopilot/core';
import { FixedClock, SilentLogger } from '@near-autopilot/core/testing';
import { parseAutopilotConfig } from '../src/autopilot-config';
import { toPortfolioDto } from '../src/presenters';
import { DEMO_PORTFOLIOS } from '../src/simulation/demo-portfolios';
import { SimulatedChain } from '../src/simulation/simulated-chain';
import { wire } from '../src/wiring';
import { InMemoryRepository } from './in-memory-repository';

/**
 * End to end, offline: the production composition root with DATA_SOURCE=simulation. Every adapter, the Burrow
 * deployment verifier, the planners, the policy engine and the dry-run executor are the real ones; only the NEAR RPC
 * is the in-process mock. Nothing here touches a network.
 */
const ACCOUNT = 'your-account.near';
const readConfig = (file: string) =>
  parseAutopilotConfig(
    JSON.parse(
      readFileSync(new URL(`../../../config/${file}`, import.meta.url), 'utf8'),
    ) as unknown,
    accountId(ACCOUNT),
  );
const config = readConfig('autopilot.example.json');

const envFor = (over: Record<string, string>): ApiEnv =>
  loadApiEnv({
    API_TOKEN: 'test-token-test-token-test-token-test',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    AUTOPILOT_ACCOUNT_ID: ACCOUNT,
    NEAR_NETWORK: 'mainnet',
    // Deliberately unroutable: proves the simulation never uses it.
    NEAR_RPC_URL: 'https://rpc.must-not-be-contacted.invalid',
    RHEA_CONTRACT_ID: 'v2.ref-finance.near',
    BURROW_CONTRACT_ID: 'contract.main.burrow.near',
    BURROW_ORACLE_ID: 'priceoracle.near',
    DATA_SOURCE: 'simulation',
    ...over,
  });

const simulate = async (over: Record<string, string>) => {
  const repo = new InMemoryRepository({ dataSource: 'simulation', network: 'mainnet' });
  // Any real network call would go through this and fail the test.
  const fetchImpl: typeof fetch = async () => {
    throw new Error('network access attempted during simulation');
  };
  const wired = await wire(envFor(over), config, repo, new SilentLogger(), { fetchImpl });
  const result = await wired.cycle.run();
  return { ...wired, result, repo };
};

describe.each(['legacy', 'orchestrator'])('simulation, %s engine', (engine) => {
  it('demo-500: the guardian repays ~$40, policy approves, the dry-run executor never sends', async () => {
    const { result, simulation, repo } = await simulate({
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
    // Through the Shadow Gateway: it found the stored ALLOW for this exact plan; a repay has no second venue.
    expect(repo.routes).toMatchObject([
      { origin: 'gateway', outcome: 'not_a_swap', chosenVenue: null },
    ]);
    const v = repo.verdicts.find((x) => x.id === repo.routes[0]?.decisionId);
    expect(v).toMatchObject({ verdict: 'ALLOW', planHash: repo.routes[0]?.planHash });
  });

  it('demo-5000: the needed repay (~$464) exceeds the $100 per-action limit and policy rejects it', async () => {
    const { result, repo } = await simulate({
      AUTOPILOT_ENGINE: engine,
      SIMULATION_PORTFOLIO: 'demo-5000',
    });
    // BLOCK never reaches the gateway: no approval exists to hand it.
    expect(repo.routes).toEqual([]);
    expect(repo.verdicts.every((v) => v.verdict === 'BLOCK')).toBe(true);
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

/** Ranked de-risk candidates the guardian emits for demo-500. */
const GUARDIAN_KINDS = ['lending.repay', 'lending.supply_collateral'];

describe('orchestrator run report', () => {
  it('records what every agent did, including insufficient_data, in the run snapshot', async () => {
    const { result, repo } = await simulate({
      AUTOPILOT_ENGINE: 'orchestrator',
      SIMULATION_PORTFOLIO: 'demo-500',
    });
    const { agents } = z
      .object({
        agents: z.array(
          z.object({
            agent: z.string(),
            event: z.string(),
            proposals: z.array(z.object({ kind: z.string(), reasonCode: z.string().optional() })),
          }),
        ),
      })
      .parse(repo.snapshots.get(result.run.id));
    // No market-data source is integrated: three agents honestly report they cannot act; only the guardian
    // (which works from the position alone) proposes.
    expect(
      agents.map((a) => [a.agent, a.event, a.proposals.map((p) => p.reasonCode ?? p.kind)]),
    ).toEqual([
      ['market-intelligence', 'output', ['insufficient_data']],
      ['lp-optimizer', 'output', ['insufficient_data']],
      ['liquidation-guardian', 'output', GUARDIAN_KINDS],
      ['capital-allocator', 'output', ['insufficient_data']],
    ]);
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
      network: 'mainnet',
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
      ...config,
      policy: { ...config.policy, allowedTokens: [accountId('usdt.tether-token.near')] },
    };
    await expect(
      wire(envFor({}), narrowed, new InMemoryRepository(), new SilentLogger()),
    ).rejects.toThrow('policy allowlists must include wrap.near');
  });
});

describe('the simulated chain cannot accept a transaction', () => {
  const chain = new SimulatedChain({
    network: 'mainnet',
    accountId: accountId(ACCOUNT),
    burrowContractId: accountId('contract.main.burrow.near'),
    burrowOracleId: accountId('priceoracle.near'),
    rheaContractId: accountId('v2.ref-finance.near'),
    portfolio: DEMO_PORTFOLIOS['demo-500'],
    clock: new FixedClock(new Date('2026-11-04T10:00:00Z')),
  });
  const rpc = async (method: string, params: unknown) => {
    const response = await chain.fetch('https://ignored.invalid', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await response.json()) as { result?: unknown; error?: { message: string } };
  };

  it.each(['send_tx', 'broadcast_tx_commit', 'broadcast_tx_async', 'EXPERIMENTAL_tx_status'])(
    'refuses %s',
    async (method) => {
      const reply = await rpc(method, { signed_tx_base64: 'AAAA' });
      expect(reply.result).toBeUndefined();
      expect(reply.error?.message).toContain('nothing can be sent');
    },
  );

  it.each(['view_access_key', 'view_access_key_list'])(
    'does not serve %s, so no signer can obtain a nonce',
    async (requestType) => {
      const reply = await rpc('query', {
        request_type: requestType,
        finality: 'final',
        account_id: ACCOUNT,
        public_key: 'ed25519:11111111111111111111111111111111',
      });
      expect(reply.result).toBeUndefined();
      expect(reply.error?.message).toContain('does not serve');
    },
  );
});

describe('an RPC failure never yields a successful partial snapshot', () => {
  /** Real chain path (DATA_SOURCE=chain) over a mock chain whose oracle answers `failure` for get_price_data. */
  const brokenOracle = (failure: 'invalid_body' | 'rpc_error'): typeof fetch => {
    const chain = new SimulatedChain({
      network: 'mainnet',
      accountId: accountId(ACCOUNT),
      burrowContractId: accountId('contract.main.burrow.near'),
      burrowOracleId: accountId('priceoracle.near'),
      rheaContractId: accountId('v2.ref-finance.near'),
      portfolio: DEMO_PORTFOLIOS['demo-500'],
      clock: new FixedClock(new Date()),
      otherTokens: config.policy.allowedTokens,
    });
    return async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (body.includes('"method_name":"get_price_data"')) {
        return failure === 'invalid_body'
          ? new Response('<html>bad gateway page</html>', { status: 200 })
          : new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' }, message: 'x' },
              }),
              { status: 200 },
            );
      }
      return chain.fetch(input, init);
    };
  };

  it.each(['invalid_body', 'rpc_error'] as const)(
    'legacy: the run fails and nothing is proposed (%s)',
    async (failure) => {
      const repo = new InMemoryRepository({ dataSource: 'chain', network: 'mainnet' });
      const wired = await wire(
        envFor({ DATA_SOURCE: 'chain', AUTOPILOT_ENGINE: 'legacy' }),
        config,
        repo,
        new SilentLogger(),
        { fetchImpl: brokenOracle(failure) },
      );
      const { run, proposals } = await wired.cycle.run();
      expect(run.status).toBe('failed');
      expect(run.error).toMatch(/RPC|JSON|oracle|price/i);
      expect(proposals).toEqual([]);
      expect(repo.snapshots.get(run.id)).toBeNull();
    },
    30_000,
  );

  it('orchestrator: no snapshot, no action, and the run says why', async () => {
    const repo = new InMemoryRepository({ dataSource: 'chain', network: 'mainnet' });
    const wired = await wire(
      envFor({ DATA_SOURCE: 'chain', AUTOPILOT_ENGINE: 'orchestrator' }),
      config,
      repo,
      new SilentLogger(),
      { fetchImpl: brokenOracle('rpc_error') },
    );
    const { run, proposals } = await wired.cycle.run();
    expect(proposals).toEqual([]);
    expect(run.outcome).toContain('no snapshot available');
    expect(run.outcome).toContain('SNAPSHOT_UNAVAILABLE');
  }, 30_000);
});
