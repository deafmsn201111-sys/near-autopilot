import { and, desc, eq, events, gte, inArray, lt, type Database } from '@near-autopilot/db';
import { FUNNEL_STEPS, type FunnelEvent } from './admin';
import { EVENTS_KEEP_MS, type AppEvent, type EventStore, type StoredEvent } from './events';

type Row = typeof events.$inferSelect;

const toEvent = (r: Row): StoredEvent => ({
  id: r.id,
  at: r.at,
  kind: r.kind,
  accountId: r.accountId,
  source: r.source,
  cascadeId: r.cascadeId,
  intent: r.intent,
  verdict: r.verdict,
  checks: r.checks,
  txHash: r.txHash,
  detail: r.detail,
});

/** PostgreSQL store of app events (migration 0021). */
export class DrizzleEventStore implements EventStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async add(e: AppEvent): Promise<boolean> {
    const stored = await this.db
      .insert(events)
      .values({
        at: e.at,
        kind: e.kind,
        accountId: e.accountId,
        source: e.source,
        cascadeId: e.cascadeId ?? null,
        intent: e.intent ?? null,
        verdict: e.verdict ?? null,
        checks: e.checks ? [...e.checks] : null,
        txHash: e.txHash ?? null,
        detail: e.detail ?? {},
      })
      .onConflictDoNothing()
      .returning({ id: events.id });
    return stored.length > 0;
  }

  async hasSince(accountId: string, kind: AppEvent['kind'], since: Date): Promise<boolean> {
    const rows = await this.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.accountId, accountId), eq(events.kind, kind), gte(events.at, since)))
      .limit(1);
    return rows.length > 0;
  }

  async byCascade(cascadeId: string): Promise<readonly StoredEvent[]> {
    const rows = await this.db.select().from(events).where(eq(events.cascadeId, cascadeId));
    return rows.map(toEvent);
  }

  async forAccount(accountId: string, limit: number): Promise<readonly StoredEvent[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(eq(events.accountId, accountId))
      .orderBy(desc(events.at))
      .limit(limit);
    return rows.map(toEvent);
  }

  async verdicts(limit: number): Promise<readonly StoredEvent[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(inArray(events.kind, ['prepare', 'prepare_blocked']))
      .orderBy(desc(events.at))
      .limit(limit);
    return rows.map(toEvent);
  }

  /** The funnel steps at or after `at`, for the admin Funnel screen. */
  async since(at: Date): Promise<FunnelEvent[]> {
    return this.db
      .select({ at: events.at, kind: events.kind, accountId: events.accountId })
      .from(events)
      .where(and(gte(events.at, at), inArray(events.kind, [...FUNNEL_STEPS]))) as Promise<
      FunnelEvent[]
    >;
  }

  async purge(): Promise<void> {
    await this.db
      .delete(events)
      .where(lt(events.at, new Date(this.now().getTime() - EVENTS_KEEP_MS)));
  }
}
