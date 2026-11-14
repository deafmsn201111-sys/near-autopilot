'use client';
import { PROVENANCE_TIER_INFO } from '@near-autopilot/core';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  modelName,
  parseSaved,
  pipelineOf,
  runAnalysis,
  type Analysis,
  type Pipeline,
  type TraceStep,
} from '../lib/analysis-client';
import { ago } from '../lib/format';
import { portfolioSignature } from '../lib/portfolio-signature';
import type { AccountRecommendation, PortfolioView } from '../lib/product';
import type { StrategyId } from '@near-autopilot/core/strategy';
import { actionLabel, intentTokens, recommendationToPrepare } from '../lib/recommendation-intent';
import { label } from '../lib/token-label';
import { TokenIcons } from './TokenIcon';
import { PrepareDialog } from './PrepareDialog';
import { RepayPicker } from './RepayPicker';
import { Button, Card, Chip, Panel, ProvenanceMark } from './primitives';

/** A saved analysis this old still ranks the right cards, but its prices and rates may have moved. */
const FRESH_MS = 60 * 60_000;

/**
 * The agents' recommendations for the connected wallet, each a card: what (title), why (plain language), which agent,
 * and — when the engine can assemble it — a one-click button that prepares the exact transaction cascade to sign.
 * "Run AI analysis" swaps the list for the API's re-ranked one. Signing (if enabled) happens inside the dialog.
 */
