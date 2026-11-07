import {
  collectorControl,
  desc,
  eq,
  orchestratorControl,
  orchestratorControlHistory,
  type Database,
} from '@near-autopilot/db';
import { ModeController } from '@near-autopilot/orchestrator';
import { appendAuditIn } from '../infra/drizzle-repository';
import { PgControlStore } from '../infra/orchestrator-stores';

/**
 * OPERATOR CONTROLS behind the dashboard's Autopilot page. Exactly three, all of them safe in shadow mode:
 *
 *   pause / resume the scheduled market collection   (read-only data collection; a manual run still works)
 *   engage read-only / return to normal for a scope   (through the orchestrator's own ModeController and the durable
 *                                                      PgControlStore: versioned, history row + audit entry)
 *
 * Nothing here can sign, send, approve, change a limit, a policy or an allowlist. Every change is audited on the
 * chain of the deployment it belongs to, and needs a named actor and a reason.
 */
const COLLECTOR_CHAIN = 'simulation:mainnet';

export interface ActorInput {
  readonly by: string;
  readonly reason: string;
}

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const required = (a: ActorInput) => {
  if (!a.by.trim() || !a.reason.trim())
    throw new ControlError('a named actor and a reason are required', 400);
};

export class ControlService {
  constructor(
    private readonly db: Database,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  async collectorState() {
    const [row] = await this.db
      .select()
      .from(collectorControl)
      .where(eq(collectorControl.id, 'default'))
      .limit(1);
    return row
      ? {
          paused: row.paused,
          reason: row.reason,
          by: row.changedBy,
          at: row.changedAt,
          version: row.version,
        }
      : { paused: false, reason: 'never paused', by: null, at: null, version: 0 };
  }

  /** Pauses or resumes the SCHEDULED collection. Idempotent: asking for the current state changes nothing. */
  async setCollectorPaused(paused: boolean, a: ActorInput) {
    required(a);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(collectorControl)
        .where(eq(collectorControl.id, 'default'))
        .for('update');
      if ((row?.paused ?? false) === paused) return { changed: false };
      const version = (row?.version ?? 0) + 1;
      const at = this.clock.now();
      const values = { paused, reason: a.reason, changedBy: a.by, changedAt: at, version };
      if (row)
        await tx.update(collectorControl).set(values).where(eq(collectorControl.id, 'default'));
      else await tx.insert(collectorControl).values({ id: 'default', ...values });
      await appendAuditIn(tx, COLLECTOR_CHAIN, {
        at,
        type: paused ? 'collector.paused' : 'collector.resumed',
        runId: null,
        proposalId: null,
        payload: { by: a.by, reason: a.reason, version },
      });
      return { changed: true };
    });
  }

  /** Every orchestrator scope with its current mode and the last changes (newest first). */
  async modes(historyPerScope = 5) {
    const rows = await this.db.select().from(orchestratorControl);
    return Promise.all(
      rows.map(async (r) => ({
        scope: r.scope,
        mode: r.mode,
        reason: r.reason,
        since: r.since,
        changedBy: r.changedBy,
        version: r.version,
        quarantined: r.quarantined,
        history: await this.db
          .select({
            version: orchestratorControlHistory.version,
            at: orchestratorControlHistory.at,
            mode: orchestratorControlHistory.mode,
            previousMode: orchestratorControlHistory.previousMode,
            reason: orchestratorControlHistory.reason,
            changedBy: orchestratorControlHistory.changedBy,
            auditSeq: orchestratorControlHistory.auditSeq,
          })
          .from(orchestratorControlHistory)
          .where(eq(orchestratorControlHistory.scope, r.scope))
          .orderBy(desc(orchestratorControlHistory.version))
          .limit(historyPerScope),
      })),
    );
  }

  /**
   * Engage read-only, or return a scope to normal, through the orchestrator's ModeController. The new mode is read
   * back from the database: a change that was not stored (a concurrent change won) is reported as a conflict, never
   * as success.
   */
  async setMode(scope: string, mode: 'read_only' | 'normal', a: ActorInput) {
    required(a);
    const [row] = await this.db
      .select({ scope: orchestratorControl.scope, chain: orchestratorControl.auditChain })
      .from(orchestratorControl)
      .where(eq(orchestratorControl.scope, scope))
      .limit(1);
    if (!row) throw new ControlError(`unknown scope ${scope}`, 404);
    const chain = scope.split(':').slice(0, 2).join(':');
    const store = new PgControlStore(this.db, scope, chain, this.clock);
    const controller = new ModeController(store, this.clock);
    if (mode === 'read_only') await controller.engageReadOnly(a.reason, a.by);
    else await controller.setMode('normal', a.reason, a.by);
    const stored = await store.load();
    if (stored.mode !== mode)
      throw new ControlError(
        `the mode was not changed: it is ${stored.mode} (changed concurrently by ${stored.changedBy})`,
        409,
      );
    return { scope, mode: stored.mode, since: stored.since, changedBy: stored.changedBy };
  }
}
