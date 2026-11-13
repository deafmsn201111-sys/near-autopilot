import { eq, gte, llmCalls, llmSettings, lt, sql, type Database } from '@near-autopilot/db';
import {
  utcMidnight,
  type AdminStore,
  type LlmSettings,
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