export function Recommendations({
  account,
  strategy,
  recommendations: initial,
  skipped,
  holdings,
  saved = null,
  icons = {},
  signingEnabled,
}: {
  account: string;
  strategy: StrategyId;
  recommendations: readonly AccountRecommendation[];
  skipped: readonly string[];
  holdings: PortfolioView['holdings'];
  /** The owner's last saved analysis for this strategy, as the API sent it (#190). */
  saved?: unknown;
  icons?: Readonly<Record<string, string | null>>;
  signingEnabled: boolean;
}) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [ai, setAi] = useState<{ analysis: Analysis; signature: string; run: number } | null>(
    () => {
      const restored = parseSaved(saved);
      return restored && { ...restored, run: 0 };
    },
  );
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Pipeline | null>(null);
  const running = startedAt !== null;
  const signature = portfolioSignature(initial, holdings);
  const analysis = ai?.signature === signature ? ai.analysis : null;
  const portfolioChanged = ai !== null && analysis === null;
  const recommendations = analysis?.recommendations ?? initial;

  async function analyse() {
    setStartedAt(Date.now());
    setError(null);
    setLive(null);
    const r = await runAnalysis(account, strategy, setLive, signature);
    if (r.ok) setAi({ analysis: r.analysis, signature, run: Date.now() });
    else setError(r.error);
    setLive(null);
    setStartedAt(null);
  }

  const nothingToDo = analysis?.fallback === 'nothing_to_rank' && analysis.note;

  return (
    <>
      <div className="block-head">
        <h2>What the agents suggest</h2>
        <span className="muted-note">
          {recommendations.length} {recommendations.length === 1 ? 'action' : 'actions'} worth your
          attention
        </span>
        <Button size="sm" onClick={() => void analyse()} disabled={running}>
          {running ? (
            <>
              Analysing… <Elapsed since={startedAt} />
            </>
          ) : (
            'Run AI analysis'
          )}
        </Button>
      </div>
      {analysis && !running && (
        <p className="muted-note">
          <Chip
            tone={
              analysis.source === 'llm'
                ? 'ai'
                : analysis.fallback === 'nothing_to_rank'
                  ? undefined
                  : 'watch'
            }
          >
            {analysis.source === 'llm'
              ? 'AI-ranked'
              : analysis.fallback === 'nothing_to_rank'
                ? 'Nothing for the AI to rank'
                : 'Heuristic (AI unavailable)'}
          </Chip>
          {analysis.note && !nothingToDo && <small> {analysis.note}</small>}
        </p>
      )}
      {analysis?.cachedAt && !running && <SavedAge cachedAt={analysis.cachedAt} />}
      {live ? (
        <AiTrace pipeline={live} startedAt={startedAt} />
      ) : (
        analysis && (
          <AiTrace
            pipeline={pipelineOf(analysis)}
            ms={analysis.run?.ms ?? null}
            cachedAt={analysis.cachedAt}
            calledTools={analysis.calledTools}
            why={nothingToDo ? analysis.note : null}
          />
        )
      )}
      {portfolioChanged && (
        <p className="muted-note">Your portfolio changed — run the AI analysis again.</p>
      )}
      {error && (
        <div className="callout warn" role="alert">
          AI analysis failed: {error}
        </div>
      )}
      {!nothingToDo && recommendations.length === 0 && skipped.length === 0 && (
        <p className="muted-note">
          Nothing to improve right now — the portfolio looks balanced at current prices.
        </p>
      )}
      {skipped.length > 0 && (
        <ul className="muted-note">
          {skipped.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
      {recommendations.length > 0 && (
        <div
          className={`recs${running ? ' is-stale' : ''}`}
          key={analysis ? ai?.run : 'rules'}
          aria-busy={running}
        >
          {recommendations.map((r, i) => {
            const request = recommendationToPrepare(r.intent, account);
            const logos = intentTokens(r.intent).map((t) => ({
              icon: icons[t] ?? null,
              symbol: holdings.find((h) => h.token === t)?.symbol ?? label(t, new Map()).symbol,
            }));
            return (
              <Card
                key={r.id}
                urgent={r.severity === 'warning'}
                className={analysis ? 'rec-in' : undefined}
                style={order(i)}
              >
                <span className="rec-agent">
                  <span className="rec-agent-dot" aria-hidden="true" />
                  {r.agent}
                </span>
                <div className="rec-head">
                  {logos.length > 0 && <TokenIcons tokens={logos} size={28} />}
                  <h3>{r.title}</h3>
                </div>
                <p className="rec-why">{r.why}</p>
                {r.carry && (
                  <p className="muted-note">
                    {r.carry.text}{' '}
                    <ProvenanceMark
                      kind={r.carry.provenance === 'protocol_reported' ? 'on_chain' : 'estimate'}
                      title={PROVENANCE_TIER_INFO[r.carry.provenance].describe}
                    >
                      {PROVENANCE_TIER_INFO[r.carry.provenance].label}
                    </ProvenanceMark>
                  </p>
                )}
                {r.intent &&
                (r.intent.action === 'repay' || r.intent.action === 'repay_from_collateral') &&
                r.intent.sizing ? (
                  <RepayPicker
                    intent={{ ...r.intent, action: r.intent.action }}
                    sizing={r.intent.sizing}
                    account={account}
                    label={actionLabel(r.intent)}
                    signingEnabled={signingEnabled}
                  />
                ) : request && r.intent ? (
                  <PrepareDialog
                    request={request}
                    label={actionLabel(r.intent)}
                    signingEnabled={signingEnabled}
                  />
                ) : (
                  <span className="muted-note">
                    Advisory — no one-click action for this one yet.
                  </span>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Ticks on its own so the list around it does not re-render ten times a second. */
const AGE_TICK_MS = 30_000;

/** The current time, re-read every 30 s, so an age on screen keeps counting without a reload. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Ago({ iso }: { iso: string }) {
  const now = useNow();
  return <span suppressHydrationWarning>{ago(iso, new Date(now).toISOString())}</span>;
}

function SavedAge({ cachedAt }: { cachedAt: string }) {
  const fresh = useNow() - Date.parse(cachedAt) < FRESH_MS;
  return fresh ? (
    <p className="callout good" role="status">
      ✓ Up to date — your portfolio hasn&apos;t changed since this analysis (<Ago iso={cachedAt} />
      ).
    </p>
  ) : (
    <p className="callout" role="status">
      Your portfolio hasn&apos;t changed since this analysis (<Ago iso={cachedAt} />
      ), but prices and rates may have. Run the AI analysis again for fresh numbers.
    </p>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [since]);
  return <>{seconds(Math.max(0, now - since))}</>;
}

type StageState = 'done' | 'active' | 'pending';

/**
 * The run as a pipeline: what was read, what each agent returned (key number, its provenance, what became of its
 * card), what the model did, and what code checked before the user saw it. Live (`startedAt` set), every stage is
 * shown from the first event: the one the server is on now pulses, the ones still ahead are dimmed, and each agent
 * the model asked for waits on a placeholder until its own result arrives.
 */
function AiTrace({
  pipeline,
  startedAt = null,
  ms = null,
  cachedAt = null,
  calledTools = [],
  why = null,
}: {
  pipeline: Pipeline;
  startedAt?: number | null;
  ms?: number | null;
  cachedAt?: string | null;
  calledTools?: readonly string[];
  /** Why the model was not asked, built by code from the agents' lines. */
  why?: string | null;
}) {
  const { model, read, asked, trace, turns, checks, stage, ranking } = pipeline;
  const live = startedAt !== null;
  if (!live && trace.length === 0) {
    if (calledTools.length === 0) return null;
    return <p className="muted-note">Agents called: {calledTools.join(', ')}</p>;
  }
  if (!live && !model)
    return (
      <Panel className="ai-trace" label="How the AI got here">
        <header>
          <h3>How the AI got here</h3>
        </header>
        <ol className="ai-steps">
          {read && (
            <Stage state="done" title="Read the wallet on-chain">
              <span className="ai-step-note">{readLine(read)}</span>
            </Stage>
          )}
          <Stage state="done" title={`${plural(trace.length, 'agent')} ran`}>
            <ul className="ai-agents">
              {trace.map((step, i) => (
                <AgentRow key={step.tool} agent={step.agent} step={step} index={i} />
              ))}
            </ul>
          </Stage>
          <Stage state="skipped" title="AI not asked: nothing worth ranking">
            <span className="ai-step-note">
              No paid model call.
              {why && (
                <>
                  {' '}
                  Why: {why}{' '}
                  <span
                    className="ai-tag"
                    title={PROVENANCE_TIER_INFO.calculated_estimate.describe}
                  >
                    {PROVENANCE_TIER_INFO.calculated_estimate.label}
                  </span>
                </>
              )}
            </span>
          </Stage>
        </ol>
      </Panel>
    );
  const who = model ? modelName(model) : 'The AI';
  const current = stage;
  const state = (i: number): StageState =>
    i < current ? 'done' : i === current ? 'active' : 'pending';
  const rows = [...asked, ...trace.filter((t) => !asked.some((a) => a.tool === t.tool))].map(
    ({ tool, agent }) => ({ tool, agent, step: trace.find((t) => t.tool === tool) }),
  );
  const answered = rows.filter((r) => r.step).length;
  const agentsTitle =
    state(1) === 'done'
      ? answered < rows.length
        ? `${answered} of ${plural(rows.length, 'agent')} answered`
        : `${plural(trace.length, 'agent')} ran`
      : asked.length > 0
        ? `Asking ${plural(asked.length, 'agent')}`
        : `${who} picks the agents to ask`;
  const status = [
    'Reading the wallet on-chain',
    asked.length > 0 ? agentsTitle : `${who} is choosing which agents to ask`,
    `${who} is ranking the answers`,
    'Code is checking the answer',
    'Done',
  ][current];

  return (
    <Panel className="ai-trace" label="How the AI got here" busy={live}>
      <header>
        <h3>How the AI got here</h3>
        <span className="muted-note ai-clock" suppressHydrationWarning>
          {model && `${modelName(model)} · `}
          {live ? (
            <Elapsed since={startedAt} />
          ) : cachedAt ? (
            <>
              from a run <Ago iso={cachedAt} />
            </>
          ) : (
            ms !== null && seconds(ms)
          )}
        </span>
      </header>
      {live && (
        <p className="sr-only" aria-live="polite">
          {status}
        </p>
      )}
      <ol className="ai-steps">
        <Stage state={state(0)} title="Read the wallet on-chain">
          {read && <span className="ai-step-note ai-in">{readLine(read)}</span>}
        </Stage>
        <Stage state={state(1)} title={agentsTitle}>
          {state(1) === 'active' && asked.length === 0 && (
            <span className="ai-step-note ai-thinking">Deciding which agents to ask…</span>
          )}
          {rows.length > 0 && (
            <ul className="ai-agents">
              {rows.map(({ tool, agent, step }, i) => (
                <AgentRow key={tool} agent={agent} step={step} index={i} />
              ))}
            </ul>
          )}
        </Stage>
        <Stage
          state={state(2)}
          title={state(2) === 'done' ? `${who} ranked them` : `${who} ranks them`}
        >
          {state(2) === 'active' && (
            <span className="ai-step-note ai-thinking">Ordering the answers and writing why…</span>
          )}
          {turns !== null && (
            <span className="ai-step-note ai-in">
              {checks && `${plural(checks.picked, 'card')} picked and explained in `}
              {plural(turns, 'model turn')}
            </span>
          )}
          {ranking && (
            <span className="ai-step-note ai-in">
              Why this order: {ranking}{' '}
              <span className="ai-tag" title={PROVENANCE_TIER_INFO.calculated_estimate.describe}>
                {PROVENANCE_TIER_INFO.calculated_estimate.label}
              </span>
            </span>
          )}
        </Stage>
        <Stage
          state={state(3)}
          title={state(3) === 'done' ? 'Code checked the answer' : 'Code checks the answer'}
        >
          {state(3) === 'active' && (
            <span className="ai-step-note ai-thinking">Matching every number to the agents…</span>
          )}
          {checks && (
            <ul className="ai-checks">
              <li className={`ai-in${checks.replaced ? ' warn' : ''}`} style={order(0)}>
                {explained(checks.explained, checks.explained + checks.replaced)}
                {checks.replaced > 0 && `; ${checks.replaced} replaced by the agent's own text`}
              </li>
              <li className="ai-in" style={order(1)}>
                {checks.restored > 0
                  ? `${plural(checks.restored, 'warning')} the AI left out put back first`
                  : 'No warning was left out'}
              </li>
              <li className="ai-in" style={order(2)}>
                {checks.dropped > 0
                  ? `${plural(checks.dropped, 'made-up or repeated action')} dropped`
                  : 'No made-up actions'}
              </li>
            </ul>
          )}
        </Stage>
      </ol>
    </Panel>
  );
}

const readLine = (read: NonNullable<Pipeline['read']>) =>
  `${plural(read.tokens, 'token')} held in the wallet or on Burrow${read.loan ? ', and a Burrow loan' : ', no loan'}`;

function Stage({
  state,
  title,
  children,
}: {
  state: StageState | 'skipped';
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className={`is-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
      <strong>{title}</strong>
      {state !== 'pending' && children}
    </li>
  );
}

function AgentRow({
  agent,
  step,
  index,
}: {
  agent: string;
  step: TraceStep | undefined;
  index: number;
}) {
  if (!step)
    return (
      <li className="waiting">
        <span className="ai-agent">{agent}</span>
        <span className="ai-wait" aria-label="waiting for its answer" />
        <span />
      </li>
    );
  const info = step.provenance ? PROVENANCE_TIER_INFO[step.provenance] : null;
  return (
    <li className={step.ok ? `pick-${step.pick ?? 'none'}` : 'failed'}>
      <span className="ai-agent">{agent}</span>
      <span className="ai-number ai-in" style={order(index)}>
        {step.text}
      </span>
      <span className="ai-tags">
        {info && (
          <span className="ai-tag ai-in" title={info.describe} style={order(index)}>
            {info.label}
          </span>
        )}
        {step.pick && <span className={`ai-tag pick ${step.pick} ai-in`}>{pickLabel(step)}</span>}
      </span>
    </li>
  );
}

/** Items that arrive together come in one after another: presentation only, the data is already here. */
const order = (i: number) => ({ '--i': i }) as CSSProperties;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const explained = (ok: number, all: number) =>
  `${ok} of ${all} AI ${all === 1 ? 'explanation uses' : 'explanations use'} only numbers the agents returned`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function pickLabel({ pick, rank }: TraceStep): string {
  if (pick === 'left_out') return 'left out by the AI';
  return pick === 'kept' ? `#${rank} · put back by code` : `#${rank} in the AI ranking`;
}
