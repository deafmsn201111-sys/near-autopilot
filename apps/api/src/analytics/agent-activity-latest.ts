/**
 * Shapes the per-agent conclusions stored in an orchestrator run snapshot (`runs.snapshot.agents`) into a small,
 * plain-language view for the dashboard: what each agent concluded in the most recent cycle, and why. It is a pure
 * function of a stored row so it can be unit-tested without a database. Every value comes from the agent's own
 * recorded output — nothing is inferred or fabricated.
 */

export interface AgentConclusion {
  readonly kind: string;
  /** The agent's own rationale (preferred), else its reason code, else the bare kind. */
  readonly text: string;
}

export interface AgentActivity {
  readonly agent: string;
  readonly event: string;
  readonly suspicious: boolean;
  readonly conclusions: readonly AgentConclusion[];
}

export interface LatestAgentActivity {
  readonly run: { readonly id: string; readonly at: string } | null;
  readonly agents: readonly AgentActivity[];
}

type Row = { id: string; finishedAt: Date | string | null; snapshot: unknown };

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Safe string coercion: never produces "[object Object]" from a non-string value. */
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

export function mapAgentActivity(row: Row | undefined): LatestAgentActivity {
  if (!row) return { run: null, agents: [] };
  const snap = rec(row.snapshot);
  const raw = Array.isArray(snap['agents']) ? (snap['agents'] as unknown[]) : [];
  const agents: AgentActivity[] = raw.map((a) => {
    const o = rec(a);
    const proposals = Array.isArray(o['proposals']) ? (o['proposals'] as unknown[]) : [];
    return {
      agent: str(o['agent']),
      event: str(o['event']),
      suspicious: Boolean(o['suspicious']),
      conclusions: proposals.map((p) => {
        const q = rec(p);
        const kind = str(q['kind']);
        const rationale = typeof q['rationale'] === 'string' ? q['rationale'] : '';
        const reasonCode = typeof q['reasonCode'] === 'string' ? q['reasonCode'] : '';
        return { kind, text: rationale || reasonCode || kind };
      }),
    };
  });
  const at = row.finishedAt ? new Date(row.finishedAt).toISOString() : '';
  return { run: { id: row.id, at }, agents };
}
