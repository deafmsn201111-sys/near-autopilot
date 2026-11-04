import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  portfolioDtoSchema,
  runsResponseSchema,
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

const make = (cycleError?: Error) => {
  const repo = new InMemoryRepository();
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
