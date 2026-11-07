import {
  and,
  eq,
  gte,
  isNotNull,
  ne,
  orchestratorActions,
  orchestratorControl,
  orchestratorControlHistory,
  orchestratorCycles,
  sql,
  type Database,
} from '@near-autopilot/db';
import type {
  ActionRecord,
  ControlState,
  ControlStore,
  CycleRecord,
  CycleSummary,
  IdempotencyStore,
} from '@near-autopilot/orchestrator';
import { appendAuditIn, type Tx } from './drizzle-repository';

/**
 * DURABLE orchestrator state in PostgreSQL (migration 0013), replacing the in-process stores, so that an emergency
 * read-only mode, a quarantine, an in-doubt execution and every claimed cycle survive a restart.
 *
 * Fail-safe contract (enforced by the orchestrator's ModeController, not weakened here): if the control row cannot be
 * read, `load` throws and the orchestrator treats the system as READ-ONLY; if a claim cannot be stored, `begin`
 * throws and the cycle aborts before any agent runs. Nothing here ever turns an error into permission.
 */

type Mode = ControlState['mode'];
const RANK: Record<Mode, number> = { normal: 0, risk_reduction_only: 1, read_only: 2 };

/** One deployment and portfolio: rows of different scopes never interact. */
export function orchestratorScope(p: {
  dataSource: string;
  network: string;
  accountId: string;
  portfolio?: string | undefined;
}): string {
  return [p.dataSource, p.network, p.accountId, ...(p.portfolio ? [p.portfolio] : [])].join(':');
}

export class ControlConflictError extends Error {
  constructor(scope: string, expected: number, found: number) {
    super(
      `control state of ${scope} changed concurrently (expected version ${expected}, found ${found}); a milder mode is not written over it`,
    );
    this.name = 'ControlConflictError';
  }
}

type ControlRow = typeof orchestratorControl.$inferSelect;

const toState = (r: ControlRow): ControlState => ({
  mode: r.mode,
  reason: r.reason,
  since: r.since,
  changedBy: r.changedBy,
  consecutiveFailures: r.consecutiveFailures,
  blindCycles: r.blindCycles,
  quarantined: reviveQuarantine(r.quarantined),
});

function reviveQuarantine(v: unknown): ControlState['quarantined'] {
  if (v === null || typeof v !== 'object') return {};
  const out: Record<string, { since: Date; reason: string }> = {};
  for (const [agent, q] of Object.entries(
    v as Record<string, { since?: unknown; reason?: unknown }>,
  )) {
    if (q && typeof q.reason === 'string' && typeof q.since === 'string')
      out[agent] = { since: new Date(q.since), reason: q.reason };
  }
  return out;
}

const quarantineJson = (q: ControlState['quarantined']) =>
  Object.fromEntries(
    Object.entries(q).flatMap(([agent, v]) =>
      v ? [[agent, { since: v.since.toISOString(), reason: v.reason }]] : [],
    ),
  );

const sameState = (a: ControlState, b: ControlState) =>
  a.mode === b.mode &&
  a.reason === b.reason &&
  a.since.getTime() === b.since.getTime() &&
  a.changedBy === b.changedBy &&
  a.consecutiveFailures === b.consecutiveFailures &&
  a.blindCycles === b.blindCycles &&
  JSON.stringify(quarantineJson(a.quarantined)) === JSON.stringify(quarantineJson(b.quarantined));

export class PgControlStore implements ControlStore {
  /** The version this process last read: a write based on an older read is a conflict. */
  private seenVersion: number | null = null;
  /** The mode at that version: a write that is milder than it is a loosening. */
  private seenMode: Mode | null = null;

  constructor(
    private readonly db: Database,
    private readonly scope: string,
    /** The audit chain control changes are recorded on (the deployment's chain). */
    private readonly auditChain: string,
    private readonly clock: { now(): Date },
  ) {}

