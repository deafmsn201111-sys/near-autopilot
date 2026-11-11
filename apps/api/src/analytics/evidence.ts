import type { Database } from '@near-autopilot/db';
import { verifyCheckpoints } from '../evidence/checkpoint';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toJsonSafe } from '@near-autopilot/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EvidenceStore } from '../evidence/store';
import { publicRoute } from '../public-text';
import { ROOT } from '../thesis/paths';
import { computeThesis, type ThesisData } from '../thesis/rebuild';
import { RULES, thesisSummary } from '../thesis/report';

/**
 * READ-ONLY evidence endpoints for the analytics dashboard: policy verdicts, the attack-demo log, the audit chains,
 * Shadow Gateway routes and the thesis. Every deployment's rows are returned WITH their data source and network, so
 * simulation never passes for chain data; the attack log is a committed file of labelled FIXTURES.
 */
const ATTACK_LOG = resolve(ROOT, 'docs/evidence/demo-attack.log.jsonl');

let thesisCache: { data: ThesisData; at: string } | null = null;
/** The thesis inputs are committed files: computed once per process. */
function thesis(): ThesisData | null {
  if (!thesisCache && existsSync(resolve(ROOT, 'thesis/data/raw/manifest.json')))
    thesisCache = { data: computeThesis(), at: new Date().toISOString() };
  return thesisCache?.data ?? null;
}

const env = (p: { dataSource: string; network: string }) => `${p.dataSource}:${p.network}`;

export function registerEvidence(
  app: FastifyInstance,
  evidence: EvidenceStore,
  checkpoints?: { publicKey: string; file?: string | undefined; db: Database },
): void {
  app.get('/v1/analytics/policy/verdicts', async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(200),
        verdict: z.enum(['ALLOW', 'WARN', 'BLOCK']).optional(),
      })
      .parse(req.query);
    const rows = await evidence.verdicts({ limit: q.limit });
    const list = rows
      .filter((r) => !q.verdict || r.verdict === q.verdict)
      .map((r) => {
        const input = r.input as { intent?: unknown; config?: unknown } | null;
        return {
          id: r.id,
          evaluatedAt: r.evaluatedAt,
          engine: r.engine,
          runId: r.runId,
          intentId: r.intentId,
          intentKind: r.intentKind,
          intent: input?.intent ?? null,
          verdict: r.verdict,
          outcome: r.outcome,
          policyVersion: r.policyVersion,
          snapshotId: r.snapshotId,
          planHash: r.planHash,
          valueUsdMicro: r.valueUsdMicro,
          checks: r.checks,
          violations: r.violations,
          configStored: input?.config !== undefined,
          environment: env(r),
          fixture: r.runId?.startsWith('demo-attack:') ?? false,
        };
      });
    return { verdicts: list };
  });

  app.get('/v1/analytics/policy/attacks', async () => {
    if (!existsSync(ATTACK_LOG)) return { label: null, entries: [], file: null };
    const entries = readFileSync(ATTACK_LOG, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return {
      file: 'docs/evidence/demo-attack.log.jsonl',
      label: (entries[0]?.label as string | undefined) ?? null,
      entries,
    };
  });

  app.get('/v1/analytics/audit', async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(40),
        chain: z.string().max(64).optional(),
      })
      .parse(req.query);
    const { chains, unchained } = await evidence.chains();
    const verified = await Promise.all(
      chains.map(async (c) => ({ ...c, verification: await evidence.verify(c.chain) })),
    );
    const selected = q.chain ?? chains[0]?.chain ?? null;
    const signed = checkpoints
      ? await verifyCheckpoints(
          checkpoints.db,
          checkpoints.publicKey,
          checkpoints.file ? { file: checkpoints.file } : {},
        )
      : null;
    return {
      checkpoints: signed && {
        configured: true,
        publicKey: checkpoints?.publicKey,
        chains: signed,
      },
      chains: verified,
      unchainedRowsBeforeMigration0011: unchained,
      selected,
      entries: selected ? toJsonSafe(await evidence.latest(selected, q.limit)) : [],
    };
  });

  app.get('/v1/analytics/routes', async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        origin: z.enum(['gateway', 'probe']).optional(),
      })
      .parse(req.query);
    const rows = await evidence.routes(
      q.origin ? { limit: q.limit, origin: q.origin } : { limit: q.limit },
    );
    return {
      routes: rows.map((r) => ({ ...publicRoute(r), environment: env(r), executed: false })),
    };
  });

  app.get('/v1/analytics/thesis', async () => {
    const d = thesis();
    if (!d) return { available: false };
    const s = thesisSummary(d);
    return toJsonSafe({
      available: true,
      manifest: {
        end: d.manifest.end,
        days: d.manifest.days,
        blocks: d.manifest.blocks.length,
        first: d.manifest.blocks[0],
        last: d.manifest.blocks[d.manifest.blocks.length - 1],
        universe: d.manifest.universe,
      },
      rules: RULES,
      verdict: { counts: s.verdict, text: s.verdictText, h1: s.h1, h2: s.h2, h3: s.h3 },
      evidence: {
        pools: s.n,
        withNominal: s.withNominal.length,
        nominalAboveKept: s.above.length,
        within2pp: s.close.length,
        rho: s.rho,
        rhoNominal: d.tvlVsNominal,
        negativeHodl: s.negativeHodl.length,
        negative500: s.negative500.length,
        idle: s.idle.map((m) => m.pool),
        burrowMarkets: s.markets.length,
        burrowWithin: s.bClose.length,
        priceCheck: d.priceCheck,
        nearUsdEnd: d.nearUsdEnd,
      },
      cohorts: d.cohorts,
      survivorship: d.manifest.universe.startPools
        ? {
            included: d.cohorts.find((c) => c.key === 'shrunk')?.pools.length ?? 0,
            text: `To avoid looking only at the survivors, the sample also includes the pools that were among the largest at the start but not at the end (${d.cohorts.find((c) => c.key === 'shrunk')?.pools.length ?? 0}).`,
          }
        : null,
      pools: d.pools.map((m) => ({
        ...m,
        lpVsHodlApr30: d.pools30.get(m.pool)?.lpVsHodlApr ?? null,
      })),
      burrow: d.burrow,
      daily: d.daily,
    });
  });
}
