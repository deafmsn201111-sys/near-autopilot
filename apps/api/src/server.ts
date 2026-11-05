import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import type {
  PolicyDto,
  PortfolioSnapshot,
  Provenance,
  MarketDataDto,
  TestnetTxResponse,
  YieldDataDto,
} from '@near-autopilot/core';
import type { AutopilotRepository } from './repository';
import { chainOf } from './evidence/chain';
import type { EvidenceStore } from './evidence/store';
import { toPortfolioDto, toProposalDto, toRunDto, toRouteDto, toVerdictDto } from './presenters';
import { CycleInProgressError, type CycleResult } from './services/cycle';
import { disabledYieldView } from './yield/presenter';

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
  /** Mainnet reference market data (testnet profile); absent means not used by this deployment. */
  readonly marketData?: { current(): Promise<MarketDataDto> };
  readonly yieldData?: { current(): Promise<YieldDataDto> };
  /** This deployment's audit hash chain in Postgres (absent in tests that do not need it). */
  readonly evidence?: Pick<EvidenceStore, 'latest' | 'verify'>;
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

const verdictQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  verdict: z.enum(['ALLOW', 'WARN', 'BLOCK']).optional(),
});

const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

const routeQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  origin: z.enum(['gateway', 'probe']).optional(),
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

  /** Stored policy verdicts (newest first): verdict, every check, policy version, snapshot id. Inputs are omitted. */
  app.get('/v1/policy/verdicts', async (request) => {
    const q = verdictQuery.parse(request.query);
    const rows = await deps.repo.listPolicyVerdicts(
      q.verdict === undefined ? { limit: q.limit } : { limit: q.limit, verdict: q.verdict },
    );
    return { verdicts: rows.map(toVerdictDto) };
  });

  /** Shadow Gateway routing records (newest first): venues quoted, venue chosen, why. Quotes only, nothing sent. */
  app.get('/v1/routes', async (request) => {
    const q = routeQuery.parse(request.query);
    const rows = await deps.repo.listExecutionRoutes(
      q.origin === undefined ? { limit: q.limit } : { limit: q.limit, origin: q.origin },
    );
    return { routes: rows.map(toRouteDto) };
  });

  /** The newest entries of this deployment's audit hash chain, each with seq, prev_hash and hash. */
  app.get('/v1/audit', async (request) => {
    const { limit } = auditQuery.parse(request.query);
    const chain = chainOf(deps.provenance);
    const rows = deps.evidence ? await deps.evidence.latest(chain, limit) : [];
    return {
      chain,
      entries: rows.map((r) => ({ ...r, at: r.at.toISOString() })),
    };
  });

  /** Re-verifies this deployment's whole chain from the database, seq 1 to head. */
  app.get('/v1/audit/verify', async () => {
    const chain = chainOf(deps.provenance);
    if (!deps.evidence) return { chain, ok: false, entries: 0, error: 'no evidence store' };
    return deps.evidence.verify(chain);
  });

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

  app.get('/v1/yield', async () => (deps.yieldData ? deps.yieldData.current() : disabledYieldView));

  app.get('/v1/market-data', async () =>
    deps.marketData
      ? deps.marketData.current()
      : {
          enabled: false,
          flow: 'MAINNET MARKET DATA → TESTNET EXECUTION',
          marketNetwork: 'mainnet',
          executionNetwork: deps.provenance.network,
          fetchedAt: null,
          sources: [],
          assets: [],
          error: null,
        },
  );

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