  async load(): Promise<ControlState> {
    const [row] = await this.db
      .select()
      .from(orchestratorControl)
      .where(eq(orchestratorControl.scope, this.scope))
      .limit(1);
    if (row) {
      this.seenVersion = row.version;
      this.seenMode = row.mode;
      return toState(row);
    }
    // First start of this scope ever: create the initial state, audited. (A later missing row is the same case; the
    // control history and the audit chain still show every earlier version.)
    const initial: ControlState = {
      mode: 'normal',
      reason: 'initial state (first start of this scope)',
      since: this.clock.now(),
      changedBy: 'system',
      consecutiveFailures: 0,
      blindCycles: 0,
      quarantined: {},
    };
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(orchestratorControl)
        .values({ ...this.rowOf(initial, 1), auditChain: null, auditSeq: null })
        .onConflictDoNothing()
        .returning({ scope: orchestratorControl.scope });
      if (inserted.length > 0) {
        const audit = await this.writeChange(tx, null, initial, 1, 'control.initialized');
        await tx
          .update(orchestratorControl)
          .set({ auditChain: audit.chain, auditSeq: audit.seq })
          .where(eq(orchestratorControl.scope, this.scope));
      }
    });
    return this.load();
  }

  /**
   * Persists `next` atomically with a history row and an audit entry. Unchanged state writes nothing. If another
   * process changed the row since this one read it, a LOOSENING (milder than the mode this process read) throws
   * ControlConflictError; any other write is merged with the stored state, keeping the stricter mode.
   */
  async save(next: ControlState): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(orchestratorControl)
        .where(eq(orchestratorControl.scope, this.scope))
        .for('update');
      if (!row)
        throw new Error(
          `control state of ${this.scope} is missing; refusing to recreate it in save`,
        );
      const stored = toState(row);
      if (sameState(stored, next)) return;
      let toWrite = next;
      if (this.seenVersion !== null && row.version !== this.seenVersion) {
        // Someone else changed the row since this process read it. A loosening decided on that old view is refused;
        // anything else is merged so no tightening is lost: the stricter mode (with its reason), the larger counters,
        // the union of quarantines.
        if (this.seenMode !== null && RANK[next.mode] < RANK[this.seenMode])
          throw new ControlConflictError(this.scope, this.seenVersion, row.version);
        const stricter = RANK[stored.mode] > RANK[next.mode] ? stored : next;
        toWrite = {
          ...next,
          mode: stricter.mode,
          reason: stricter.reason,
          since: stricter.since,
          changedBy: stricter.changedBy,
          consecutiveFailures: Math.max(next.consecutiveFailures, stored.consecutiveFailures),
          blindCycles: Math.max(next.blindCycles, stored.blindCycles),
          quarantined: { ...stored.quarantined, ...next.quarantined },
        };
        if (sameState(stored, toWrite)) {
          this.seenVersion = row.version;
          this.seenMode = row.mode;
          return;
        }
      }
      const version = row.version + 1;
      const audit = await this.writeChange(tx, stored, toWrite, version, 'control.changed');
      await tx
        .update(orchestratorControl)
        .set({ ...this.rowOf(toWrite, version), auditChain: audit.chain, auditSeq: audit.seq })
        .where(eq(orchestratorControl.scope, this.scope));
      this.seenVersion = version;
      this.seenMode = toWrite.mode;
    });
  }

  /** The audited change log, newest first (for the dashboard). */
  async history(limit = 50) {
    return this.db
      .select()
      .from(orchestratorControlHistory)
      .where(eq(orchestratorControlHistory.scope, this.scope))
      .orderBy(sql`${orchestratorControlHistory.version} desc`)
      .limit(limit);
  }

  private rowOf(s: ControlState, version: number) {
    return {
      scope: this.scope,
      mode: s.mode,
      reason: s.reason,
      since: s.since,
      changedBy: s.changedBy,
      consecutiveFailures: s.consecutiveFailures,
      blindCycles: s.blindCycles,
      quarantined: quarantineJson(s.quarantined),
      version,
      updatedAt: this.clock.now(),
    };
  }

  private async writeChange(
    tx: Tx,
    previous: ControlState | null,
    next: ControlState,
    version: number,
    type: string,
  ) {
    const state = {
      mode: next.mode,
      reason: next.reason,
      since: next.since.toISOString(),
      changedBy: next.changedBy,
      consecutiveFailures: next.consecutiveFailures,
      blindCycles: next.blindCycles,
      quarantined: quarantineJson(next.quarantined),
    };
    const audit = await appendAuditIn(tx, this.auditChain, {
      at: this.clock.now(),
      type: `orchestrator.${type}`,
      runId: null,
      proposalId: null,
      payload: { scope: this.scope, version, previousMode: previous?.mode ?? null, ...state },
    });
    await tx.insert(orchestratorControlHistory).values({
      scope: this.scope,
      version,
      at: this.clock.now(),
      previousMode: previous?.mode ?? null,
      mode: next.mode,
      reason: next.reason,
      changedBy: next.changedBy,
      state,
      auditChain: audit.chain,
      auditSeq: audit.seq,
    });
    return audit;
  }
}

