import type { Provenance } from '@near-autopilot/core';
import type { AuditEntry, AuditEntryInput, AuditLog } from '@near-autopilot/orchestrator';
import type { AutopilotRepository } from '../repository';

/**
 * Write-through audit log for the orchestrator. The orchestrator keeps its own per-process chain in memory (what
 * `entries()` and `verify()` read; its seq/hash are kept in the payload), and every entry is ALSO appended to the
 * DURABLE chain in Postgres `audit_events` (see evidence/chain.ts) before `append` returns. That one survives restarts
 * and is checked by `pnpm audit:verify`. If the database write fails, `append` throws and the orchestrator refuses to
 * execute anything it could not record.
 */
export class PersistentAuditLog implements AuditLog {
  constructor(
    private readonly inner: AuditLog,
    private readonly repo: Pick<AutopilotRepository, 'appendAudit'>,
    private readonly provenance: Provenance,
  ) {}

  async append(entry: AuditEntryInput): Promise<AuditEntry> {
    const stored = await this.inner.append(entry);
    await this.repo.appendAudit({
      at: stored.at,
      type: `orchestrator.${stored.type}`,
      runId: stored.cycleKey,
      proposalId: stored.decisionId,
      payload: {
        ...stored.payload,
        seq: stored.seq,
        hash: stored.hash,
        prevHash: stored.prevHash,
        dataSource: this.provenance.dataSource,
        network: this.provenance.network,
      },
    });
    return stored;
  }

  entries(): Promise<readonly AuditEntry[]> {
    return this.inner.entries();
  }

  verify(): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }> {
    return this.inner.verify();
  }
}
