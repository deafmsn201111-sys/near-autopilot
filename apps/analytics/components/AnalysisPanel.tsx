'use client';
import { PROVENANCE_TIER_INFO } from '@near-autopilot/core';
import type { StrategyId } from '@near-autopilot/core/strategy';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  pipelineOf,
  privacyMark,
  type Analysis,
  type ModelInput,
  type Pipeline,
} from '../lib/analysis-client';
import { CopyButton } from './CopyButton';
import { findingsOf, verdictOf, type Finding } from '../lib/analysis-view';
import { ago } from '../lib/format';
import type { AccountRecommendation } from '../lib/product';
import { Button, Chip, ProvenanceMark } from './primitives';
import { useNow } from './DepositDialog';
import { StrategyPicker } from './StrategyPicker';

/** A saved analysis this old still ranks the right cards, but its prices and rates may have moved. */
const FRESH_MS = 60 * 60_000;

const path = (d: ReactNode) => (
  <svg className="an-i" viewBox="0 0 24 24" aria-hidden="true">
    {d}
  </svg>
);
const ICON = {
  check: path(<path d="M20 6 9 17l-5-5" />),
  alert: path(
    <>
      <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" />
      <path d="M12 9v4M12 17h.01" />
    </>,
  ),
  eye: path(
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>,
  ),
  minus: path(<path d="M5 12h14" />),
  lock: path(
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>,
  ),
  shield: path(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />),
  refresh: path(
    <>
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5M3 21v-5h5" />
    </>,
  ),
};

const LEVEL_ICON: Record<Finding['level'], ReactNode> = {
  act: ICON.alert,
  watch: ICON.eye,
  ok: ICON.check,
  na: ICON.minus,
  failed: ICON.alert,
};
const LEVEL_SR: Record<Finding['level'], string> = {
  act: '(act now)',
  watch: '(watch)',
  ok: '(passed)',
  na: '(not applicable)',
  failed: '(failed)',
};

/**
 * The analysis panel (DESIGN.md → Analysis panel): one focal verdict, the strategy, what each agent found, what code
 * checked, and the decision pipeline last as supporting evidence.
 */
