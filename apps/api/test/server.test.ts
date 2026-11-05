import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  portfolioDtoSchema,
  runsResponseSchema,
  testnetTxResponseSchema,
  yieldDataDtoSchema,
  proposalsResponseSchema,
  triggerRunResponseSchema,
  type PolicyDto,
} from '@near-autopilot/core';
import { buildServer, isAuthorized } from '../src/server';
import { CycleInProgressError } from '../src/services/cycle';
import { InMemoryRepository } from './in-memory-repository';

const TOKEN = 't'.repeat(40);
const provenance = { dataSource: 'chain', network: 'mainnet' } as const;
const policy: PolicyDto = {
  ...provenance,
  engine: 'legacy',
  simulationPortfolio: null,
  marketData: 'none',
  enabled: true,
  executionMode: 'dry-run',
  maxActionUsd: '100.00',
  dailyLimitUsd: '300.00',
  approvalThresholdUsd: '50.00',
  maxSlippageBps: 50,
  maxOracleDeviationBps: 150,
  cooldownSeconds: 600,
  allowedContracts: ['wrap.near'],
  allowedTokens: ['wrap.near'],
  guardian: { triggerHealthFactor: 1.3, targetHealthFactor: 1.6 },
};
const auth = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

let lastRepo: InMemoryRepository | undefined;
const make = (cycleError?: Error) => {
  const repo = new InMemoryRepository();
  lastRepo = repo;
  app = buildServer({
    apiToken: TOKEN,
    repo,
    policy,
    provenance,
    snapshots: {
      take: async () => {
        throw new Error('not needed');
      },
    },
    cycle: {
      run: async () => {
        if (cycleError) throw cycleError;
        return {
          run: {
            id: 'r1',
            accountId: 'alice.near',
            status: 'completed' as const,
            startedAt: new Date(0),
            finishedAt: new Date(1),
            error: null,
            outcome: null,
          },
          proposals: [],
        };
      },
    },
  });
  return app;
};

