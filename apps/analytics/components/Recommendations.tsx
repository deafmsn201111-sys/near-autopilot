'use client';
import { PROVENANCE_TIER_INFO } from '@near-autopilot/core';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  skipped,
  holdings,
  signingEnabled,
}: {
  account: string;
  recommendations: readonly AccountRecommendation[];
  skipped: readonly string[];
  holdings: PortfolioView['holdings'];
  signingEnabled: boolean;
}) {
  const [running, setRunning] = useState(false);
  const [ai, setAi] = useState<{ analysis: Analysis; signature: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(0);
  const [canMoveBack, setCanMoveBack] = useState(false);
  const [canMoveForward, setCanMoveForward] = useState(false);
  const signature = portfolioSignature(initial, holdings);
  const analysis = ai?.signature === signature ? ai.analysis : null;
  const portfolioChanged = ai !== null && analysis === null;
  const recommendations = analysis?.recommendations ?? initial;

  const measureRail = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const first = rail.firstElementChild as HTMLElement | null;
    const step = first ? first.getBoundingClientRect().width + 16 : 1;
    setPosition(Math.min(recommendations.length, Math.floor((rail.scrollLeft + 1) / step) + 1));
    setCanMoveBack(rail.scrollLeft > 1);
    setCanMoveForward(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1);
  }, [recommendations.length]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    measureRail();
    rail.addEventListener('scroll', measureRail, { passive: true });
    const resize = new ResizeObserver(measureRail);
    resize.observe(rail);
    return () => {
      rail.removeEventListener('scroll', measureRail);
      resize.disconnect();
    };
  }, [measureRail]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let snapTimer: ReturnType<typeof setTimeout> | undefined;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      const horizontalGesture = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const rawDelta = horizontalGesture ? event.deltaX : event.deltaY;
      const scale = event.deltaMode === 1 ? 36 : event.deltaMode === 2 ? rail.clientHeight : 1;
      const delta = rawDelta * scale;
      const max = rail.scrollWidth - rail.clientWidth;
      if (max < 2 || Math.abs(delta) < 0.1) return;
      const next = Math.max(0, Math.min(max, rail.scrollLeft + delta));
      if (Math.abs(next - rail.scrollLeft) < 0.1) return;
      event.preventDefault();
      rail.classList.add('wheel-scrolling');
      rail.scrollLeft = next;
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => rail.classList.remove('wheel-scrolling'), 220);
    };
    rail.addEventListener('wheel', wheel, { passive: false });
    return () => {
      rail.removeEventListener('wheel', wheel);
      clearTimeout(snapTimer);
      rail.classList.remove('wheel-scrolling');
    };
  }, [recommendations.length]);

  const moveRail = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    const first = rail.firstElementChild as HTMLElement | null;
    rail.scrollBy({
      left: direction * ((first?.getBoundingClientRect().width ?? 360) + 16),
      behavior: 'smooth',
    });
  };

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
        <>
          <div className="recommendation-controls" aria-label="Recommendation navigation">
            <span aria-live="polite">
              {position} / {recommendations.length}
            </span>
            <button
              type="button"
              aria-label="Previous recommendation"
              disabled={!canMoveBack}
              onClick={() => moveRail(-1)}
            >
              ←
            </button>
            <button
              type="button"
              aria-label="Next recommendation"
              disabled={!canMoveForward}
              onClick={() => moveRail(1)}
            >
              →
            </button>
          </div>
          <div
            className="recs"
            ref={railRef}
            tabIndex={0}
            role="region"
            aria-label="Recommendations. Use arrow keys to browse."
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                moveRail(1);
              }
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                moveRail(-1);
              }
              if (event.key === 'Home') {
                event.preventDefault();
                railRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
              }
              if (event.key === 'End') {
                event.preventDefault();
                railRef.current?.scrollTo({
                  left: railRef.current.scrollWidth,
                  behavior: 'smooth',
                });
              }
            }}
          >
            {recommendations.map((r, index) => {
              const request = recommendationToPrepare(r.intent, account);
              return (
                <article
                  className={`rec decision-card sev-${r.severity}${index === 0 ? ' decision-priority' : ''}`}
                  key={r.id}
                >
                  <div className="decision-card-meta">
                    <span className="rec-agent">
                      <span className="rec-agent-dot" aria-hidden="true" />
                      {r.agent}
                    </span>
                    <span
                      className={`decision-badge ${r.severity === 'warning' ? 'is-warning' : 'is-neutral'}`}
                    >
                      {r.severity === 'warning' ? 'Priority · Risk' : 'Review'}
                    </span>
                  </div>
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
                      Read analysis · No prepared action is available for this recommendation.
                    </span>
                  )}
                  <p className="decision-disclaimer">
                    Opens a transaction review. Nothing is signed or sent yet.
                  </p>
                </article>
              );
            })}
          </div>
          <p className="recommendation-hint">
            Scroll with your mouse wheel or use arrows. Nothing executes automatically.
          </p>
        </>
      )}
    </>
  );
}

/**
 * The run as a pipeline: what was read, what each agent returned (key number, its provenance, what became of its
 * card), what the model did, and what code checked before the user saw it.
 */
function AiTrace({ analysis }: { analysis: Analysis }) {
  const { trace, run } = analysis;
  if (trace.length === 0) {
    if (analysis.calledTools.length === 0) return null;
    return <p className="muted-note">Agents called: {analysis.calledTools.join(', ')}</p>;
  }
  return (
    <details className="ai-trace">
      <summary>
        <strong>How the AI got here</strong>
        {run && (
          <span className="muted-note">
            {modelName(run.model)} · {(run.ms / 1000).toFixed(1)} s
          </span>
        )}
      </summary>
      <ol className="ai-steps">
        {run && (
          <li>
            <strong>Read the wallet on-chain</strong>
            <span className="ai-step-note">
              {plural(run.read.tokens, 'token')} held in the wallet or on Burrow
              {run.read.loan ? ', and a Burrow loan' : ', no loan'}
            </span>
          </li>
        )}
        <li>
          <strong>{plural(trace.length, 'agent')} ran</strong>
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
        {run && (
          <li>
            <strong>{modelName(run.model)} ranked them</strong>
            <span className="ai-step-note">
              {plural(run.checks.picked, 'card')} picked and explained in{' '}
              {plural(run.turns, 'model turn')}
            </span>
          </li>
        )}
        {run && (
          <li>
            <strong>Code checked the answer</strong>
            <ul className="ai-checks">
              <li className={run.checks.replaced ? 'warn' : undefined}>
                {explained(run.checks.explained, run.checks.explained + run.checks.replaced)}
                {run.checks.replaced > 0 &&
                  `; ${run.checks.replaced} replaced by the agent's own text`}
              </li>
              <li>
                {run.checks.restored > 0
                  ? `${plural(run.checks.restored, 'warning')} the AI left out put back first`
                  : 'No warning was left out'}
              </li>
              <li>
                {run.checks.dropped > 0
                  ? `${plural(run.checks.dropped, 'made-up or repeated action')} dropped`
                  : 'No made-up actions'}
              </li>
            </ul>
          </li>
        )}
      </ol>
    </details>
  );
}

const explained = (ok: number, all: number) =>
  `${ok} of ${all} AI ${all === 1 ? 'explanation uses' : 'explanations use'} only numbers the agents returned`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function pickLabel({ pick, rank }: TraceStep): string {
  if (pick === 'left_out') return 'left out by the AI';
  return pick === 'kept' ? `#${rank} · put back by code` : `#${rank} in the AI ranking`;
}
