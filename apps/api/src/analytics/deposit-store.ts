import { depositQuotes, lt, type Database } from '@near-autopilot/db';
import type { DepositQuoteStore, StoredDepositQuote } from './deposit';

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** PostgreSQL store of real 1Click deposit quotes (migration 0020). */
export class DrizzleDepositQuoteStore implements DepositQuoteStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async save(q: StoredDepositQuote): Promise<void> {
    await this.db.insert(depositQuotes).values(q);
  }

  async purge(): Promise<void> {
    await this.db
      .delete(depositQuotes)
      .where(lt(depositQuotes.createdAt, new Date(this.now().getTime() - KEEP_MS)));
  }
}
