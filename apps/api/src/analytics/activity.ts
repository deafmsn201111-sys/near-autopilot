import { auditEvents, desc, inArray, sql, type Database } from '@near-autopilot/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CollectorStore } from '../collector/store';

/**
 * READ-ONLY activity feed and system health for the dashboard. The feed is a plain-language VIEW of what is stored:
 * collector cycles and the meaningful audit events (decisions, verdicts, dry-run executions, escalations, mode and
 * collection changes). Per-agent outputs and raw observations stay on the Audit page. Each item keeps its source
 * reference (chain + seq, or cycle id) so the plain sentence can always be checked against the record.
 */
const FEED_TYPES = [
  'orchestrator.cycle.finished',
  'orchestrator.decision.act',
  'orchestrator.policy.verdict',
  'orchestrator.execution.result',
  'orchestrator.escalation',
  'orchestrator.control.changed',
  'orchestrator.control.initialized',
  'orchestrator.control.restored',
  'collector.paused',
  'collector.resumed',
  'escalation_warn',
  'escalation_page',
] as const;

export type Tone = 'good' | 'neutral' | 'warning' | 'critical';
export interface ActivityItem {
  readonly at: string;
  readonly kind:
    'snapshot' | 'analysis' | 'decision' | 'verdict' | 'execution' | 'alert' | 'control';
  readonly title: string;
  readonly result: string;
  readonly explanation: string;
  readonly tone: Tone;
  readonly environment: string | null;
  readonly ref: string;
}

type P = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v);

const ENV: Record<string, string> = {
  'simulation:mainnet': 'Shadow mainnet',
};

export function describeEvent(
  type: string,
  p: P,
): Omit<ActivityItem, 'at' | 'environment' | 'ref'> {
  switch (type) {
    case 'orchestrator.cycle.finished': {
      const status = str(p['status']);
      return {
        kind: 'analysis',
        title: 'Autopilot analysis finished',
        result: status === 'no_action' ? 'No action needed' : status.replace(/_/g, ' '),
        explanation: str(p['detail']).replace(
          'ALL_PROPOSALS_REJECTED',
          'every proposal was rejected by the checks',
        ),
        tone: status === 'aborted' || status === 'execution_in_doubt' ? 'critical' : 'neutral',
      };
    }
    case 'orchestrator.decision.act':
      return {
        kind: 'decision',
        title: 'Autopilot proposed an action',
        result: 'Sent to the policy engine',
        explanation:
          'A proposal passed the decision engine and goes to the independent policy checks.',
        tone: 'neutral',
      };
    case 'orchestrator.policy.verdict': {
      const v = str(p['verdict']);
      return {
        kind: 'verdict',
        title: 'Policy decision',
        result: v === 'ALLOW' ? 'Allowed' : v === 'BLOCK' ? 'Blocked by safety rules' : v,
        explanation:
          v === 'ALLOW'
            ? 'All 12 checks passed. In shadow mode this still sends nothing.'
            : 'At least one of the 12 safety checks failed; the action was stopped.',
        tone: v === 'ALLOW' ? 'good' : 'warning',
      };
    }
    case 'orchestrator.execution.result':
      return {
        kind: 'execution',
        title: 'Dry run completed',
        result: str(p['status']) === 'dry_run' ? 'Nothing sent (dry run)' : str(p['status']),
        explanation: 'The approved plan was checked again and simulated; no transaction exists.',
        tone: str(p['status']) === 'dry_run' ? 'good' : 'warning',
      };
    case 'orchestrator.escalation':
    case 'escalation_warn':
    case 'escalation_page':
      return {
        kind: 'alert',
        title:
          str(p['severity']) === 'page' || type === 'escalation_page' ? 'Urgent alert' : 'Warning',
        result: str(p['code']).replace(/_/g, ' ').toLowerCase(),
        explanation: str(p['message']),
        tone: str(p['severity']) === 'page' || type === 'escalation_page' ? 'critical' : 'warning',
      };
    case 'orchestrator.control.changed':
    case 'orchestrator.control.initialized':
      return {
        kind: 'control',
        title: 'Autopilot mode changed',
        result: `${str(p['previousMode']) || 'new'} → ${str(p['mode'])}`.replace(/_/g, ' '),
        explanation: `${str(p['reason'])} (by ${str(p['changedBy'])})`,
        tone: str(p['mode']) === 'read_only' ? 'warning' : 'neutral',
      };
    case 'orchestrator.control.restored':
      return {
        kind: 'control',
        title: 'Autopilot restarted',
        result: `Restored in ${str(p['mode']).replace(/_/g, ' ')} mode`,
        explanation: 'The operating mode was read back from the database after a restart.',
        tone: 'neutral',
      };
    case 'collector.paused':
    case 'collector.resumed':
      return {
        kind: 'control',
        title:
          type === 'collector.paused' ? 'Market collection paused' : 'Market collection resumed',
        result:
          type === 'collector.paused' ? 'Scheduled cycles skipped' : 'Scheduled cycles running',
        explanation: `${str(p['reason'])} (by ${str(p['by'])})`,
        tone: type === 'collector.paused' ? 'warning' : 'neutral',
      };
    default:
      return { kind: 'analysis', title: type, result: '', explanation: '', tone: 'neutral' };
  }
}

