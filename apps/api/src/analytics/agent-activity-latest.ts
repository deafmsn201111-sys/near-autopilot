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

export interface DecisionSummary {
  readonly id: string;
  /** 'act' or 'no_action' — what the orchestrator decided this cycle. */
  readonly outcome: string;
  /** When the decision stops being actionable because its data goes stale (brief §11). Empty if not recorded. */
  readonly expiresAt: string;
  readonly reasons: readonly string[];
}

export interface LatestAgentActivity {
  readonly run: { readonly id: string; readonly at: string } | null;
  readonly decision: DecisionSummary | null;
  readonly agents: readonly AgentActivity[];
}

type Row = { id: string; finishedAt: Date | string | null; snapshot: unknown };

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Safe string coercion: never produces "[object Object]" from a non-string value. */
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

export function mapAgentActivity(row: Row | undefined): LatestAgentActivity {
  if (!row) return { run: null, decision: null, agents: [] };
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
  const decisionId = str(snap['decisionId']);
  const outcome = str(snap['cycleStatus']);
  const expiresAt = str(snap['expiresAt']);
  const reasons = Array.isArray(snap['reasons'])
    ? (snap['reasons'] as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  const decision: DecisionSummary | null =
    decisionId || outcome ? { id: decisionId, outcome, expiresAt, reasons } : null;

  const at = row.finishedAt ? new Date(row.finishedAt).toISOString() : '';
  return { run: { id: row.id, at }, decision, agents };
}
