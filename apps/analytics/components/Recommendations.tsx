'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const railRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(0);
  const [canMoveBack, setCanMoveBack] = useState(false);
  const [canMoveForward, setCanMoveForward] = useState(false);
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
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rail.clientWidth : 1;
      const delta = event.deltaY * scale;
      const max = rail.scrollWidth - rail.clientWidth;
      const atStart = rail.scrollLeft <= 1;
      const atEnd = rail.scrollLeft >= max - 1;
      if (max <= 1 || (delta < 0 && atStart) || (delta > 0 && atEnd)) return;
      event.preventDefault();
      rail.scrollLeft = Math.max(0, Math.min(max, rail.scrollLeft + delta));
    };
    rail.addEventListener('wheel', wheel, { passive: false });
    return () => rail.removeEventListener('wheel', wheel);
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

  // The page re-reads every 20 s with a new array; drop the AI result only when the cards themselves change (ids and
  // headline numbers, e.g. after a signed transaction), not on every refresh.
  const signature = initial.map((r) => `${r.id}:${r.title}`).join('|');
  useEffect(() => setAnalysis(null), [signature]);

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
