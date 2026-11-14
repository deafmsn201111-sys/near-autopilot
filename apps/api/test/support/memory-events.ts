import type { AppEvent, EventStore, StoredEvent } from '../../src/analytics/events';

/** In-memory EventStore with the same rules as the Postgres one (unique tx hash, newest first). */
export class MemoryEventStore implements EventStore {
  readonly rows: StoredEvent[] = [];

  async add(e: AppEvent): Promise<boolean> {
    if (e.txHash && this.rows.some((r) => r.txHash === e.txHash)) return false;
    this.rows.push({ ...e, id: this.rows.length + 1 });
    return true;
  }
  async hasSince(accountId: string, kind: AppEvent['kind'], since: Date) {
    return this.rows.some((r) => r.accountId === accountId && r.kind === kind && r.at >= since);
  }
  async byCascade(cascadeId: string) {
    return this.rows.filter((r) => r.cascadeId === cascadeId);
  }
  async forAccount(accountId: string, limit: number) {
    return this.newest()
      .filter((r) => r.accountId === accountId)
      .slice(0, limit);
  }
  async verdicts(limit: number) {
    return this.newest()
      .filter((r) => r.kind === 'prepare' || r.kind === 'prepare_blocked')
      .slice(0, limit);
  }
  async purge() {}
  private newest() {
    return [...this.rows].sort((a, b) => b.at.getTime() - a.at.getTime());
  }
}
