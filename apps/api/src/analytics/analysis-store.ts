import { accountAnalyses, and, eq, lt, type Database } from '@near-autopilot/db';
import type { AccountId } from '@near-autopilot/core';
import type { StrategyId } from '@near-autopilot/core/strategy';
import type { Analysis, AnalysisStore, SavedAnalysis } from './ai-analysis';

export const ANALYSES_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** PostgreSQL store of the last AI analysis per account and strategy (migration 0025). */
export class DrizzleAnalysisStore implements AnalysisStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async latest(accountId: AccountId, strategy: StrategyId): Promise<SavedAnalysis | null> {
    const [row] = await this.db
      .select()
      .from(accountAnalyses)
      .where(and(eq(accountAnalyses.accountId, accountId), eq(accountAnalyses.strategy, strategy)));
    return row
      ? {
          key: row.analysisKey,
          signature: row.signature,
          at: row.at,
          analysis: row.analysis as Analysis,
        }
      : null;
  }

  async save(accountId: AccountId, strategy: StrategyId, saved: SavedAnalysis): Promise<void> {
    const row = {
      analysisKey: saved.key,
      signature: saved.signature,
      at: saved.at,
      analysis: saved.analysis,
    };
    await this.db
      .insert(accountAnalyses)
      .values({ accountId, strategy, ...row })
      .onConflictDoUpdate({
        target: [accountAnalyses.accountId, accountAnalyses.strategy],
        set: row,
      });
  }

  async purge(): Promise<void> {
    await this.db
      .delete(accountAnalyses)
      .where(lt(accountAnalyses.at, new Date(this.now().getTime() - ANALYSES_KEEP_MS)));
  }
}