describe('HTTP API', () => {
  it('serves /health without auth and /ready when the database answers', async () => {
    const server = make();
    expect((await server.inject('/health')).statusCode).toBe(200);
    expect((await server.inject('/ready')).statusCode).toBe(200);
  });

  it('requires a bearer token on /v1 routes', async () => {
    const server = make();
    expect((await server.inject('/v1/policy')).statusCode).toBe(401);
    expect(
      (await server.inject({ url: '/v1/policy', headers: { authorization: 'Bearer wrong' } }))
        .statusCode,
    ).toBe(401);
    expect((await server.inject({ url: '/v1/policy', headers: auth })).statusCode).toBe(200);
  });

  it('returns contract-shaped lists', async () => {
    const server = make();
    expect(
      runsResponseSchema.parse((await server.inject({ url: '/v1/runs', headers: auth })).json()),
    ).toEqual({ runs: [] });
    expect(
      proposalsResponseSchema.parse(
        (await server.inject({ url: '/v1/proposals?limit=5', headers: auth })).json(),
      ),
    ).toEqual({ proposals: [] });
  });

  it('lists stored policy verdicts behind auth, filterable, without the evaluation input', async () => {
    const server = make();
    const base = {
      engine: 'legacy' as const,
      runId: 'r1',
      intentKind: 'swap',
      policyVersion: 'rules-2026.11.1+cfg:0123456789abcdef',
      snapshotId: `sha256:${'a'.repeat(64)}`,
      planHash: 'b'.repeat(64),
      valueUsdMicro: 50_000_000n,
      violations: [],
      input: { secretish: 'not returned' },
    };
    await lastRepo?.insertPolicyVerdict({
      ...base,
      id: 'v1',
      evaluatedAt: new Date('2026-11-05T10:00:00Z'),
      intentId: 'i1',
      verdict: 'ALLOW',
      outcome: 'approve',
      checks: [{ rule: 'kill_switch', result: 'PASS', messages: [] }],
    });
    await lastRepo?.insertPolicyVerdict({
      ...base,
      id: 'v2',
      evaluatedAt: new Date('2026-11-05T10:01:00Z'),
      intentId: 'i2',
      verdict: 'BLOCK',
      outcome: 'reject',
      checks: [
        { rule: 'kill_switch', result: 'BLOCK', messages: ['Autopilot is disabled by policy'] },
      ],
      violations: [
        { rule: 'kill_switch', message: 'Autopilot is disabled by policy', severity: 'reject' },
      ],
    });
    expect((await server.inject('/v1/policy/verdicts')).statusCode).toBe(401);
    const all = (await server.inject({ url: '/v1/policy/verdicts', headers: auth })).json<{
      verdicts: Array<Record<string, unknown>>;
    }>();
    expect(all.verdicts.map((v) => v.id)).toEqual(['v2', 'v1']);
    expect(all.verdicts[0]).toMatchObject({
      verdict: 'BLOCK',
      valueUsdMicro: '50000000',
      network: 'mainnet',
    });
    expect(all.verdicts[0]).not.toHaveProperty('input');
    const blocked = (
      await server.inject({ url: '/v1/policy/verdicts?verdict=BLOCK', headers: auth })
    ).json<{ verdicts: unknown[] }>();
    expect(blocked.verdicts).toHaveLength(1);
    expect(
      (await server.inject({ url: '/v1/policy/verdicts?verdict=MAYBE', headers: auth })).statusCode,
    ).toBe(400);
  });

  it('serves Shadow Gateway routes behind auth, newest first, filterable by origin, never as executed', async () => {
    const server = make();
    const base = {
      outcome: 'routed' as const,
      decisionId: null,
      intentId: null,
      planHash: null,
      tokenIn: 'wrap.near',
      tokenOut: 'usdc.near',
      amountIn: 10n ** 24n,
      chosenVenue: 'rhea',
      advantageBps: 3,
      reason: 'rhea nets 3 bps more',
      quotes: { scored: [] },
    };
    await lastRepo?.insertExecutionRoute({
      ...base,
      id: 'r1',
      createdAt: new Date('2026-11-05T10:00:00Z'),
      origin: 'probe',
    });
    await lastRepo?.insertExecutionRoute({
      ...base,
      id: 'r2',
      createdAt: new Date('2026-11-05T10:01:00Z'),
      origin: 'gateway',
    });
    expect((await server.inject('/v1/routes')).statusCode).toBe(401);
    const all = (await server.inject({ url: '/v1/routes', headers: auth })).json<{
      routes: Array<Record<string, unknown>>;
    }>();
    expect(all.routes.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(all.routes[1]).toMatchObject({
      origin: 'probe',
      amountIn: '1000000000000000000000000',
      chosenVenue: 'rhea',
      executed: false,
    });
    const probes = (await server.inject({ url: '/v1/routes?origin=probe', headers: auth })).json<{
      routes: unknown[];
    }>();
    expect(probes.routes).toHaveLength(1);
    expect((await server.inject({ url: '/v1/routes?origin=x', headers: auth })).statusCode).toBe(
      400,
    );
  });

  it('serves the testnet transaction ledger read-only, behind auth', async () => {
    const server = make();
    expect((await server.inject({ url: '/v1/testnet-transactions' })).statusCode).toBe(401);
    const body = testnetTxResponseSchema.parse(
      (await server.inject({ url: '/v1/testnet-transactions', headers: auth })).json(),
    );
    expect(body).toEqual({ budgetNear: '0', spentNear: '0', transactions: [] });
    // There is no route that prepares or sends a transaction.
    for (const method of ['POST', 'PUT'] as const) {
      expect(
        (await server.inject({ method, url: '/v1/testnet-transactions', headers: auth }))
          .statusCode,
      ).toBe(404);
    }
  });

  it('serves yield data read-only, behind auth, disabled unless configured', async () => {
    const server = make();
    expect((await server.inject({ url: '/v1/yield' })).statusCode).toBe(401);
    const body = yieldDataDtoSchema.parse(
      (await server.inject({ url: '/v1/yield', headers: auth })).json(),
    );
    expect(body.enabled).toBe(false);
    expect(body.estimates).toEqual([]);
    for (const method of ['POST', 'PUT'] as const)
      expect((await server.inject({ method, url: '/v1/yield', headers: auth })).statusCode).toBe(
        404,
      );
  });

  it('validates query parameters', async () => {
    const server = make();
    expect((await server.inject({ url: '/v1/runs?limit=0', headers: auth })).statusCode).toBe(400);
    expect((await server.inject({ url: '/v1/runs?limit=abc', headers: auth })).statusCode).toBe(
      400,
    );
  });

  it('triggers a cycle and maps overlap to 409', async () => {
    const ok = await make().inject({ method: 'POST', url: '/v1/runs', headers: auth });
    expect(ok.statusCode).toBe(201);
    expect(triggerRunResponseSchema.parse(ok.json()).run.id).toBe('r1');
    await app?.close();
    const busy = await make(new CycleInProgressError()).inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth,
    });
    expect(busy.statusCode).toBe(409);
  });

  it('does not leak internals on unexpected errors', async () => {
    const res = await make(new Error('secret stack detail')).inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth,
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
  });

  it('exposes the portfolio contract schema for consumers', () => {
    expect(portfolioDtoSchema).toBeTruthy();
  });
});

describe('isAuthorized', () => {
  it('accepts only the exact bearer token', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false);
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
  });
});
