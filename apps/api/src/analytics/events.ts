import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { accountIdSchema } from '@near-autopilot/core';
import { z } from 'zod';

/**
 * What real users did through the app (#32), one row per event. Account id only: no IP, no visitor key, nothing from
 * the request headers. `client` rows are what the browser reported and prove nothing; `rpc` rows were confirmed by NEAR.
 */
export type EventKind =
  | 'connect'
  | 'verified'
  | 'analyse'
  | 'prepare'
  | 'prepare_blocked'
  | 'signed'
  | 'oneclick_quote'
  | 'oneclick_final';

export interface AppEvent {
  readonly at: Date;
  readonly kind: EventKind;
  readonly accountId: string;
  readonly source: 'client' | 'server' | 'rpc';
  readonly cascadeId?: string | null;
  readonly intent?: Record<string, unknown> | null;
  readonly verdict?: 'ALLOW' | 'BLOCK' | null;
  readonly checks?: readonly unknown[] | null;
  readonly txHash?: string | null;
  readonly detail?: Record<string, unknown>;
}

export interface StoredEvent extends AppEvent {
  readonly id: number;
}

export interface EventStore {
  /** False when the row was not stored because its tx hash already is. */
  add(e: AppEvent): Promise<boolean>;
  hasSince(accountId: string, kind: EventKind, since: Date): Promise<boolean>;
  byCascade(cascadeId: string): Promise<readonly StoredEvent[]>;
  forAccount(accountId: string, limit: number): Promise<readonly StoredEvent[]>;
  verdicts(limit: number): Promise<readonly StoredEvent[]>;
  /** Deletes rows older than 30 days. */
  purge(): Promise<void>;
}

export const EVENTS_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Recording is best effort: a failed write is logged and never fails the user's request. */
export function eventRecorder(store: EventStore | undefined, log: FastifyBaseLogger) {
  return async (e: AppEvent): Promise<void> => {
    if (!store) return;
    await store.add(e).catch((err: unknown) => log.warn({ err, kind: e.kind }, 'event not stored'));
  };
}

export interface CascadeItem {
  readonly type: 'cascade';
  readonly at: string;
  readonly cascadeId: string;
  readonly action: string;
  readonly preview: readonly string[];
  readonly status: 'confirmed' | 'partial' | 'not_signed' | 'blocked';
  readonly steps: number;
  readonly signed: readonly { at: string; hash: string; lines: readonly string[] }[];
}

export type ActivityItem =
  | CascadeItem
  | { readonly type: 'analyse'; readonly at: string; readonly source: string }
  | { readonly type: 'connect' | 'verified'; readonly at: string }
  | {
      readonly type: 'oneclick_quote';
      readonly at: string;
      readonly detail: Record<string, unknown>;
    };

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * The account's timeline, newest first, one item per cascade (prepared → signed). The public view (no ownership proof)
 * holds only RPC-confirmed transactions and the cascades they belong to.
 */
