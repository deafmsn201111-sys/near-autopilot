'use client';
import { PROVENANCE_TIER_INFO } from '@near-autopilot/core';
import { useState } from 'react';
import { modelName, runAnalysis, type Analysis, type TraceStep } from '../lib/analysis-client';
import { portfolioSignature } from '../lib/portfolio-signature';
import type { AccountRecommendation, PortfolioView } from '../lib/product';
import { actionLabel, recommendationToPrepare } from '../lib/recommendation-intent';
import { PrepareDialog } from './PrepareDialog';

/**
 * The agents' recommendations for the connected wallet, each a card: what (title), why (plain language), which agent,
 * and — when the engine can assemble it — a one-click button that prepares the exact transaction cascade to sign.
 * "Run AI analysis" swaps the list for the API's re-ranked one. Signing (if enabled) happens inside the dialog.
 */
export function Recommendations({
  account,
  recommendations: initial,
  holdings,
  signingEnabled,
}: {
  account: string;
  recommendations: readonly AccountRecommendation[];
  holdings: PortfolioView['holdings'];
  signingEnabled: boolean;
}) {
  const [running, setRunning] = useState(false);
  const [ai, setAi] = useState<{ analysis: Analysis; signature: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signature = portfolioSignature(initial, holdings);
  const analysis = ai?.signature === signature ? ai.analysis : null;
  const portfolioChanged = ai !== null && analysis === null;
  const recommendations = analysis?.recommendations ?? initial;

  async function analyse() {
    setRunning(true);
    setError(null);
    const r = await runAnalysis(account);
    if (r.ok) setAi({ analysis: r.analysis, signature });
    else setError(r.error);
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
      {analysis && <AiTrace analysis={analysis} />}
      {portfolioChanged && (
        <p className="muted-note">Your portfolio changed — run the AI analysis again.</p>
      )}
      {error && (
        <div className="callout warn" role="alert">
          AI analysis failed: {error}
        </div>
      )}
      {recommendations.length === 0 ? (
        <p className="muted-note">
          Nothing to improve right now — the portfolio looks balanced at current prices.
        </p>
      ) : (
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
                {request ? (
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

/** Which agents the model called and the key number each returned, with where that number came from. */
function AiTrace({ analysis }: { analysis: Analysis }) {
  if (analysis.trace.length === 0) {
    if (analysis.calledTools.length === 0) return null;
    return <p className="muted-note">Agents called: {analysis.calledTools.join(', ')}</p>;
  }
  return (
    <div className="ai-trace">
      <h3>How the AI got here</h3>
      {analysis.run && (
        <p className="muted-note">
          {modelName(analysis.run.model)} · {analysis.run.toolCalls} agent calls ·{' '}
          {analysis.run.turns} model turns · {(analysis.run.ms / 1000).toFixed(1)} s
        </p>
      )}
      <ul>
        {analysis.trace.map((step) => {
          const info = step.provenance ? PROVENANCE_TIER_INFO[step.provenance] : null;
          return (
            <li key={step.tool} className={step.ok ? undefined : 'failed'}>
              <strong>{step.agent}</strong> — {step.text}
              {info && (
                <span className="badge neutral" title={info.describe}>
                  {info.label}
                </span>
              )}
              {step.pick && <span className={`ai-pick ${step.pick}`}>{pickLabel(step)}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function pickLabel({ pick, rank }: TraceStep): string {
  if (pick === 'left_out') return 'left out by the AI';
  return pick === 'kept' ? `#${rank} · kept by code` : `#${rank} in the AI ranking`;
}
