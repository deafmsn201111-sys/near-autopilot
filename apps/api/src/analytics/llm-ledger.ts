import {
  and,
  desc,
  eq,
  gte,
  llmCalls,
  llmSettings,
  lt,
  lte,
  sql,
  type Database,
} from '@near-autopilot/db';
import {
  LAST_RUNS,
  utcMidnight,
  type AdminStore,
  type LlmSettings,
  type QualityRow,
  type QualityStats,
  type SettingsPatch,
  type SpendRow,
} from './admin';
import type { LlmCallRecord, LlmLedger } from './ai-analysis';

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** PostgreSQL spend ledger and admin settings of the central LLM (migrations 0018, 0019). */
export class DrizzleLlmLedger implements LlmLedger, AdminStore {
  constructor(
    private readonly db: Database,
    /** LLM_DAILY_CAP_USD in micro-USD: the cap when the settings row sets none. */
    private readonly defaultCapMicro: bigint,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async settings(): Promise<LlmSettings> {
    const [row] = await this.db.select().from(llmSettings).where(eq(llmSettings.id, 1));
    return {
      dailyCapMicroUsd: row?.dailyCapMicroUsd ?? null,
      llmEnabled: row?.llmEnabled ?? true,
      depositMicroUsd: row?.depositMicroUsd ?? null,
      depositSetAt: row?.depositSetAt ?? null,
    };
  }

  async enabled(): Promise<boolean> {
    return (await this.settings()).llmEnabled;
  }

  async saveSettings(patch: SettingsPatch): Promise<void> {
    const values = { ...patch, updatedAt: this.now() };
    await this.db
      .insert(llmSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: llmSettings.id, set: values });
  }

  async recentCalls(since: Date): Promise<SpendRow[]> {
    return this.db
      .select({ at: llmCalls.at, model: llmCalls.model, costMicroUsd: llmCalls.costMicroUsd })
      .from(llmCalls)
      .where(gte(llmCalls.at, since));
  }

  async quality(from: Date, to: Date): Promise<QualityStats> {
    const window = and(gte(llmCalls.at, from), lte(llmCalls.at, to));
    const picks = sql`case when jsonb_typeof(${llmCalls.output} -> 'picks') = 'array'
      then ${llmCalls.output} -> 'picks' else '[]'::jsonb end`;
    // One snapshot and one pool connection for all four reads.
    return this.db.transaction(
      async (tx) => {
        const outcomes = await tx
          .select({ outcome: llmCalls.outcome, count: sql<number>`count(*)::int` })
          .from(llmCalls)
          .where(window)
          .groupBy(llmCalls.outcome);
        const [latency] = await tx
          .select({
            p50Ms: sql<
              number | null
            >`percentile_cont(0.5) within group (order by ${llmCalls.latencyMs})`,
            p95Ms: sql<
              number | null
            >`percentile_cont(0.95) within group (order by ${llmCalls.latencyMs})`,
          })
          .from(llmCalls)
          .where(window);
        const kinds = await tx.execute<{ kind: string; count: number }>(
          sql`select pick ->> 'kind' as kind, count(*)::int as count
              from ${llmCalls}, jsonb_array_elements(${picks}) as pick
              where ${window} and jsonb_typeof(pick -> 'kind') = 'string'
              group by 1`,
        );
        const last = await tx
          .select({
            at: llmCalls.at,
            accountId: llmCalls.accountId,
            model: llmCalls.model,
            latencyMs: llmCalls.latencyMs,
            tools: llmCalls.tools,
            outcome: llmCalls.outcome,
            input: llmCalls.input,
            output: llmCalls.output,
          })
          .from(llmCalls)
          .where(window)
          .orderBy(desc(llmCalls.at), desc(llmCalls.id))
          .limit(LAST_RUNS);
        return {
          outcomes,
          p50Ms: latency?.p50Ms ?? null,
          p95Ms: latency?.p95Ms ?? null,
          kinds: kinds.rows,
          last: last satisfies QualityRow[],
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async remainingTodayMicro(): Promise<bigint> {
    const [settings] = await this.db
      .select({ cap: llmSettings.dailyCapMicroUsd })
      .from(llmSettings)
      .where(eq(llmSettings.id, 1));
    const [spent] = await this.db
      .select({ micro: sql<string>`coalesce(sum(${llmCalls.costMicroUsd}), 0)` })
      .from(llmCalls)
      .where(gte(llmCalls.at, utcMidnight(this.now())));
    return (settings?.cap ?? this.defaultCapMicro) - BigInt(spent?.micro ?? 0);
  }

  async record(call: LlmCallRecord): Promise<void> {
    await this.db.insert(llmCalls).values({ ...call, tools: [...call.tools] });
  }

  /** Deletes calls older than 7 days. */
  async purge(): Promise<void> {
    await this.db.delete(llmCalls).where(lt(llmCalls.at, new Date(this.now().getTime() - KEEP_MS)));
  }
}