type CycleRow = typeof orchestratorCycles.$inferSelect;
const toCycle = (r: CycleRow): CycleRecord => ({
  key: r.key,
  state: r.state,
  startedAt: r.startedAt,
  executionStartedFor: r.executionStartedFor,
  summary: (r.summary as CycleSummary | null) ?? null,
});

export class PgIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly db: Database,
    private readonly scope: string,
    private readonly clock: { now(): Date },
  ) {}

  /**
   * Atomic across processes: the insert either creates the claim or hits the primary key; an existing row is then
   * read under a row lock, so two processes can never both take over the same silent cycle.
   */
  async begin(key: string, now: Date, takeOverAfterSeconds: number) {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(orchestratorCycles)
        .values({
          scope: this.scope,
          key,
          state: 'in_progress',
          startedAt: now,
          executionStartedFor: null,
          summary: null,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ key: orchestratorCycles.key });
      if (inserted.length > 0) return { claimed: true as const, tookOver: false };
      const [row] = await tx.select().from(orchestratorCycles).where(this.cycle(key)).for('update');
      if (!row) throw new Error(`cycle ${key} vanished during its claim`);
      const silentFor = (now.getTime() - row.startedAt.getTime()) / 1000;
      // Same rule as the in-memory store: only a cycle that never reached the executor and has been silent long enough
      // may be taken over. One that started executing is in doubt and is never re-run automatically.
      if (
        row.state === 'in_progress' &&
        row.executionStartedFor === null &&
        silentFor >= takeOverAfterSeconds
      ) {
        await tx.update(orchestratorCycles).set({ startedAt: now }).where(this.cycle(key));
        return { claimed: true as const, tookOver: true };
      }
      return { claimed: false as const, existing: toCycle(row) };
    });
  }

  /** Must be durable BEFORE the executor is called: a failure here throws and nothing is executed. */
  async markExecutionStarted(key: string, actionKey: string): Promise<void> {
    const r = await this.db
      .update(orchestratorCycles)
      .set({ executionStartedFor: actionKey })
      .where(this.cycle(key))
      .returning({ key: orchestratorCycles.key });
    if (r.length === 0) throw new Error(`cannot mark execution: cycle ${key} is not claimed`);
  }

  async complete(key: string, summary: CycleSummary): Promise<void> {
    await this.db
      .update(orchestratorCycles)
      .set({ state: 'completed', summary: { ...summary }, completedAt: this.clock.now() })
      .where(this.cycle(key));
  }

  async markNeedsReconciliation(key: string): Promise<void> {
    await this.db
      .update(orchestratorCycles)
      .set({ state: 'needs_reconciliation' })
      .where(this.cycle(key));
  }

  async recordAction(record: ActionRecord): Promise<void> {
    await this.db
      .insert(orchestratorActions)
      .values({
        scope: this.scope,
        actionKey: record.actionKey,
        decisionId: record.decisionId,
        kind: record.kind,
        cycleKey: record.cycleKey,
        status: record.status,
        at: record.at,
        txHash: record.txHash,
        updatedAt: this.clock.now(),
      })
      .onConflictDoUpdate({
        target: [
          orchestratorActions.scope,
          orchestratorActions.actionKey,
          orchestratorActions.decisionId,
        ],
        set: { status: record.status, txHash: record.txHash, updatedAt: this.clock.now() },
      });
  }

  async updateAction(
    actionKey: string,
    decisionId: string,
    patch: { status: ActionRecord['status']; txHash: string | null },
  ): Promise<void> {
    await this.db
      .update(orchestratorActions)
      .set({ status: patch.status, txHash: patch.txHash, updatedAt: this.clock.now() })
      .where(
        and(
          eq(orchestratorActions.scope, this.scope),
          eq(orchestratorActions.actionKey, actionKey),
          eq(orchestratorActions.decisionId, decisionId),
        ),
      );
  }

  async recentActions(since: Date) {
    const rows = await this.db
      .select()
      .from(orchestratorActions)
      .where(and(eq(orchestratorActions.scope, this.scope), gte(orchestratorActions.at, since)));
    return rows.map((a) => ({ actionKey: a.actionKey, kind: a.kind, status: a.status, at: a.at }));
  }

  async inDoubt(): Promise<readonly CycleRecord[]> {
    const rows = await this.db
      .select()
      .from(orchestratorCycles)
      .where(
        and(
          eq(orchestratorCycles.scope, this.scope),
          isNotNull(orchestratorCycles.executionStartedFor),
          ne(orchestratorCycles.state, 'completed'),
        ),
      );
    return rows.map(toCycle);
  }

  private cycle(key: string) {
    return and(eq(orchestratorCycles.scope, this.scope), eq(orchestratorCycles.key, key));
  }
}
