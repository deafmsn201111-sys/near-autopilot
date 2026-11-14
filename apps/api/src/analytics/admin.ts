import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;

export interface SpendRow {
  readonly at: Date;
  readonly model: string;
  readonly costMicroUsd: bigint;
}

export interface LlmSettings {
  readonly dailyCapMicroUsd: bigint | null;
  readonly llmEnabled: boolean;
  readonly depositMicroUsd: bigint | null;
  readonly depositSetAt: Date | null;
}

export type SettingsPatch = Partial<Omit<LlmSettings, 'depositSetAt'>> & {
  readonly depositSetAt?: Date;
};

/** One llm_calls row as the LLM quality screen reads it; input and output are stored JSON, shape unchecked. */
export interface QualityRow {
  readonly at: Date;
  readonly accountId: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly tools: readonly string[];
  readonly outcome: string;
  readonly input: unknown;
  readonly output: unknown;
}

export const FUNNEL_STEPS = ['connect', 'analyse', 'prepare', 'signed'] as const;

export interface FunnelEvent {
  readonly at: Date;
  readonly kind: (typeof FUNNEL_STEPS)[number];
  readonly accountId: string;
}

export interface AdminStore {
  settings(): Promise<LlmSettings>;
  /** Calls at or after `since` (llm_calls keeps 7 days). */
  recentCalls(since: Date): Promise<SpendRow[]>;
  /** The same calls with what the LLM quality screen needs. */
  calls(since: Date): Promise<QualityRow[]>;
  saveSettings(patch: SettingsPatch): Promise<void>;
}

export interface AdminDeps {
  /** ADMIN_API_TOKEN: the only token /v1/admin/* accepts. */
  readonly token: string;
  readonly store: AdminStore;
  /** LLM_DAILY_CAP_USD in micro-USD, the cap while the settings row sets none. */
  readonly defaultCapMicro: bigint;
  /** Funnel steps from the events table; absent = the funnel is empty. */
  readonly events?: { since(at: Date): Promise<FunnelEvent[]> };
}

const usd = (micro: bigint) => Number(micro) / 1e6;
const micro = (usdAmount: number) => BigInt(Math.round(usdAmount * 1e6));
const sum = (rows: readonly SpendRow[]) => rows.reduce((t, r) => t + r.costMicroUsd, 0n);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
export const utcMidnight = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const windowStart = (now: Date) =>
  new Date(utcMidnight(now).getTime() - (WINDOW_DAYS - 1) * DAY_MS);

/** The Spend screen: today vs cap, 7 UTC days, model split, average per analysis, deposit run-out estimate. */
export function spendSummary(
  rows: readonly SpendRow[],
  settings: LlmSettings,
  defaultCapMicro: bigint,
  now: Date,
) {
  const start = windowStart(now);
  const inWindow = rows.filter((r) => r.at >= start && r.at <= now);
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const day = dayOf(new Date(start.getTime() + i * DAY_MS));
    return { day, usd: usd(sum(inWindow.filter((r) => dayOf(r.at) === day))) };
  });
  const models = [...new Set(inWindow.map((r) => r.model))].sort().map((model) => {
    const own = inWindow.filter((r) => r.model === model);
    return { model, analyses: own.length, usd: usd(sum(own)) };
  });
  const total = sum(inWindow);
  // Over the days since the first call in the window, so a new server does not report a 7x lower average.
  const first = inWindow.reduce<Date | null>((m, r) => (m === null || r.at < m ? r.at : m), null);
  const spanDays = first
    ? Math.round((utcMidnight(now).getTime() - utcMidnight(first).getTime()) / DAY_MS) + 1
    : WINDOW_DAYS;
  const dailyAvgUsd = usd(total) / spanDays;
  const cap = settings.dailyCapMicroUsd ?? defaultCapMicro;

  let deposit = null;
  if (settings.depositMicroUsd !== null && settings.depositSetAt) {
    const since = settings.depositSetAt;
    // ponytail: spend older than 7 days is purged, so a balance entered earlier undercounts; the screen asks to re-enter it.
    const spent = sum(rows.filter((r) => r.at >= since));
    const left = settings.depositMicroUsd - spent;
    const runOut =
      left <= 0n
        ? now
        : dailyAvgUsd > 0
          ? new Date(now.getTime() + (usd(left) / dailyAvgUsd) * DAY_MS)
          : null;
    deposit = {
      balanceUsd: usd(settings.depositMicroUsd),
      enteredAt: since.toISOString(),
      enteredDaysAgo: Math.floor((now.getTime() - since.getTime()) / DAY_MS),
      spentSinceUsd: usd(spent),
      leftUsd: usd(left),
      runOutDate: runOut ? dayOf(runOut) : null,
    };
  }

  return {
    llmEnabled: settings.llmEnabled,
    todayUsd: usd(sum(inWindow.filter((r) => r.at >= utcMidnight(now)))),
    capUsd: usd(cap),
    capIsDefault: settings.dailyCapMicroUsd === null,
    days,
    models,
    analyses: inWindow.length,
    avgPerAnalysisUsd: inWindow.length ? usd(total) / inWindow.length : null,
    dailyAvgUsd,
    deposit,
  };
}

