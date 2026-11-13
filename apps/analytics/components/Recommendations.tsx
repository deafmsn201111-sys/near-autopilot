'use client';
import { PROVENANCE_TIER_INFO } from '@near-autopilot/core';
import { useState } from 'react';
import {
  modelName,
  pipelineOf,
  runAnalysis,
  type Analysis,
  type Pipeline,
  type TraceStep,
} from '../lib/analysis-client';
import { portfolioSignature } from '../lib/portfolio-signature';
import type { AccountRecommendation, PortfolioView } from '../lib/product';
import type { StrategyId } from '@near-autopilot/core/strategy';
import { actionLabel, recommendationToPrepare } from '../lib/recommendation-intent';
import { PrepareDialog } from './PrepareDialog';
import { RepayPicker } from './RepayPicker';

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
  signingEnabled,
}: {
  account: string;
  strategy: StrategyId;
  recommendations: readonly AccountRecommendation[];
  skipped: readonly string[];
  holdings: PortfolioView['holdings'];
  signingEnabled: boolean;
}) {
  const [running, setRunning] = useState(false);
  const [ai, setAi] = useState<{ analysis: Analysis; signature: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Pipeline | null>(null);
  const signature = portfolioSignature(initial, holdings);
  const analysis = ai?.signature === signature ? ai.analysis : null;
  const portfolioChanged = ai !== null && analysis === null;
  const recommendations = analysis?.recommendations ?? initial;

  async function analyse() {
    setRunning(true);
    setError(null);
    setLive(null);
    const r = await runAnalysis(account, strategy, setLive);
    if (r.ok) setAi({ analysis: r.analysis, signature });
    else setError(r.error);
    setLive(null);
    setRunning(false);
  }

  return (
    <>
      <div className="block-head">
        <h2>What the agents suggest</h2>
        <span className="muted-note">
          {recommendations.length} {recommendations.length === 1 ? 'action' : 'actions'} worth your
          attention
        </span>
        <button
          type="button"
          className="btn secondary small"
          onClick={() => void analyse()}
          disabled={running}
        >
          {running ? 'Analysing…' : 'Run AI analysis'}
        </button>
      </div>
      {analysis && (
        <p className="muted-note">
          <span className={`badge ${analysis.source === 'llm' ? 'good' : 'neutral'}`}>
            <i aria-hidden="true">{analysis.source === 'llm' ? '✓' : '!'}</i>
            {analysis.source === 'llm' ? 'AI-ranked' : 'Heuristic (AI unavailable)'}
          </span>
          {analysis.note && <small> {analysis.note}</small>}
        </p>
      )}
      {live ? (
        <AiTrace pipeline={live} live />
      ) : (
        analysis && (
          <AiTrace
            pipeline={pipelineOf(analysis)}
            ms={analysis.run?.ms ?? null}
            calledTools={analysis.calledTools}
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
      {recommendations.length === 0 && skipped.length === 0 && (
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
        <div className="recs">
          {recommendations.map((r) => {
            const request = recommendationToPrepare(r.intent, account);
            return (
              <article className={`rec sev-${r.severity}`} key={r.id}>
                <span className="rec-agent">
                  <span className="rec-agent-dot" aria-hidden="true" />
                  {r.agent}
                </span>
                <div className="rec-head">
                  <h3>{r.title}</h3>
                </div>
                <p className="rec-why">{r.why}</p>
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
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * The run as a pipeline: what was read, what each agent returned (key number, its provenance, what became of its
 * card), what the model did, and what code checked before the user saw it. Live, each part appears as its event
 * arrives from the server.
 */
function AiTrace({
  pipeline,
  live = false,
  ms = null,
  calledTools = [],
}: {
  pipeline: Pipeline;
  live?: boolean;
  ms?: number | null;
  calledTools?: readonly string[];
}) {
  const { model, read, trace, turns, checks } = pipeline;
  if (!live && trace.length === 0) {
    if (calledTools.length === 0) return null;
    return <p className="muted-note">Agents called: {calledTools.join(', ')}</p>;
  }
  return (
    <section className="ai-trace" aria-label="How the AI got here" aria-busy={live}>
      <header>
        <h3>How the AI got here</h3>
        {model && (
          <span className="muted-note">
            {modelName(model)} · {ms === null ? 'running…' : `${(ms / 1000).toFixed(1)} s`}
          </span>
        )}
      </header>
      <ol className="ai-steps">
        {read && (
          <li>
            <strong>Read the wallet on-chain</strong>
            <span className="ai-step-note">
              {plural(read.tokens, 'token')} held in the wallet or on Burrow
              {read.loan ? ', and a Burrow loan' : ', no loan'}
            </span>
          </li>
        )}
        <li>
          <strong>
            {trace.length === 0 ? 'Agents running…' : `${plural(trace.length, 'agent')} ran`}
          </strong>
          <ul className="ai-agents">
            {trace.map((step) => {
              const info = step.provenance ? PROVENANCE_TIER_INFO[step.provenance] : null;
              return (
                <li key={step.tool} className={step.ok ? `pick-${step.pick ?? 'none'}` : 'failed'}>
                  <span className="ai-agent">{step.agent}</span>
                  <span className="ai-number">{step.text}</span>
                  <span className="ai-tags">
                    {info && (
                      <span className="ai-tag" title={info.describe}>
                        {info.label}
                      </span>
                    )}
                    {step.pick && (
                      <span className={`ai-tag pick ${step.pick}`}>{pickLabel(step)}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </li>
        {model && turns !== null && (
          <li>
            <strong>{modelName(model)} ranked them</strong>
            <span className="ai-step-note">
              {checks && `${plural(checks.picked, 'card')} picked and explained in `}
              {plural(turns, 'model turn')}
            </span>
          </li>
        )}
        {checks && (
          <li>
            <strong>Code checked the answer</strong>
            <ul className="ai-checks">
              <li className={checks.replaced ? 'warn' : undefined}>
                {explained(checks.explained, checks.explained + checks.replaced)}
                {checks.replaced > 0 && `; ${checks.replaced} replaced by the agent's own text`}
              </li>
              <li>
                {checks.restored > 0
                  ? `${plural(checks.restored, 'warning')} the AI left out put back first`
                  : 'No warning was left out'}
              </li>
              <li>
                {checks.dropped > 0
                  ? `${plural(checks.dropped, 'made-up or repeated action')} dropped`
                  : 'No made-up actions'}
              </li>
            </ul>
          </li>
        )}
      </ol>
    </section>
  );
}

const explained = (ok: number, all: number) =>
  `${ok} of ${all} AI ${all === 1 ? 'explanation uses' : 'explanations use'} only numbers the agents returned`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function pickLabel({ pick, rank }: TraceStep): string {
  if (pick === 'left_out') return 'left out by the AI';
  return pick === 'kept' ? `#${rank} · put back by code` : `#${rank} in the AI ranking`;
}
