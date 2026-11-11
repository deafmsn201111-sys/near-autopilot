import { eq, gte, llmCalls, llmSettings, lt, sql, type Database } from '@near-autopilot/db';
import type { LlmCallRecord, LlmLedger } from './ai-analysis';

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const utcMidnight = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** PostgreSQL spend ledger of the central LLM (migration 0018). */
export class DrizzleLlmLedger implements LlmLedger {
  constructor(
    private readonly db: Database,
    /** LLM_DAILY_CAP_USD in micro-USD: the cap when the settings row sets none. */
    private readonly defaultCapMicro: bigint,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