export function AnalysisPanel({
  account,
  strategy,
  strategyNote,
  recommendations,
  rules,
  skipped,
  analysis,
  live,
  startedAt,
  ranAt,
  aiAllowed,
  hasLoan,
  loanValued,
  hasLp,
  portfolioChanged,
  error,
  onRun,
}: {
  account: string;
  strategy: StrategyId;
  strategyNote?: string | null;
  recommendations: readonly AccountRecommendation[];
  rules: readonly AccountRecommendation[];
  skipped: readonly string[];
  analysis: Analysis | null;
  live: Pipeline | null;
  startedAt: number | null;
  /** When the shown AI analysis was produced: its saved time, or the moment this run finished. */
  ranAt: string | null;
  aiAllowed: boolean;
  hasLoan: boolean;
  loanValued: boolean;
  hasLp: boolean;
  portfolioChanged: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const running = startedAt !== null;
  const findings = findingsOf({
    recommendations,
    rules,
    trace: running ? (live?.trace ?? []) : (analysis?.trace ?? []),
    hasLoan,
    loanValued,
    hasLp,
    live: running,
  });
  const verdict = verdictOf({
    recommendations,
    skipped,
    incomplete: findings.filter((f) => f.incomplete).map((f) => f.agent),
  });
  const aiRanked = analysis?.source === 'llm';
  const checks = !running ? analysis?.run?.checks : null;

  return (
    <section className="ds-panel analysis" aria-labelledby="an-h">
      <header className="an-head">
        <h2 id="an-h">Analysis</h2>
        <span className="an-meta">
          <AiChip analysis={analysis} />
          <span>4 agents</span>
        </span>
        <div className="an-run">
          <span className="an-run-sub">
            {aiAllowed ? (
              running ? (
                'Analysing…'
              ) : ranAt ? (
                <Updated iso={ranAt} />
              ) : (
                'AI analysis not run yet.'
              )
            ) : (
              `AI analysis runs only for the verified owner of ${account}.`
            )}
          </span>
          <Button
            className={`an-run-btn${running ? ' is-busy' : ''}`}
            onClick={onRun}
            disabled={running || !aiAllowed}
          >
            {running ? (
              <>
                <span className="an-spin" aria-hidden="true" />
                Analysing <Elapsed since={startedAt} />
              </>
            ) : (
              <>
                {aiAllowed ? ICON.refresh : ICON.lock}
                Run AI analysis
              </>
            )}
          </Button>
        </div>
      </header>

      {analysis?.note && analysis.fallback !== 'nothing_to_rank' && !running && (
        <p className="an-note">{analysis.note}</p>
      )}
      {portfolioChanged && (
        <p className="an-note">Your portfolio changed — run the AI analysis again.</p>
      )}
      {error && (
        <div className="callout warn an-note" role="alert">
          AI analysis failed: {error}
        </div>
      )}

      <div className="an-verdict" aria-live="polite">
        {running ? (
          <span className="an-tile">
            <span className="an-spin" aria-hidden="true" />
          </span>
        ) : verdict.tone === 'ai' ? (
          <span className="an-tile ai num">{verdict.count}</span>
        ) : (
          <span className={`an-tile ${verdict.tone}`}>
            {verdict.tone === 'safe' ? ICON.check : ICON.alert}
          </span>
        )}
        <div>
          <p className="an-v">{running ? 'Re-checking your portfolio…' : verdict.title}</p>
          <p className="an-sub">
            {running ? 'Agents are reading the latest on-chain data.' : verdict.sub}
          </p>
        </div>
      </div>

      <StrategyPicker account={account} current={strategy} note={strategyNote} disabled={running} />

      <h3 className="an-finds-h">What the agents found</h3>
      <ul className="an-finds">
        {findings.map((f) => (
          <li key={f.agent} className={`an-find lv-${f.level}${f.busy ? ' is-busy' : ''}`}>
            <span className="an-who">{f.agent}</span>
            <span className="an-res">
              <span className="an-ci">{LEVEL_ICON[f.level]}</span>
              {f.result}
              <span className="sr-only"> {LEVEL_SR[f.level]}</span>
            </span>
            <p>{f.detail}</p>
            {aiRanked && f.pick && <Chip tone={f.pick.tone ?? undefined}>{f.pick.label}</Chip>}
          </li>
        ))}
      </ul>

      {checks && (
        <div className="an-codechecks">
          <b>
            {ICON.shield}
            Code checked the AI
          </b>
          <span className={checks.replaced ? 'warn' : undefined}>
            {ICON.check}
            {explained(checks.explained, checks.explained + checks.replaced)}
            {checks.replaced > 0 && `; ${checks.replaced} replaced by the agent's own text`}
          </span>
          <span>
            {ICON.check}
            {checks.restored > 0
              ? `${plural(checks.restored, 'warning')} the AI left out put back first`
              : 'No warning was left out'}
          </span>
          <span>
            {ICON.check}
            {checks.dropped > 0
              ? `${plural(checks.dropped, 'made-up or repeated action')} dropped`
              : 'No made-up actions'}
          </span>
        </div>
      )}

      <DecisionPipeline analysis={analysis} live={live} running={running} aiAllowed={aiAllowed} />
    </section>
  );
}

function AiChip({ analysis }: { analysis: Analysis | null }) {
  if (analysis?.source === 'llm') return <Chip tone="ai">AI-ranked</Chip>;
  if (analysis && analysis.fallback !== 'nothing_to_rank')
    return <Chip tone="watch">Rules only · AI unavailable</Chip>;
  return <Chip>Rules only</Chip>;
}

type StepState = 'done' | 'now' | 'pending' | 'locked';

/** The five steps from the prototype over the run's four stages (0 read, 1 agents, 2 ranking, 3 checks, 4 done). */
function DecisionPipeline({
  analysis,
  live,
  running,
  aiAllowed,
}: {
  analysis: Analysis | null;
  live: Pipeline | null;
  running: boolean;
  aiAllowed: boolean;
}) {
  const p = running ? live : analysis ? pipelineOf(analysis) : null;
  const model = p?.model ?? null;
  const ai = running || model !== null;
  const lockedWhy = !aiAllowed
    ? "owner's wallet only"
    : analysis?.fallback === 'nothing_to_rank'
      ? 'nothing worth ranking'
      : analysis
        ? 'AI unavailable on this run'
        : 'run AI analysis';
  const who = 'The AI';
  const mark = model && !running ? privacyMark(p?.privacy ?? null, model) : null;
  const stage = running ? (p?.stage ?? 0) : 4;
  const asked = p?.asked.length ?? 0;
  const answered = p?.trace.filter((t) => t.ok).length ?? 0;
  const replied = p?.trace.length ?? 0;
  const steps: { title: string; sub: string; state: StepState }[] = [
    {
      title: 'Read the wallet on-chain',
      sub: p?.read ? readLine(p.read) : 'balances, loan, liquidity, staking',
      state: stage > 0 ? 'done' : 'now',
    },
    ai
      ? {
          title: `${who} chose which agents to ask`,
          sub: asked > 0 ? `asked ${asked}` : 'deciding…',
          state: asked > 0 || stage > 1 ? 'done' : stage === 1 ? 'now' : 'pending',
        }
      : { title: 'Rules ran all 4 agents', sub: 'no model on this view', state: 'locked' },
    {
      title: 'Agents answered with numbers',
      sub: ai
        ? `${answered} of ${Math.max(asked, replied)} answered`
        : 'each from live on-chain data',
      state: !ai || stage > 1 ? 'done' : stage === 1 && asked > 0 ? 'now' : 'pending',
    },
    ai
      ? {
          title: `${who} ranked the answers`,
          sub:
            typeof p?.turns === 'number'
              ? plural(p.turns, 'model turn')
              : 'by what changes most for you',
          state: stage > 2 ? 'done' : stage === 2 ? 'now' : 'pending',
        }
      : { title: 'AI ranking', sub: lockedWhy, state: 'locked' },
    {
      title: ai ? 'Code checked the ranking' : 'Code checked every action',
      sub: 'the model can only propose',
      state: !ai || stage > 3 ? 'done' : stage === 3 ? 'now' : 'pending',
    },
  ];
  const picked = analysis?.trace.filter((t) => t.pick === 'ranked' || t.pick === 'kept').length;
  const summary = running
    ? 'Running…'
    : ai && analysis
      ? `${picked} of ${analysis.trace.length} agents picked${analysis.run ? ` · ${seconds(analysis.run.ms)}` : ''}`
      : 'Rule-based: every agent ran, no AI ranking.';
  const ranking = !running ? (p?.ranking ?? null) : null;
  const status = running ? steps.find((s) => s.state === 'now')?.title : null;

  return (
    <div className="an-pipe-wrap">
      <div className="an-pipe-head">
        <h3>How this was decided</h3>
        <span>{summary}</span>
        {mark && (
          <a href={mark.href} target="_blank" rel="noreferrer" title={mark.title}>
            {mark.label}
          </a>
        )}
      </div>
      {status && (
        <p className="sr-only" aria-live="polite">
          {status}
        </p>
      )}
      <ol className="an-pipe">
        {steps.map((s) => (
          <li
            key={s.title}
            className={`an-pn is-${s.state}`}
            aria-current={s.state === 'now' ? 'step' : undefined}
          >
            <span className="an-dot">
              {s.state === 'done' ? ICON.check : s.state === 'locked' ? ICON.lock : null}
            </span>
            <b>{s.title}</b>
            <small>{s.sub}</small>
          </li>
        ))}
      </ol>
      {mark && mark.replies.length > 0 && (
        <p className="an-replies">
          Check each reply on NEAR AI Cloud:{' '}
          {mark.replies.map(({ id, href }) => (
            <code key={id}>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer">
                  {id}
                </a>
              ) : (
                id
              )}{' '}
            </code>
          ))}
          <CopyButton text={mark.replies.map((r) => r.id).join('\n')} label="Copy ids" />
        </p>
      )}
      {!running && analysis?.run?.input && <ModelInputView input={analysis.run.input} />}
      {ranking && (
        <p className="an-ranking">
          Why this order: {ranking}{' '}
          <ProvenanceMark kind="estimate" title={PROVENANCE_TIER_INFO.calculated_estimate.describe}>
            {PROVENANCE_TIER_INFO.calculated_estimate.label}
          </ProvenanceMark>
        </p>
      )}
    </div>
  );
}

