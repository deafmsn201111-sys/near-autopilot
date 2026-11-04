import { canonicalJson, toJsonSafe } from '@near-autopilot/core';
import { sha256Hex } from '@near-autopilot/core/hash';
import type {
  ActionRecord,
  AuditEntry,
  AuditEntryInput,
  AuditLog,
  ControlState,
  ControlStore,
  CycleRecord,
  CycleSummary,
  IdempotencyStore,
} from './ports';
import type { ActionStatus, RecentAction } from './types';

/*
 * In-memory reference implementations of the persistence ports. They define the contract (and are what the tests
 * exercise); a production deployment needs durable implementations with the same semantics (for example Postgres,
 * with `begin` as an INSERT ... ON CONFLICT DO NOTHING and `append` inside a serialisable transaction). None is
 * provided here, and the in-memory ones lose everything on restart.
 */

const GENESIS = '0'.repeat(64);

export function entryHash(prevHash: string, entry: Omit<AuditEntry, 'prevHash' | 'hash'>): string {
  return sha256Hex(
    prevHash +
      canonicalJson({
        seq: entry.seq,
        at: entry.at,
        type: entry.type,
        cycleKey: entry.cycleKey,
        decisionId: entry.decisionId,
        payload: entry.payload,
      }),
  );
}

export class InMemoryAuditLog implements AuditLog {
  private readonly log: AuditEntry[] = [];
  /** Test hook: make the next appends fail, to prove nothing executes without an audit trail. */
  failAppends = false;

  async append(input: AuditEntryInput): Promise<AuditEntry> {
    if (this.failAppends) throw new Error('audit store unavailable');
    const prevHash = this.log.at(-1)?.hash ?? GENESIS;
    const payload = toJsonSafe(input.payload) as Record<string, unknown>;
    const partial = {
      seq: this.log.length + 1,
      at: input.at,
      type: input.type,
      cycleKey: input.cycleKey,
      decisionId: input.decisionId,
      payload,
    };
    const entry: AuditEntry = { ...partial, prevHash, hash: entryHash(prevHash, partial) };
    this.log.push(entry);
    return entry;
  }

  async entries(): Promise<readonly AuditEntry[]> {
    return this.log.map((e) => structuredClone(e));
  }

  async verify(): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }> {
    return verifyChain(this.log);
  }

  /** Test hook: overwrite an entry in place, which `verify` must then detect. */
  tamper(index: number, patch: Partial<AuditEntry>): void {
    const current = this.log[index];
    if (current) this.log[index] = { ...current, ...patch };
  }
}

export function verifyChain(
  entries: readonly AuditEntry[],
): { ok: true } | { ok: false; brokenAtSeq: number } {
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    const { prevHash, hash, ...rest } = e;
    if (e.seq !== i + 1 || prevHash !== prev || entryHash(prev, rest) !== hash)
      return { ok: false, brokenAtSeq: e.seq };
    prev = hash;
  }
  return { ok: true };
}

export class InMemoryControlStore implements ControlStore {
  private state: ControlState;
  failLoads = false;

  constructor(now: Date, initial?: Partial<ControlState>) {
    this.state = {
      mode: 'normal',
      reason: 'initial',
      since: now,
      changedBy: 'system',
      consecutiveFailures: 0,
      blindCycles: 0,
      quarantined: {},
      ...initial,
    };
  }

  async load(): Promise<ControlState> {
    if (this.failLoads) throw new Error('control store unavailable');
    return structuredClone(this.state);
  }

  async save(next: ControlState): Promise<void> {
    this.state = structuredClone(next);
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly cycles = new Map<string, CycleRecord>();
  private readonly actions: ActionRecord[] = [];

  async begin(key: string, now: Date, takeOverAfterSeconds: number) {
    const existing = this.cycles.get(key);
    if (!existing) {
      this.cycles.set(key, {
        key,
        state: 'in_progress',
        startedAt: now,
        executionStartedFor: null,
        summary: null,
      });
      return { claimed: true as const, tookOver: false };
    }
    // A cycle that was claimed, never reached the executor, and has been silent for a long time died before doing
    // anything irreversible, so a later attempt may take it over. Anything else is a duplicate.
    const silentFor = (now.getTime() - existing.startedAt.getTime()) / 1000;
    if (
      existing.state === 'in_progress' &&
      existing.executionStartedFor === null &&
      silentFor >= takeOverAfterSeconds
    ) {
      this.cycles.set(key, { ...existing, startedAt: now });
      return { claimed: true as const, tookOver: true };
    }
    return { claimed: false as const, existing: structuredClone(existing) };
  }

  async markExecutionStarted(key: string, actionKey: string): Promise<void> {
    const c = this.cycles.get(key);
    if (c) this.cycles.set(key, { ...c, executionStartedFor: actionKey });
  }

  async complete(key: string, summary: CycleSummary): Promise<void> {
    const c = this.cycles.get(key);
    if (c) this.cycles.set(key, { ...c, state: 'completed', summary });
  }

  async markNeedsReconciliation(key: string): Promise<void> {
    const c = this.cycles.get(key);
    if (c) this.cycles.set(key, { ...c, state: 'needs_reconciliation' });
  }

  async recordAction(record: ActionRecord): Promise<void> {
    this.actions.push(structuredClone(record));
  }

  async updateAction(
    actionKey: string,
    decisionId: string,
    patch: { status: ActionStatus; txHash: string | null },
  ): Promise<void> {
    const i = this.actions.findIndex(
      (a) => a.actionKey === actionKey && a.decisionId === decisionId,
    );
    const current = this.actions[i];
    if (current) this.actions[i] = { ...current, ...patch };
  }

  async recentActions(since: Date): Promise<readonly RecentAction[]> {
    return this.actions
      .filter((a) => a.at.getTime() >= since.getTime())
      .map((a) => ({ actionKey: a.actionKey, kind: a.kind, status: a.status, at: a.at }));
  }

  async inDoubt(): Promise<readonly CycleRecord[]> {
    return [...this.cycles.values()]
      .filter((c) => c.executionStartedFor !== null && c.state !== 'completed')
      .map((c) => structuredClone(c));
  }

  /** Test hook: simulate a process that died after the executor was called but before the result was recorded. */
  snapshotCycle(key: string): CycleRecord | undefined {
    return this.cycles.get(key);
  }
}
