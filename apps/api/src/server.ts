import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import type {
  PolicyDto,
  PortfolioSnapshot,
  Provenance,
  TestnetTxResponse,
} from '@near-autopilot/core';
import type { AutopilotRepository } from './repository';
import { toPortfolioDto, toProposalDto, toRunDto } from './presenters';
import { CycleInProgressError, type CycleResult } from './services/cycle';

export interface ServerDeps {
  readonly apiToken: string;
  readonly repo: AutopilotRepository;
  readonly snapshots: { take(): Promise<PortfolioSnapshot> };
  readonly cycle: { run(): Promise<CycleResult> };
  readonly policy: PolicyDto;
  /** This deployment's data source and network, stamped on everything it produces. */
  readonly provenance: Provenance;
  /** Read-only view of the manually confirmed testnet transaction ledger (absent in tests that do not need it). */
  readonly testnetTransactions?: { list(limit: number): Promise<TestnetTxResponse> };
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time bearer token check (digests have equal length, so no length oracle). */
export function isAuthorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  if (!match?.[1]) return false;
  return timingSafeEqual(digest(match[1]), digest(token));
}

const limitQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  runId: z.string().min(1).max(100).optional(),
});

export function buildServer(
  deps: ServerDeps,
  options: { logger?: boolean | { level: string } } = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'invalid_request',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (error instanceof CycleInProgressError)
      return reply.status(409).send({ error: 'cycle_in_progress' });
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error' });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    if (!isAuthorized(request.headers.authorization, deps.apiToken)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    return undefined;
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    try {
      await deps.repo.ping();
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'database_unavailable' });
    }
  });

  app.get('/v1/portfolio', async () =>
    toPortfolioDto(await deps.snapshots.take(), deps.provenance),
  );

  app.get('/v1/runs', async (request) => {
    const { limit } = limitQuery.parse(request.query);
    return { runs: (await deps.repo.listRuns(limit)).map(toRunDto) };
  });

  app.get('/v1/proposals', async (request) => {
    const { limit, runId } = limitQuery.parse(request.query);
    const proposals = await deps.repo.listProposals(
      runId === undefined ? { limit } : { limit, runId },
    );
    return { proposals: proposals.map(toProposalDto) };
  });

  app.get('/v1/policy', async () => deps.policy);

  app.get('/v1/testnet-transactions', async (request) => {
    const { limit } = limitQuery.parse(request.query);
    return (
      (await deps.testnetTransactions?.list(limit)) ?? {
        budgetNear: '0',
        spentNear: '0',
        transactions: [],
      }
    );
  });

  app.post('/v1/runs', async (_request, reply) => {
    const result = await deps.cycle.run();
    return reply.status(201).send({
      run: toRunDto({
        ...result.run,
        ...deps.provenance,
        proposalCount: result.proposals.length,
      }),
      proposals: result.proposals.map((p) => toProposalDto({ ...p, ...deps.provenance })),
    });
  });

  return app;
}
