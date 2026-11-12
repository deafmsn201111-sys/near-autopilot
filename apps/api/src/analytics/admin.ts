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

export interface AdminStore {
  settings(): Promise<LlmSettings>;
  /** Calls at or after `since` (llm_calls keeps 7 days). */
  recentCalls(since: Date): Promise<SpendRow[]>;
  saveSettings(patch: SettingsPatch): Promise<void>;
}

export interface AdminDeps {
  /** ADMIN_API_TOKEN: the only token /v1/admin/* accepts. */
  readonly token: string;
  readonly store: AdminStore;
  /** LLM_DAILY_CAP_USD in micro-USD, the cap while the settings row sets none. */
  readonly defaultCapMicro: bigint;
}

const usd = (micro: bigint) => Number(micro) / 1e6;
const micro = (usdAmount: number) => BigInt(Math.round(usdAmount * 1e6));
const sum = (rows: readonly SpendRow[]) => rows.reduce((t, r) => t + r.costMicroUsd, 0n);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (d: Date) =>
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
  const dailyAvgUsd = usd(total) / WINDOW_DAYS;
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

const settingsBody = z
  .object({
    llmEnabled: z.boolean().optional(),
    dailyCapUsd: z.number().positive().max(1000).optional(),
    depositUsd: z.number().positive().max(1_000_000).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');

/** Admin routes; the token check for /v1/admin/* is in the server's onRequest hook. */
export function registerAdmin(app: FastifyInstance, deps: AdminDeps, now: () => Date) {
  const summary = async () => {
    const at = now();
    const [rows, settings] = await Promise.all([
      deps.store.recentCalls(windowStart(at)),
      deps.store.settings(),
    ]);
    return spendSummary(rows, settings, deps.defaultCapMicro, at);
  };

  app.get('/v1/admin/spend', summary);

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
