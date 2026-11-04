import {
  and,
  auditEvents,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  or,
  proposals,
  runs,
  sql,
  type Column,
  type Database,
  type SQL,
  type Table,
} from '@near-autopilot/db';
import type { Provenance } from '@near-autopilot/core';
import type {
  AuditEvent,
  AutopilotRepository,
  ProposalPatch,
  ProposalRecord,
  RunRecord,
} from '../repository';

type ProposalRow = typeof proposals.$inferSelect;

/**
 * `table.column` for raw SQL. Drizzle renders a column interpolated into `sql` UNQUALIFIED ("id"), so in a correlated
 * subquery it binds to the inner table: `where "run_id" = "id"` compared proposals.run_id with proposals.id and every
 * run reported 0 proposals.
 */
const qualified = (table: Table, column: Column): SQL =>
  sql`${table}.${sql.identifier(column.name)}`;

/** Rows from before migration 0001 have no network; they can only have come from the chain path. */
const provenanceOf = (row: {
  dataSource: Provenance['dataSource'];
  network: Provenance['network'] | null;
}): Provenance => ({ dataSource: row.dataSource, network: row.network ?? 'mainnet' });

const toRecord = (row: ProposalRow): ProposalRecord & Provenance => ({
  ...provenanceOf(row),
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
  violations: row.violations,
  planHash: row.planHash,
  executionMode: row.executionMode,
  txHash: row.txHash,
  error: row.error,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class DrizzleRepository implements AutopilotRepository {
  constructor(
    private readonly db: Database,
    private readonly provenance: Provenance,
  ) {}

  async createRun(run: Pick<RunRecord, 'id' | 'accountId' | 'startedAt'>): Promise<void> {
    await this.db.insert(runs).values({
      id: run.id,
      accountId: run.accountId,
      status: 'running',
      startedAt: run.startedAt,
      ...this.provenance,
    });
  }

  async finishRun(
    id: string,
    update: {
      status: 'completed' | 'failed';
      finishedAt: Date;
      error: string | null;
      outcome: string | null;
      snapshot: unknown;
    },
  ): Promise<void> {
    await this.db
      .update(runs)
      .set({
        status: update.status,
        finishedAt: update.finishedAt,
        error: update.error,
        outcome: update.outcome,
        snapshot: update.snapshot,
      })
      .where(eq(runs.id, id));
  }

  async insertProposal(p: ProposalRecord): Promise<void> {
    await this.db
      .insert(proposals)
      .values({ ...p, violations: [...p.violations], ...this.provenance });
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
    // Count everything that may have reached the chain, not only confirmed successes: an `approved` row is a
    // send that never recorded its result (crash mid-send), and a `failed` row with a hash was signed and
    // broadcast with an unknown or failed outcome. Under-counting would let limits and cooldown be exceeded.
    const live = and(
      eq(proposals.accountId, accountId),
      eq(proposals.executionMode, 'live'),
      or(
        eq(proposals.status, 'executed'),
        eq(proposals.status, 'approved'),
        and(eq(proposals.status, 'failed'), isNotNull(proposals.txHash)),
      ),
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

  async listRuns(
    limit: number,
  ): Promise<Array<RunRecord & Provenance & { proposalCount: number }>> {
    const rows = await this.db
      .select({
        id: runs.id,
        accountId: runs.accountId,
        status: runs.status,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        error: runs.error,
        outcome: runs.outcome,
        dataSource: runs.dataSource,
        network: runs.network,
        proposalCount: sql<number>`(select count(*)::int from ${proposals} where ${qualified(proposals, proposals.runId)} = ${qualified(runs, runs.id)})`,
      })
      .from(runs)
      .where(this.ownRows(runs))
      .orderBy(desc(runs.startedAt))
      .limit(limit);
    return rows.map((r) => ({ ...r, ...provenanceOf(r) }));
  }

  async listProposals(options: {
    limit: number;
    runId?: string;
  }): Promise<Array<ProposalRecord & Provenance>> {
    const rows = await this.db
      .select()
      .from(proposals)
      .where(
        options.runId === undefined
          ? this.ownRows(proposals)
          : and(this.ownRows(proposals), eq(proposals.runId, options.runId)),
      )
      .orderBy(desc(proposals.createdAt))
      .limit(options.limit);
    return rows.map(toRecord);
  }

  /**
   * Rows of this deployment's provenance only, so a simulation API and a testnet API sharing one database never show
   * each other's data. Rows from before migration 0001 have no network and count as mainnet (see provenanceOf).
   */
  private ownRows(table: typeof runs | typeof proposals): SQL | undefined {
    return and(
      eq(table.dataSource, this.provenance.dataSource),
      this.provenance.network === 'mainnet'
        ? or(eq(table.network, 'mainnet'), isNull(table.network))
        : eq(table.network, this.provenance.network),
    );
  }

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }
}
