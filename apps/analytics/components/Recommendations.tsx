'use client';
import { useEffect, useState } from 'react';
import { runAnalysis, type Analysis } from '../lib/analysis-client';
import type { AccountRecommendation } from '../lib/product';
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
  signingEnabled,
}: {
  account: string;
  recommendations: readonly AccountRecommendation[];
  signingEnabled: boolean;
}) {
  const [running, setRunning] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recommendations = analysis?.recommendations ?? initial;

  useEffect(() => setAnalysis(null), [initial]);

  async function analyse() {
    setRunning(true);
    setError(null);
    const r = await runAnalysis(account);
    if (r.ok) setAnalysis(r.analysis);
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
