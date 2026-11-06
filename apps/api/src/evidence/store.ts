import {
  and,
  asc,
  auditEvents,
  desc,
  eq,
  executionRoutes,
  gt,
  isNull,
  policyVerdicts,
  sql,
  type Database,
} from '@near-autopilot/db';
import { ChainVerifier, type ChainRow } from './chain';

export type ChainVerification = ReturnType<ChainVerifier['result']> & { readonly chain: string };

/** Read-only access to the evidence in Postgres: audit chains and stored verdicts. Writes nothing. */
export class EvidenceStore {
  constructor(private readonly db: Database) {}

  /** Every chain with its length, plus the count of rows written before the chain existed (not covered). */
  async chains(): Promise<{
    chains: Array<{ chain: string; entries: number; firstAt: Date; lastAt: Date }>;
    unchained: number;
  }> {
    const rows = await this.db
      .select({
        chain: auditEvents.chain,
        entries: sql<number>`count(*)::int`,
        firstAt: sql<Date>`min(${auditEvents.at})`,
        lastAt: sql<Date>`max(${auditEvents.at})`,
      })
      .from(auditEvents)
      .groupBy(auditEvents.chain)
      .orderBy(asc(auditEvents.chain));
    const chained = rows.flatMap((r) =>
      r.chain === null
        ? []
        : [
            {
              chain: r.chain,
              entries: r.entries,
              firstAt: new Date(r.firstAt),
              lastAt: new Date(r.lastAt),
            },
          ],
    );
    return { chains: chained, unchained: rows.find((r) => r.chain === null)?.entries ?? 0 };
  }

  async readChain(chain: string, afterSeq: number, limit: number): Promise<ChainRow[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.chain, chain), gt(auditEvents.seq, afterSeq)))
      .orderBy(asc(auditEvents.seq))
      .limit(limit);
    return rows.map((r) => ({
      seq: r.seq ?? 0,
      at: r.at,
      type: r.type,
      runId: r.runId,
      proposalId: r.proposalId,
      payload: r.payload,
      prevHash: r.prevHash ?? '',
      hash: r.hash ?? '',
    }));
  }

  /** Re-verifies a whole chain from the database, page by page, from seq 1. */
  async verify(chain: string, pageSize = 1_000): Promise<ChainVerification> {
    const v = new ChainVerifier();
    for (let after = 0; ;) {
      const page = await this.readChain(chain, after, pageSize);
      if (page.length === 0 || !v.feed(page)) break;
      after = page[page.length - 1]?.seq ?? after;
      if (page.length < pageSize) break;
    }
    return { chain, ...v.result() };
  }

  /** Newest entries of a chain first (for display). */
  async latest(chain: string, limit: number): Promise<ChainRow[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.chain, chain))
      .orderBy(desc(auditEvents.seq))
      .limit(limit);
    return rows.map((r) => ({
      seq: r.seq ?? 0,
      at: r.at,
      type: r.type,
      runId: r.runId,
      proposalId: r.proposalId,
      payload: r.payload,
      prevHash: r.prevHash ?? '',
      hash: r.hash ?? '',
    }));
  }

  /** Stored verdicts with their inputs, newest first; optionally one id. */
  async verdicts(options: { id?: string; limit: number }) {
    return this.db
      .select()
      .from(policyVerdicts)
      .where(options.id === undefined ? undefined : eq(policyVerdicts.id, options.id))
      .orderBy(desc(policyVerdicts.evaluatedAt))
      .limit(options.limit);
  }

  /** Shadow Gateway routing records of every deployment, newest first. */
  async routes(options: { limit: number; origin?: 'gateway' | 'probe' }) {
    return this.db
      .select()
      .from(executionRoutes)
      .where(options.origin === undefined ? undefined : eq(executionRoutes.origin, options.origin))
      .orderBy(desc(executionRoutes.createdAt))
      .limit(options.limit);
  }

  /** Rows written before migration 0011 (no chain); reported, never rewritten. */
  async unchainedCount(): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(isNull(auditEvents.chain));
    return r?.n ?? 0;
  }
}
