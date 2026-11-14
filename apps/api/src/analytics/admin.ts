import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminDepositDeps } from './admin-deposits';

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

/**
 * One row of the funnel GROUPING SETS: `day` null = the 7-day total, `kind` null = unique accounts over all steps.
 * `day` is a UTC date, YYYY-MM-DD.
 */
export interface FunnelCount {
  readonly day: string | null;
  readonly kind: (typeof FUNNEL_STEPS)[number] | null;
  readonly events: number;
  readonly accounts: number;
}

/** LLM quality aggregates over a window, counted in SQL; `last` = the newest runs. */
export interface QualityStats {
  readonly outcomes: readonly { readonly outcome: string; readonly count: number }[];
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly kinds: readonly { readonly kind: string; readonly count: number }[];
  readonly last: readonly QualityRow[];
}

export const LAST_RUNS = 20;

export interface AdminStore {
  settings(): Promise<LlmSettings>;
  /** Calls at or after `since` (llm_calls keeps 7 days). */
  recentCalls(since: Date): Promise<SpendRow[]>;
  /** LLM quality over calls in [from, to]. */
  quality(from: Date, to: Date): Promise<QualityStats>;
  saveSettings(patch: SettingsPatch): Promise<void>;
}

export interface AdminDeps {
  /** ADMIN_API_TOKEN: the only token /v1/admin/* accepts. */
  readonly token: string;
  readonly store: AdminStore;
  /** LLM_DAILY_CAP_USD in micro-USD, the cap while the settings row sets none. */
  readonly defaultCapMicro: bigint;
  /** Funnel steps from the events table; absent = the funnel is empty. */
  readonly events?: { funnel(from: Date, to: Date): Promise<FunnelCount[]> };
  /** The 1Click screen; absent = no /v1/admin/deposits. */
  readonly deposits?: AdminDepositDeps;
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

const noSteps = () => ({ connect: 0, analyse: 0, prepare: 0, signed: 0, accounts: 0 });

/** The Funnel screen: each step per UTC day for 7 days, and unique accounts per day and over the 7 days. */
export function funnelSummary(counts: readonly FunnelCount[], now: Date) {
  const start = windowStart(now);
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => ({
    day: dayOf(new Date(start.getTime() + i * DAY_MS)),
    ...noSteps(),
  }));
  const total = noSteps();
  for (const c of counts) {
    const target = c.day === null ? total : days.find((d) => d.day === c.day);
    if (!target) continue;
    if (c.kind === null) target.accounts = c.accounts;
    else target[c.kind] = c.events;
  }
  return { days, total };
}

const byCount =
  <T extends { count: number }>(key: (t: T) => string) =>
  (a: T, b: T) =>
    b.count - a.count || key(a).localeCompare(key(b));

/** The LLM quality screen, over runs that reached the model in the last 7 UTC days. */
export function llmQuality(stats: QualityStats) {
  const countOf = (rows: readonly { count: number }[]) => rows.reduce((t, o) => t + o.count, 0);
  const calls = countOf(stats.outcomes);
  const rate = (n: number) => (calls ? n / calls : null);
  const failed = stats.outcomes.filter((o) => o.outcome !== 'ok');
  return {
    calls,
    fallbackRate: rate(countOf(failed)),
    validationErrorRate: rate(countOf(failed.filter((o) => o.outcome === 'invalid_output'))),
    fallbacks: [...failed]
      .sort(byCount((o) => o.outcome))
      .map(({ outcome, count }) => ({ code: outcome, count, rate: count / calls })),
    p50Ms: stats.p50Ms,
    p95Ms: stats.p95Ms,
    topKinds: [...stats.kinds].sort(byCount((k) => k.kind)),
    last: stats.last.map((r) => ({ ...r, at: r.at.toISOString() })),
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
    return funnelSummary((await deps.events?.funnel(windowStart(at), at)) ?? [], at);
  });

  app.get('/v1/admin/llm', async () => {
    const at = now();
    return llmQuality(await deps.store.quality(windowStart(at), at));
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
