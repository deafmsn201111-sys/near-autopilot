import type { TraceStep } from './analysis-client';
import type { AccountRecommendation } from './product';

export type VerdictTone = 'act' | 'ai' | 'watch' | 'safe';

export interface Verdict {
  tone: VerdictTone;
  count: number;
  title: string;
  sub: string;
}

const URGENT_TITLE: Readonly<Record<string, string>> = {
  improve_loan_safety: 'Your loan needs attention now.',
  reduce_concentration: 'Too much of your money is in one token.',
};

/** The analysis panel's one focal sentence: urgent first, then the open moves, then a missing check, else nothing to do. */
export function verdictOf({
  recommendations,
  skipped,
  incomplete = [],
}: {
  recommendations: readonly AccountRecommendation[];
  skipped: readonly string[];
  /** Agents whose check did not finish: "every check passed" would be false. */
  incomplete?: readonly string[];
}): Verdict {
  const count = recommendations.length;
  const missing = incomplete.length > 0 ? ` ${incomplete.join(', ')} could not finish.` : '';
  const urgent = recommendations.filter((r) => r.severity === 'warning');
  if (urgent.length > 0) {
    const rest = count - urgent.length;
    return {
      tone: 'act',
      count,
      title: URGENT_TITLE[urgent[0]!.kind] ?? 'One move needs attention now.',
      sub: `${urgent.length === 1 ? 'One urgent action' : `${urgent.length} urgent actions`}${rest > 0 ? ` and ${rest} more worth doing` : ''}, explained below.${missing}`,
    };
  }
  if (count > 0)
    return {
      tone: 'ai',
      count,
      title: `${count} ${count === 1 ? 'move' : 'moves'} worth doing.`,
      sub:
        (skipped.length > 0
          ? `${skipped.length} more checked and skipped: ${skipped.length === 1 ? 'it doesn’t' : 'they don’t'} beat the costs.`
          : 'Ranked by what they change for you.') + missing,
    };
  if (incomplete.length > 0)
    return {
      tone: 'watch',
      count,
      title: 'No move found, but a check is missing.',
      sub: `${incomplete.join(', ')} could not finish. Run the analysis again before relying on it.`,
    };
  return {
    tone: 'safe',
    count,
    title: 'Nothing to do right now.',
    sub:
      skipped.length > 0
        ? `${skipped.length === 1 ? '1 small move' : `${skipped.length} small moves`} checked and skipped: ${skipped.length === 1 ? 'it doesn’t' : 'they don’t'} beat the costs.`
        : 'Every check passed for your strategy. Doing nothing is the right call; we’ll flag anything that changes.',
  };
}

export type FindingLevel = 'act' | 'watch' | 'ok' | 'na' | 'failed';

export interface Finding {
  agent: string;
  level: FindingLevel;
  result: string;
  detail: string;
  pick: { label: string; tone: 'ai' | 'watch' | null } | null;
  busy: boolean;
  /** The check did not finish, so it says nothing about the risk. */
  incomplete: boolean;
}

type Results = Partial<Record<FindingLevel, string>> & { ok: string };

const AGENTS: readonly {
  agent: string;
  kind: string;
  /** A card of this kind is the agent's finding, but not a risk. */
  also?: string;
  results: Results;
  na?: string;
}[] = [
  {
    agent: 'Liquidation Guardian',
    kind: 'improve_loan_safety',
    also: 'withdraw_from_burrow',
    results: { act: 'Loan: act now', watch: 'Loan: watch', ok: 'Loan: safe', na: 'No loan' },
    na: 'Nothing borrowed, nothing to liquidate.',
  },
  {
    agent: 'Portfolio Intelligence',
    kind: 'reduce_concentration',
    results: { act: 'Too much in one token', watch: 'Concentrated', ok: 'Spread is fine' },
  },
  {
    agent: 'Capital Allocator',
    kind: 'put_idle_to_work',
    results: { act: 'Money sitting idle', watch: 'Money sitting idle', ok: 'Nothing idle' },
  },
  {
    agent: 'Liquidity Optimizer',
    kind: 'reposition_dcl_position',
    results: {
      act: 'Position to move',
      watch: 'Position to move',
      ok: 'Nothing to move',
      na: 'Nothing to check',
    },
    na: 'No Rhea concentrated-liquidity positions to check.',
  },
];

const pickOf = ({ pick, rank }: TraceStep): Finding['pick'] => {
  if (pick === 'ranked') return { label: `#${rank} · ranked by AI`, tone: 'ai' };
  if (pick === 'kept') return { label: `#${rank} · moved up by code`, tone: 'watch' };
  if (pick === 'left_out') return { label: 'Left out by the AI', tone: null };
  return null;
};

/**
 * One card per agent. Its level comes from the cards the agent stands behind (shown, or found by the rules and left
 * out by the AI); after an AI run its sentence is the agent's own line from the trace.
 */
export function findingsOf({
  recommendations,
  rules,
  trace,
  hasLoan,
  loanValued,
  hasLp,
  live = false,
}: {
  recommendations: readonly AccountRecommendation[];
  rules: readonly AccountRecommendation[];
  trace: readonly TraceStep[];
  hasLoan: boolean;
  /** False when a price or risk parameter is missing, so the loan has no health factor. */
  loanValued: boolean;
  hasLp: boolean;
  live?: boolean;
}): Finding[] {
  const cards = [...recommendations, ...rules];
  return AGENTS.map(({ agent, kind, also, results, na }) => {
    const card = cards.find((r) => r.kind === kind);
    const other = cards.find((r) => r.kind === also);
    const steps = trace.filter((t) => t.agent === agent);
    const step = steps.find((t) => t.pick !== null) ?? steps[0];
    const applicable =
      na === undefined ||
      card !== undefined ||
      (agent === 'Liquidation Guardian' ? hasLoan : hasLp);
    const level: FindingLevel = steps.some((t) => !t.ok)
      ? 'failed'
      : card
        ? card.severity === 'warning'
          ? 'act'
          : 'watch'
        : applicable
          ? 'ok'
          : 'na';
    if (level === 'failed')
      return {
        agent,
        level,
        result: 'Didn’t answer',
        detail: 'This agent failed on this run, so its check is missing.',
        pick: null,
        busy: false,
        incomplete: true,
      };
    if (agent === 'Liquidation Guardian' && hasLoan && !loanValued && !card)
      return {
        agent,
        level: 'watch',
        result: 'Loan: not valued',
        detail: 'A price or risk parameter is missing, so the loan could not be valued.',
        pick: step ? pickOf(step) : null,
        busy: live && !step,
        incomplete: true,
      };
    return {
      agent,
      level,
      result: results[level] ?? results.ok,
      detail:
        step?.text ??
        (card ?? other)?.title ??
        (level === 'na' ? na! : 'Nothing to fix for your strategy.'),
      pick: step ? pickOf(step) : null,
      busy: live && !step,
      incomplete: false,
    };
  });
}
