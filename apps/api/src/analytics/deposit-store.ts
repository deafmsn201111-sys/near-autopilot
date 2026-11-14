import { depositQuotes, desc, eq, gte, lt, type Database } from '@near-autopilot/db';
import type { SwapStatus } from '../gateway/one-click-deposit';
import type { AdminDepositRow, AdminDepositStore } from './admin-deposits';
import type { DepositQuoteStore, StoredDepositQuote } from './deposit';

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** PostgreSQL store of real 1Click deposit quotes (migration 0020). */
export class DrizzleDepositQuoteStore implements DepositQuoteStore, AdminDepositStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async save(q: StoredDepositQuote): Promise<void> {
    await this.db.insert(depositQuotes).values(q);
  }

  async find(id: string): Promise<(StoredDepositQuote & { status: string | null }) | null> {
    const [row] = await this.db.select().from(depositQuotes).where(eq(depositQuotes.id, id));
    return row ?? null;
  }

  async saveStatus(id: string, status: SwapStatus, at: Date): Promise<void> {
    await this.db
      .update(depositQuotes)
      .set({ status, statusAt: at })
      .where(eq(depositQuotes.id, id));
  }

  async recent(since: Date): Promise<AdminDepositRow[]> {
    return this.db
      .select()
      .from(depositQuotes)
      .where(gte(depositQuotes.createdAt, since))
      .orderBy(desc(depositQuotes.createdAt));
  }

  async purge(): Promise<void> {
    await this.db
      .delete(depositQuotes)
      .where(lt(depositQuotes.createdAt, new Date(this.now().getTime() - KEEP_MS)));
  }
}
