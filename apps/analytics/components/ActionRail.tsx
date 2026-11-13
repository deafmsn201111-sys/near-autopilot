'use client';
import { useEffect, useRef, useState } from 'react';
import type { PortfolioAction } from '../lib/product';

const money = (value: number, signed = false) =>
  `${signed && value >= 0 ? '+' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ActionRail({ actions }: { actions: readonly PortfolioAction[] }) {
  const rail = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(1);
  const move = (direction: -1 | 1) => {
    const node = rail.current;
    const card = node?.firstElementChild as HTMLElement | null;
    if (node && card)
      node.scrollBy({ left: direction * (card.offsetWidth + 16), behavior: 'smooth' });
  };
  useEffect(() => {
    const node = rail.current;
    if (!node) return;
    const update = () => {
      const card = node.firstElementChild as HTMLElement | null;
      const step = (card?.offsetWidth ?? 1) + 16;
      setPosition(Math.min(actions.length, Math.floor((node.scrollLeft + 1) / step) + 1));
    };
    node.addEventListener('scroll', update, { passive: true });
    return () => node.removeEventListener('scroll', update);
  }, [actions.length]);
  useEffect(() => {
    const node = rail.current;
    if (!node) return;
    let snapTimer: ReturnType<typeof setTimeout> | undefined;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      const horizontalGesture = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const rawDelta = horizontalGesture ? event.deltaX : event.deltaY;
      const scale = event.deltaMode === 1 ? 36 : event.deltaMode === 2 ? node.clientHeight : 1;
      const delta = rawDelta * scale;
      const max = node.scrollWidth - node.clientWidth;
      if (max < 2 || Math.abs(delta) < 0.1) return;
      const next = Math.max(0, Math.min(max, node.scrollLeft + delta));
      if (Math.abs(next - node.scrollLeft) < 0.1) return;
      event.preventDefault();
      node.classList.add('wheel-scrolling');
      node.scrollLeft = next;
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => node.classList.remove('wheel-scrolling'), 220);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => {
      node.removeEventListener('wheel', wheel);
      clearTimeout(snapTimer);
      node.classList.remove('wheel-scrolling');
    };
  }, [actions.length]);

  return (
    <>
      <div className="decision-rail-head">
        <p>Scroll to compare recommendations · No automatic execution</p>
        <div className="decision-rail-controls" aria-label="Recommendation navigation">
          <span aria-live="polite">
            {position} / {actions.length}
          </span>
          <button type="button" aria-label="Previous recommendation" onClick={() => move(-1)}>
            ←
          </button>
          <button type="button" aria-label="Next recommendation" onClick={() => move(1)}>
            →
          </button>
        </div>
      </div>
      <div
        className="decision-rail"
        ref={rail}
        tabIndex={0}
        role="region"
        aria-label="Portfolio recommendations. Use arrow keys to browse."
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            move(event.key === 'ArrowRight' ? 1 : -1);
          }
        }}
      >
        {actions.map((action, index) => {
          const positive = action.autopilot.verdict === 'worth_it';
          return (
            <article
              className={`decision-card${positive ? ' decision-priority' : ''}`}
              key={action.id}
            >
              <div className="decision-card-meta">
                <span>
                  {String(index + 1).padStart(2, '0')} / {action.kind.replace('_', ' ')}
                </span>
                <span className={`decision-badge ${positive ? 'is-positive' : 'is-neutral'}`}>
                  {positive ? 'Worth reviewing' : 'Compare'}
                </span>
              </div>
              <h3>{action.title}</h3>
              <p className="decision-why">{action.summary}</p>
              <div className="decision-effect">
                <div>
                  <span>Estimated net result</span>
                  <strong
                    className={action.netUsd !== null && action.netUsd < 0 ? 'is-negative' : ''}
                  >
                    {action.netUsd === null
                      ? 'Unavailable'
                      : `${action.netUsd >= 0 ? '+' : '−'}${money(Math.abs(action.netUsd))}`}
                  </strong>
                </div>
                <div>
                  <span>Time horizon</span>
                  <strong>{action.horizonDays} days</strong>
                </div>
              </div>
              <p className="decision-verdict">{action.autopilot.sentence}</p>
              <details className="decision-plan">
                <summary>
                  Review plan and risks <span aria-hidden="true">↗</span>
                </summary>
                <div className="decision-plan-content">
                  <div>
                    <h4>What would happen</h4>
                    <ol>
                      {action.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <h4>Costs and risks</h4>
                    <ul>
                      {action.costs.map((cost) => (
                        <li key={cost.label}>
                          {cost.label}: {money(cost.usd, true)}
                        </li>
                      ))}
                      {action.risks.map((risk) => (
                        <li key={risk}>{risk}</li>
                      ))}
                    </ul>
                  </div>
                  <p>{action.basis}</p>
                </div>
              </details>
              <p className="decision-disclaimer">Opens an impact review. No transaction is sent.</p>
            </article>
          );
        })}
      </div>
    </>
  );
}