function funnelCounts(events: readonly FunnelEvent[]) {
  const count = (kind: FunnelEvent['kind']) => events.filter((e) => e.kind === kind).length;
  return {
    connect: count('connect'),
    analyse: count('analyse'),
    prepare: count('prepare'),
    signed: count('signed'),
    accounts: new Set(events.map((e) => e.accountId)).size,
  };
}

// ponytail: reads 7 days of rows into memory; move counts to SQL GROUP BY if the events table grows past ~100k a week.
/** The Funnel screen: each step per UTC day for 7 days, and unique accounts per day and over the 7 days. */
export function funnelSummary(events: readonly FunnelEvent[], now: Date) {
  const start = windowStart(now);
  const inWindow = events.filter((e) => e.at >= start && e.at <= now);
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const day = dayOf(new Date(start.getTime() + i * DAY_MS));
    return { day, ...funnelCounts(inWindow.filter((e) => dayOf(e.at) === day)) };
  });
  return { days, total: funnelCounts(inWindow) };
}

/** Like PostgreSQL percentile_cont: linear between the two nearest ranks. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

const picksShape = z.object({ picks: z.array(z.object({ kind: z.string().nullable() })) });
const LAST_RUNS = 20;

/** The LLM quality screen, over runs that reached the model in the last 7 UTC days. */
export function llmQuality(rows: readonly QualityRow[], now: Date) {
  const start = windowStart(now);
  const runs = rows.filter((r) => r.at >= start && r.at <= now);
  const rate = (n: number) => (runs.length ? n / runs.length : null);
  const tally = (keys: readonly string[]) =>
    [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  const failed = runs.filter((r) => r.outcome !== 'ok');
  const latency = runs.map((r) => r.latencyMs).sort((a, b) => a - b);
  const kinds = runs.flatMap((r) => {
    const out = picksShape.safeParse(r.output);
    return out.success ? out.data.picks.flatMap((p) => (p.kind === null ? [] : [p.kind])) : [];
  });
  return {
    calls: runs.length,
    fallbackRate: rate(failed.length),
    validationErrorRate: rate(failed.filter((r) => r.outcome === 'invalid_output').length),
    fallbacks: tally(failed.map((r) => r.outcome)).map(([code, count]) => ({
      code,
      count,
      rate: count / runs.length,
    })),
    p50Ms: percentile(latency, 0.5),
    p95Ms: percentile(latency, 0.95),
    topKinds: tally(kinds).map(([kind, count]) => ({ kind, count })),
    last: [...runs]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, LAST_RUNS)
      .map((r) => ({ ...r, at: r.at.toISOString() })),
  };
}

const settingsBody = z
  .object({
    llmEnabled: z.boolean().optional(),
    dailyCapUsd: z.number().min(0.01).max(1000).optional(),
    depositUsd: z.number().min(0.01).max(1_000_000).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');

/** Admin routes; the token check for /v1/admin/* is in the server's onRequest hook. */
export function registerAdmin(app: FastifyInstance, deps: AdminDeps, now: () => Date) {
  const summary = async () => {
    const at = now();
    const settings = await deps.store.settings();
    const start = windowStart(at);
    // Back to the deposit entry too, so spend before the 7-day window still counts against it.
    const since =
      settings.depositSetAt && settings.depositSetAt < start ? settings.depositSetAt : start;
    const rows = await deps.store.recentCalls(since);
    return spendSummary(rows, settings, deps.defaultCapMicro, at);
  };

  app.get('/v1/admin/spend', summary);

  app.get('/v1/admin/funnel', async () => {
    const at = now();
    return funnelSummary((await deps.events?.since(windowStart(at))) ?? [], at);
  });

  app.get('/v1/admin/llm', async () => {
    const at = now();
    return llmQuality(await deps.store.calls(windowStart(at)), at);
  });

  app.post('/v1/admin/settings', async (req) => {
    const body = settingsBody.parse(req.body);
    await deps.store.saveSettings({
      ...(body.llmEnabled !== undefined ? { llmEnabled: body.llmEnabled } : {}),
      ...(body.dailyCapUsd !== undefined ? { dailyCapMicroUsd: micro(body.dailyCapUsd) } : {}),
      ...(body.depositUsd !== undefined
        ? { depositMicroUsd: micro(body.depositUsd), depositSetAt: now() }
        : {}),
    });
    return summary();
  });
}