export function activityTimeline(
  rows: readonly StoredEvent[],
  opts: { readonly owner: boolean },
): ActivityItem[] {
  const signedBy = new Map<string, StoredEvent[]>();
  for (const r of rows)
    if (r.kind === 'signed' && r.cascadeId)
      signedBy.set(r.cascadeId, [...(signedBy.get(r.cascadeId) ?? []), r]);
  const items: ActivityItem[] = [];
  for (const r of rows) {
    const at = r.at.toISOString();
    if (r.kind === 'prepare' || r.kind === 'prepare_blocked') {
      const signed = (signedBy.get(r.cascadeId ?? '') ?? []).sort(
        (a, b) => a.at.getTime() - b.at.getTime(),
      );
      if (!opts.owner && signed.length === 0) continue;
      const steps = Array.isArray(r.detail?.['steps']) ? r.detail['steps'].length : 0;
      items.push({
        type: 'cascade',
        at,
        cascadeId: r.cascadeId ?? '',
        action: typeof r.intent?.['action'] === 'string' ? r.intent['action'] : 'unknown',
        preview: stringList(r.detail?.['preview']),
        status:
          r.kind === 'prepare_blocked'
            ? 'blocked'
            : signed.length === 0
              ? 'not_signed'
              : signed.length >= steps
                ? 'confirmed'
                : 'partial',
        steps,
        signed: signed.map((s) => ({
          at: s.at.toISOString(),
          hash: s.txHash ?? '',
          lines: stringList(s.detail?.['lines']),
        })),
      });
    } else if (!opts.owner) continue;
    else if (r.kind === 'analyse')
      items.push({
        type: 'analyse',
        at,
        source: r.detail?.['source'] === 'ai' ? 'ai' : 'heuristic',
      });
    else if (r.kind === 'connect' || r.kind === 'verified') items.push({ type: r.kind, at });
    else if (r.kind === 'oneclick_quote')
      items.push({ type: 'oneclick_quote', at, detail: r.detail ?? {} });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** The public policy page names no account: "ali…near" for a named one, "1a2b3c…9f0e" for an implicit one. */
export const shortAccount = (id: string) => {
  const dot = id.lastIndexOf('.');
  return dot > 0 ? `${id.slice(0, 3)}…${id.slice(dot + 1)}` : `${id.slice(0, 6)}…${id.slice(-4)}`;
};

/** The public policy page shows which action on which tokens, never the amounts. */
const publicIntent = (intent: Record<string, unknown> | null | undefined) =>
  intent
    ? Object.fromEntries(
        Object.entries(intent).filter(([k]) =>
          ['action', 'token', 'tokenOut', 'poolId'].includes(k),
        ),
      )
    : null;

/** Check messages are built by our validator from our own cascades; the account and any amount are still cut out. */
const masked = (text: string, accountId: string) =>
  text
    .split(accountId)
    .join(shortAccount(accountId))
    .replace(/\d{7,}/g, '…');

const publicChecks = (checks: readonly unknown[] | null | undefined, accountId: string) =>
  z
    .array(z.object({ rule: z.string(), pass: z.boolean(), messages: z.array(z.string()) }))
    .catch([])
    .parse(checks ?? [])
    .map((c) => ({ ...c, messages: c.messages.map((m) => masked(m, accountId)) }));

/** What the checks saw, without the account and without the user's own NEAR when a step wraps it. */
function publicSummary(summary: unknown, accountId: string) {
  const s = z
    .object({
      receivers: z.array(z.string()),
      methods: z.array(z.string()),
      gas: z.string(),
      deposit: z.string(),
    })
    .safeParse(summary);
  if (!s.success) return null;
  return {
    signer: shortAccount(accountId),
    receivers: s.data.receivers,
    methods: s.data.methods,
    gas: s.data.gas,
    deposit: s.data.methods.includes('near_deposit') ? null : s.data.deposit,
  };
}

const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function registerEvents(app: FastifyInstance, store: EventStore, now: () => Date) {
  /** The browser reports a wallet connect. Unproven, stored as client-reported, at most once per account per UTC day. */
  app.post('/v1/events', async (req, reply) => {
    const body = z
      .object({ kind: z.literal('connect'), account: accountIdSchema })
      .strict()
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid event' });
    const at = now();
    if (await store.hasSince(body.data.account, 'connect', utcDay(at))) return { stored: false };
    await store.add({ at, kind: 'connect', accountId: body.data.account, source: 'client' });
    return { stored: true };
  });

  /** Verdicts of the cascades real prepares built (latest first). Account ids are shortened for this public page. */
  app.get('/v1/analytics/policy/cascades', async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(req.query);
    const rows = await store.verdicts(q.limit);
    return {
      verdicts: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        account: shortAccount(r.accountId),
        action: typeof r.intent?.['action'] === 'string' ? r.intent['action'] : 'unknown',
        intent: publicIntent(r.intent),
        verdict: r.verdict ?? (r.kind === 'prepare' ? 'ALLOW' : 'BLOCK'),
        checks: publicChecks(r.checks, r.accountId),
        summary: publicSummary(r.detail?.['summary'], r.accountId),
      })),
    };
  });
}
