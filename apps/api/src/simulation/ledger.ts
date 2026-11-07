import { asc, demoLedger, eq, type Database } from '@near-autopilot/db';
import {
  applyLedger,
  DEMO_PORTFOLIOS,
  type DemoPortfolio,
  type DemoPortfolioId,
  type LedgerEntry,
} from './demo-portfolios';

/** PostgreSQL store of the simulated demo ledger (migration 0016). Simulation only: never chain data. */
export class DemoLedgerStore {
  constructor(private readonly db: Database) {}

  async entries(portfolio: DemoPortfolioId) {
    return this.db
      .select()
      .from(demoLedger)
      .where(eq(demoLedger.portfolio, portfolio))
      .orderBy(asc(demoLedger.id));
  }

  /** The demo portfolio as it stands now: base amounts with every entry since the last reset applied. */
  async current(
    portfolio: DemoPortfolioId,
  ): Promise<{ portfolio: DemoPortfolio; changes: number; since: Date | null }> {
    const rows = await this.entries(portfolio);
    const lastReset = rows.map((r) => r.kind).lastIndexOf('reset');
    const live = rows.slice(lastReset + 1);
    const entries: LedgerEntry[] = live.map((r) => ({
      kind: r.kind,
      asset: r.asset,
      amountRaw: BigInt(r.amountRaw),
    }));
    return {
      portfolio: applyLedger(DEMO_PORTFOLIOS[portfolio], entries),
      changes: live.length,
      since: live[0]?.at ?? null,
    };
  }

  async append(e: {
    portfolio: DemoPortfolioId;
    kind: 'repay' | 'supply' | 'reset';
    asset: 'near' | 'usdt' | null;
    amountRaw: bigint;
    usd: number | null;
    requestId: string | null;
    by: string;
    at: Date;
  }): Promise<void> {
    await this.db.insert(demoLedger).values({ ...e, amountRaw: e.amountRaw.toString() });
  }
}
