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
import { PrepareDialog } from './PrepareDialog';
import { RepayPicker } from './RepayPicker';
import { ProvenanceMark } from './primitives';
import { CheckedAndSkipped, SuggestionCard } from './SuggestionCard';
import {
  accountFacts,
  isHeld,
  topIndex,
  withKept,
  type CardStage,
  type Held,
} from '../lib/suggestions';

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
  // Kept per strategy instead of remounting on a switch, which would drop the focus off the strategy control (#288);
  // a run that ends after a switch lands under the strategy it started with.
  const [runs, setRuns] = useState<Partial<Record<StrategyId, AiRun>>>({});
  const [errors, setErrors] = useState<Partial<Record<StrategyId, string>>>({});
  const [live, setLive] = useState<Pipeline | null>(null);
  const ai = runs[strategy] ?? restore(saved);
  const error = errors[strategy] ?? null;
  const running = startedAt !== null;
  const signature = portfolioSignature(initial, holdings);
  const analysis = ai?.signature === signature ? ai.analysis : null;
  const portfolioChanged = ai !== null && analysis === null;
  const recommendations = analysis?.recommendations ?? initial;

  async function analyse() {
    const ranFor = strategy;
    setStartedAt(Date.now());
    setErrors((e) => ({ ...e, [ranFor]: undefined }));
    setLive(null);
    const r = await runAnalysis(account, ranFor, setLive, signature);
    if (r.ok)
      setRuns((all) => ({ ...all, [ranFor]: { analysis: r.analysis, signature, run: Date.now() } }));
    else setErrors((e) => ({ ...e, [ranFor]: r.error }));
    setLive(null);
    setStartedAt(null);
  }

  const [life, setLife] = useState<ReadonlyMap<string, Held<AccountRecommendation>>>(new Map());
  const stageOf = (id: string): CardStage => {
    const h = life.get(id);
    if (!h || (h.stage.kind === 'done' && !isHeld(h, recommendations))) return { kind: 'open' };
    return h.stage;
  };
  // A new signing takes a fresh snapshot; the stages after it keep that snapshot while the sheet is open.
  const track = (item: AccountRecommendation, index: number, stage: CardStage) =>
    setLife((m) => {
      const was = m.get(item.id);
      const keep = was?.sheet && stage.kind !== 'signing';
      return new Map(m).set(item.id, {
        item: keep ? was.item : item,
        index: keep ? was.index : index,
        stage,
        sheet: true,
      });
    });
  const closeSheet = (id: string) =>
    setLife((m) => {
      const was = m.get(id);
      return was ? new Map(m).set(id, { ...was, sheet: false }) : m;
    });
  const cards = withKept(recommendations, life);
  const top = topIndex(cards.map((r) => stageOf(r.id).kind));
  const open = cards.filter((r) => stageOf(r.id).kind !== 'done').length;

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
      {(cards.length > 0 || skipped.length > 0) && (
        <div className="block-head an-recs-head">
          <h2>What the agents suggest</h2>
          <span className="muted-note">
            {open === 0 ? 'none right now' : `${open} worth your attention, ranked by impact`}
          </span>
        </div>
      )}
      {cards.length > 0 && (
        <div
          className={`sg-list${running ? ' is-stale' : ''}`}
          key={`${strategy}:${ai?.run ?? 'rules'}`}
          aria-busy={running}
          inert={running}
        >
          {cards.map((r, i) => {
            const stage = stageOf(r.id);
            const request = recommendationToPrepare(r.intent, account);
            const logos = intentTokens(r.intent).map((t) => ({
              icon: icons[t] ?? null,
              symbol: holdings.find((h) => h.token === t)?.symbol ?? label(t, new Map()).symbol,
            }));
            const isTop = i === top;
            const actionProps = {
              label:
                stage.kind === 'failed' ? 'Review again' : r.intent ? actionLabel(r.intent) : '',
              signingEnabled,
              variant: isTop ? ('primary' as const) : ('secondary' as const),
              onStage: (next: CardStage) => track(r, i, next),
              onSheetClosed: () => closeSheet(r.id),
            };
            return (
              <SuggestionCard
                key={r.id}
                top={isTop}
                aiPick={analysis?.source === 'llm'}
                urgent={r.severity === 'warning'}
                agent={r.agent}
                logos={logos}
                title={r.title}
                facts={accountFacts(r.intent)}
                why={r.why}
                stage={stage}
                className={analysis ? 'rec-in' : undefined}
                style={order(i)}
                extra={r.carry && <p className="muted-note">{r.carry.text}</p>}
                tags={
                  <>
                    <ProvenanceMark kind="on_chain">On-chain balances</ProvenanceMark>
                    {r.carry && (
                      <ProvenanceMark
                        kind="estimate"
                        title={PROVENANCE_TIER_INFO[r.carry.provenance].describe}
                      >
                        {PROVENANCE_TIER_INFO[r.carry.provenance].label}
                      </ProvenanceMark>
                    )}
                  </>
                }
                actions={
                  r.intent &&
                  (r.intent.action === 'repay' || r.intent.action === 'repay_from_collateral') &&
                  r.intent.sizing ? (
                    <RepayPicker
                      intent={{ ...r.intent, action: r.intent.action }}
                      sizing={r.intent.sizing}
                      account={account}
                      {...actionProps}
                    />
                  ) : request && r.intent ? (
                    <PrepareDialog request={request} {...actionProps} />
                  ) : (
                    <span className="muted-note">
                      Advisory — no one-click action for this one yet.
                    </span>
                  )
                }
              />
            );
          })}
        </div>
      )}
      <CheckedAndSkipped items={skipped.map((reason) => ({ reason }))} />
    </>
  );
}

interface AiRun {
  analysis: Analysis;
  signature: string;
  run: number;
}

const restore = (saved: unknown): AiRun | null => {
  const restored = parseSaved(saved);
  return restored && { ...restored, run: 0 };
};

/** Items that arrive together come in one after another: presentation only, the data is already here. */
const order = (i: number) => ({ '--i': i }) as CSSProperties;