const cycleTone = (status: string): Tone =>
  status === 'success'
    ? 'good'
    : status === 'running'
      ? 'neutral'
      : status === 'partial'
        ? 'warning'
        : 'critical';

export function registerActivity(
  app: FastifyInstance,
  store: CollectorStore,
  db: Database,
  intervalSeconds: number,
  now: () => Date,
): void {
  app.get('/v1/analytics/activity', async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    const [events, cycles] = await Promise.all([
      db
        .select({
          at: auditEvents.at,
          type: auditEvents.type,
          payload: auditEvents.payload,
          chain: auditEvents.chain,
          seq: auditEvents.seq,
        })
        .from(auditEvents)
        .where(inArray(auditEvents.type, [...FEED_TYPES]))
        .orderBy(desc(auditEvents.at))
        .limit(limit),
      store.recentCycles(Math.min(limit, 30)),
    ]);
    const items: ActivityItem[] = [
      ...events.map((e) => ({
        at: e.at.toISOString(),
        environment: e.chain ? (ENV[e.chain] ?? e.chain) : null,
        ref: e.chain ? `${e.chain} #${e.seq}` : 'unchained',
        ...describeEvent(e.type, (e.payload ?? {}) as P),
      })),
      ...cycles.map((c) => ({
        at: (c.finishedAt ?? c.startedAt).toISOString(),
        kind: 'snapshot' as const,
        title: c.trigger === 'on_demand' ? 'Market analysis run on request' : 'New market snapshot',
        result:
          c.status === 'success'
            ? `${c.records.toLocaleString('en-US')} records collected`
            : c.status === 'running'
              ? 'Running now'
              : c.status === 'partial'
                ? 'Partly collected: some sources failed'
                : 'Collection failed',
        explanation:
          c.error ??
          (c.registryScan
            ? 'Includes a full scan of all Rhea pools.'
            : 'Prices, tracked pools and Burrow markets.'),
        tone: cycleTone(c.status),
        environment: 'Shadow mainnet',
        ref: `collector cycle ${c.id}`,
      })),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, limit);
    return { items };
  });

  /** What the System Health page shows. Every check is a read; a failing check is reported, never hidden. */
  app.get('/v1/analytics/system', async () => {
    const t0 = Date.now();
    const db = await (async () => {
      try {
        const r = await store.db.execute<{ n: number }>(
          sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
        );
        return {
          ok: true,
          latencyMs: Date.now() - t0,
          migrations: r.rows[0]?.n ?? null,
          error: null,
        };
      } catch (e) {
        return {
          ok: false,
          latencyMs: null,
          migrations: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    })();
    const cycles = await store.recentCycles(50).catch(() => []);
    const last = cycles[0] ?? null;
    const lastOk = cycles.find((c) => c.status === 'success' || c.status === 'partial') ?? null;
    const age = lastOk?.finishedAt
      ? Math.round((now().getTime() - lastOk.finishedAt.getTime()) / 1000)
      : null;
    return {
      now: now().toISOString(),
      api: { ok: true },
      database: db,
      collector: {
        lastStatus: last?.status ?? null,
        lastStartedAt: last?.startedAt ?? null,
        lastSuccessAt: lastOk?.finishedAt ?? null,
        dataAgeSeconds: age,
        stale: age === null || age > intervalSeconds * 2 + 300,
        intervalSeconds,
        last50: {
          success: cycles.filter((c) => c.status === 'success').length,
          partial: cycles.filter((c) => c.status === 'partial').length,
          failed: cycles.filter((c) => c.status === 'failed').length,
        },
        sources:
          (lastOk?.sources as
            | { source: string; health: string; detail: string | null; records?: number }[]
            | undefined) ?? [],
      },
    };
  });
}
