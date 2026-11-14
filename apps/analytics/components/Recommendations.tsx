'use client';
import { PROVENANCE_TIER_INFO } from '@near-autopilot/core';
import { useState, type CSSProperties } from 'react';
import { parseSaved, runAnalysis, type Analysis, type Pipeline } from '../lib/analysis-client';
import { portfolioSignature } from '../lib/portfolio-signature';
import type { AccountRecommendation, PortfolioView } from '../lib/product';
import type { StrategyId } from '@near-autopilot/core/strategy';
import { actionLabel, intentTokens, recommendationToPrepare } from '../lib/recommendation-intent';
import { label } from '../lib/token-label';
import { AnalysisPanel } from './AnalysisPanel';
import { TokenIcons } from './TokenIcon';
import { PrepareDialog } from './PrepareDialog';
import { RepayPicker } from './RepayPicker';
import { Card, ProvenanceMark } from './primitives';

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
  strategyNote,
  aiAllowed,
  hasLoan,
  loanValued,
  hasLp,
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
  strategyNote?: string | null;
  /** The visitor proved they own the account: only then may the model analyse it. */
  aiAllowed: boolean;
  hasLoan: boolean;
  loanValued: boolean;
  hasLp: boolean;
}) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [ai, setAi] = useState<{ analysis: Analysis; signature: string; run: number } | null>(() =>
    restore(saved),
  );
  const [error, setError] = useState<string | null>(null);
  // The panel stays mounted across a strategy switch so the focused radio keeps focus; the analysis is per strategy.
  const [shownFor, setShownFor] = useState(strategy);
  if (shownFor !== strategy) {
    setShownFor(strategy);
    setAi(restore(saved));
    setError(null);
  }
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

  return (
    <>
      <AnalysisPanel
        account={account}
        strategy={strategy}
        strategyNote={strategyNote}
        recommendations={recommendations}
        rules={initial}
        skipped={skipped}
        analysis={analysis}
        live={live}
        startedAt={startedAt}
        ranAt={analysis && (analysis.cachedAt ?? (ai?.run ? new Date(ai.run).toISOString() : null))}
        aiAllowed={aiAllowed}
        hasLoan={hasLoan}
        loanValued={loanValued}
        hasLp={hasLp}
        portfolioChanged={portfolioChanged}
        error={error}
        onRun={() => void analyse()}
      />
      {(recommendations.length > 0 || skipped.length > 0) && (
        <div className="block-head an-recs-head">
          <h2>What the agents suggest</h2>
          <span className="muted-note">
            {recommendations.length} {recommendations.length === 1 ? 'action' : 'actions'} worth
            your attention
          </span>
        </div>
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
                className={`rec sev-${r.severity}${analysis ? ' rec-in' : ''}`}
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
                      kind="estimate"
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

const restore = (saved: unknown) => {
  const restored = parseSaved(saved);
  return restored && { ...restored, run: 0 };
};

/** Items that arrive together come in one after another: presentation only, the data is already here. */
const order = (i: number) => ({ '--i': i }) as CSSProperties;
