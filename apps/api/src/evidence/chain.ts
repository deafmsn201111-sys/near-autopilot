import { canonicalJson, toJsonSafe, type Provenance } from '@near-autopilot/core';
import { sha256Hex } from '@near-autopilot/core/hash';

/**
 * THE AUDIT HASH CHAIN, IN THE DATABASE. Every `audit_events` row written since migration 0011 belongs to one chain per
 * deployment (`<dataSource>:<network>`, e.g. `simulation:mainnet`) and commits to the row before it:
 *
 *   hash = sha256( prev_hash || canonicalJson({ seq, at, type, runId, proposalId, payload }) )
 *
 * with prev_hash of seq 1 = 64 zeros. The chain lives in Postgres, not in a process: it continues across restarts and
 * across every process of a deployment (API, collector), and anyone with read access can re-verify it.
 */
export const GENESIS = '0'.repeat(64);

export const chainOf = (p: Provenance): string => `${p.dataSource}:${p.network}`;

export interface ChainedFields {
  readonly seq: number;
  readonly at: Date;
  readonly type: string;
  readonly runId: string | null;
  readonly proposalId: string | null;
  /** The payload AS STORED (JSON as jsonb returns it). */
  readonly payload: unknown;
}

/**
 * The payload as Postgres will hand it back: JSON-safe (bigint/Date/Map converted) and through one JSON round trip,
 * so the hash written equals the hash a verifier recomputes from the stored row.
 */
export const storedPayload = (payload: unknown): unknown =>
  JSON.parse(JSON.stringify(toJsonSafe(payload) ?? null)) as unknown;

export function auditHash(prevHash: string, e: ChainedFields): string {
  return sha256Hex(
    prevHash +
      canonicalJson({
        seq: e.seq,
        at: e.at.toISOString(),
        type: e.type,
        runId: e.runId,
        proposalId: e.proposalId,
        payload: e.payload,
      }),
  );
}

export interface ChainRow extends ChainedFields {
  readonly prevHash: string;
  readonly hash: string;
}

export type ChainProblem =
  | { readonly seq: number; readonly kind: 'gap'; readonly detail: string }
  | { readonly seq: number; readonly kind: 'prev_hash'; readonly detail: string }
  | { readonly seq: number; readonly kind: 'hash'; readonly detail: string };

/**
 * Incremental verifier: feed the rows of ONE chain in seq order, page by page. Stops at the first break (everything
 * after it is unanchored).
 */
export class ChainVerifier {
  private expectedSeq = 1;
  private prev = GENESIS;
  private problem: ChainProblem | null = null;
  count = 0;

  feed(rows: readonly ChainRow[]): boolean {
    for (const r of rows) {
      if (this.problem) return false;
      if (r.seq !== this.expectedSeq)
        this.problem = {
          seq: r.seq,
          kind: 'gap',
          detail: `expected seq ${this.expectedSeq}, found ${r.seq}`,
        };
      else if (r.prevHash !== this.prev)
        this.problem = {
          seq: r.seq,
          kind: 'prev_hash',
          detail: 'prev_hash does not name the previous entry',
        };
      else if (auditHash(this.prev, r) !== r.hash)
        this.problem = {
          seq: r.seq,
          kind: 'hash',
          detail: 'content does not match its hash (modified)',
        };
      else {
        this.prev = r.hash;
        this.expectedSeq += 1;
        this.count += 1;
      }
    }
    return this.problem === null;
  }

  result():
    | { ok: true; entries: number; head: { seq: number; hash: string } | null }
    | { ok: false; entries: number; brokenAt: ChainProblem } {
    return this.problem
      ? { ok: false, entries: this.count, brokenAt: this.problem }
      : {
          ok: true,
          entries: this.count,
          head: this.count === 0 ? null : { seq: this.count, hash: this.prev },
        };
  }
}
