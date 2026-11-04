import {
  and,
  auditEvents,
  desc,
  eq,
  gte,
  proposals,
  runs,
  sql,
  type Database,
} from '@near-autopilot/db';
import type { PolicyViolation } from '@near-autopilot/core';
import type {
  AuditEvent,
  AutopilotRepository,
  ProposalPatch,
  ProposalRecord,
  RunRecord,
} from '../repository';

type ProposalRow = typeof proposals.$inferSelect;

const toRecord = (row: ProposalRow): ProposalRecord => ({
  id: row.id,
  runId: row.runId,
  accountId: row.accountId,
  agentId: row.agentId,
  kind: row.kind,
  summary: row.summary,
  reason: row.reason,
  intent: row.intent,
  valueUsdMicro: row.valueUsdMicro,
  status: row.status,
  violations: row.violations as PolicyViolation[],
  planHash: row.planHash,
  executionMode: row.executionMode,
  txHash: row.txHash,
  error: row.error,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class DrizzleRepository implements AutopilotRepository {
  constructor(private readonly db: Database) {}

  async createRun(run: Pick<RunRecord, 'id' | 'accountId' | 'startedAt'>): Promise<void> {
    await this.db.insert(runs).values({
      id: run.id,
      accountId: run.accountId,
      status: 'running',
      startedAt: run.startedAt,
    });
  }

  async finishRun(
    id: string,
    update: {
      status: 'completed' | 'failed';
      finishedAt: Date;
      error: string | null;
      snapshot: unknown;
    },
  ): Promise<void> {
    await this.db
      .update(runs)
      .set({
        status: update.status,
        finishedAt: update.finishedAt,
        error: update.error,
        snapshot: update.snapshot,
      })
      .where(eq(runs.id, id));
  }

  async insertProposal(p: ProposalRecord): Promise<void> {
    await this.db.insert(proposals).values({ ...p, violations: [...p.violations] });
  }

  async updateProposal(id: string, patch: ProposalPatch): Promise<void> {
    const { violations, ...rest } = patch;
    await this.db
      .update(proposals)
      .set(violations === undefined ? rest : { ...rest, violations: [...violations] })
      .where(eq(proposals.id, id));
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.db.insert(auditEvents).values({
      at: event.at,
      type: event.type,
      runId: event.runId,
      proposalId: event.proposalId,
      payload: event.payload,
    });
  }

  async getExecutionStats(
    accountId: string,
    since: Date,
  ): Promise<{ spentLast24hUsdMicro: bigint; lastExecutedAt: Date | null }> {
    const live = and(
      eq(proposals.accountId, accountId),
      eq(proposals.status, 'executed'),
      eq(proposals.executionMode, 'live'),
    );
    const [spent] = await this.db
      .select({ total: sql<string>`coalesce(sum(${proposals.valueUsdMicro}), 0)` })
      .from(proposals)
      .where(and(live, gte(proposals.updatedAt, since)));
    const [last] = await this.db
      .select({ at: sql<Date | null>`max(${proposals.updatedAt})` })
      .from(proposals)
      .where(live);
    return {
      spentLast24hUsdMicro: BigInt(spent?.total ?? '0'),
      lastExecutedAt: last?.at ? new Date(last.at) : null,
    };
  }

  async listRuns(limit: number): Promise<Array<RunRecord & { proposalCount: number }>> {
    const rows = await this.db
      .select({
        id: runs.id,
        accountId: runs.accountId,
        status: runs.status,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        error: runs.error,
        proposalCount: sql<number>`(select count(*)::int from ${proposals} where ${proposals.runId} = ${runs.id})`,
      })
      .from(runs)
      .orderBy(desc(runs.startedAt))
      .limit(limit);
    return rows;
  }

  async listProposals(options: { limit: number; runId?: string }): Promise<ProposalRecord[]> {
    const rows = await this.db
      .select()
      .from(proposals)
      .where(options.runId === undefined ? undefined : eq(proposals.runId, options.runId))
      .orderBy(desc(proposals.createdAt))
      .limit(options.limit);
    return rows.map(toRecord);
  }

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }
}