function ModelInputView({ input }: { input: ModelInput }) {
  const toolOf = new Map(
    input.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => [c.id, c.function.name])),
  );
  const heading = (m: ModelInput['messages'][number]) =>
    m.role === 'tool'
      ? `${toolOf.get(m.tool_call_id ?? '') ?? 'tool'} answered`
      : m.tool_calls?.length
        ? `The AI asked: ${m.tool_calls.map((c) => c.function.name).join(', ')}`
        : m.role === 'system'
          ? 'Instructions'
          : m.role === 'user'
            ? 'Request'
            : 'The AI';
  return (
    <details className="an-saw">
      <summary>What the AI saw</summary>
      <p>
        The last request sent to the model for this run, which holds the whole conversation. Only
        you see it. <CopyButton text={JSON.stringify(input, null, 2)} label="Copy all" />
      </p>
      {input.messages.map((m, i) => (
        <Fragment key={i}>
          <h4>{heading(m)}</h4>
          {m.content && <pre>{indented(m.content)}</pre>}
        </Fragment>
      ))}
      <h4>Agents it could ask</h4>
      <pre>
        {input.tools.map((t) => `${t.function.name}: ${t.function.description}`).join('\n')}
      </pre>
    </details>
  );
}

const indented = (json: string) => {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};

function Updated({ iso }: { iso: string }) {
  const now = useNow();
  const stale = now - Date.parse(iso) >= FRESH_MS;
  return (
    <span suppressHydrationWarning>
      Updated {ago(iso, new Date(now).toISOString())}
      {stale && ' · prices and rates may have moved since'}
    </span>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [since]);
  return <span className="num">{seconds(Math.max(0, now - since))}</span>;
}

const readLine = (read: NonNullable<Pipeline['read']>) =>
  `${plural(read.tokens, 'token')}${read.loan ? ', a Burrow loan' : ', no loan'}`;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const explained = (ok: number, all: number) =>
  `${ok} of ${all} AI ${all === 1 ? 'explanation uses' : 'explanations use'} only numbers the agents returned`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
