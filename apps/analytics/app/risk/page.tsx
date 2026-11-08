import { ErrorState } from '../../components/states';
import { tryApi } from '../../lib/api';
import { ProvenanceNote } from '../../components/ProvenanceNote';

export const dynamic = 'force-dynamic';

interface Stress {
  scenario: string;
  status: string;
  healthFactor: number | null;
}
interface Latest {
  at: string | null;
  level: string | null;
  healthFactor: number | null;
  ltvBps: number | null;
  collateralUsd: number | null;
  debtUsd: number | null;
  stress: Stress[];
  collateralDropToLiquidation: number | null;
}
interface Portfolio {
  portfolioId: string;
  description: string | null;
  latest: Latest | null;
}
interface RiskData {
  label: string;
  bands: { watch: number; danger: number; critical: number; target: number; liquidation: number };
  portfolios: Portfolio[];
}

const PORTFOLIO_LABEL: Record<string, string> = {
  'demo-5000': '$5,000 demo',
  'demo-500': '$500 demo',
};
/** Risk level → a tone class the stylesheet already colours (good / warning / critical). */
const LEVEL_TONE: Record<string, string> = {
  healthy: 'good',
  watch: 'warning',
  danger: 'critical',
  critical: 'critical',
};
const money = (v: number | null) =>
  v === null ? '—' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);
const STRESS_TONE: Record<string, string> = {
  safe: 'lvl-good',
  ok: 'lvl-good',
  liquidatable: 'lvl-critical',
};

/**
 * Risk Center: the safety picture of the (simulated) portfolios in plain language — how close each loan is to
 * liquidation, what a market shock would do, and the controls that keep the user in charge. Read-only; the Guard
 * contract that would enforce limits on-chain is roadmap, and nothing is ever signed or sent here.
 */
export default async function RiskPage() {
  const { data, error } = await tryApi<RiskData>('/v1/analytics/risk');
  if (!data) return <ErrorState what="The risk view" error={error} />;

  return (
    <>
      <div className="hero-head">
        <h1>Risk Center</h1>
        <span className="muted-note">{data.label}</span>
      </div>

      <section className="block">
        <h2>Loan safety</h2>
        <div className="agent-grid">
          {data.portfolios.map((p) => {
            const l = p.latest;
            const tone = l?.level ? (LEVEL_TONE[l.level] ?? 'neutral') : 'neutral';
            return (
              <article className="agent-card" key={p.portfolioId}>
                <div className="agent-card-head">
                  <h3>{PORTFOLIO_LABEL[p.portfolioId] ?? p.portfolioId}</h3>
                  {l?.level && <span className={`tag ${tone}`}>{l.level}</span>}
                </div>
                {!l || l.healthFactor === null ? (
                  <p className="muted-note">No loan: nothing to liquidate.</p>
                ) : (
                  <>
                    <div className="risk-metrics">
                      <div>
                        <span className="eyebrow">Health factor</span>
                        <b className={`lvl-${tone}`}>{l.healthFactor.toFixed(2)}</b>
                        <span className="muted-note">liquidation at 1.00</span>
                      </div>
                      <div>
                        <span className="eyebrow">Buffer to liquidation</span>
                        <b>{pct(l.collateralDropToLiquidation)}</b>
                        <span className="muted-note">uniform collateral drop</span>
                      </div>
                      <div>
                        <span className="eyebrow">Borrowed / collateral</span>
                        <b>
                          {money(l.debtUsd)} / {money(l.collateralUsd)}
                        </b>
                        <span className="muted-note">
                          LTV {l.ltvBps === null ? '—' : `${(l.ltvBps / 100).toFixed(0)}%`}
                        </span>
                      </div>
                    </div>
                    {l.stress.length > 0 && (
                      <div className="agent-latest">
                        <span className="eyebrow">If the market moves</span>
                        {l.stress.map((s) => (
                          <p className="muted-note" key={s.scenario}>
                            <span className={STRESS_TONE[s.status] ?? ''}>
                              {s.scenario}: {s.status}
                            </span>
                            {s.healthFactor !== null ? ` (HF ${s.healthFactor.toFixed(2)})` : ''}
                          </p>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="block">
        <h2>Controls that keep you in charge</h2>
        <ol className="flow">
          <li>
            <b>Every action is checked by the safety policy.</b> Twelve independent rules —
            allowlisted contracts and tokens, per-action and daily limits, slippage, oracle
            freshness, intent match. Anything that fails is blocked.
          </li>
          <li>
            <b>Nothing is signed or sent.</b> The system has no signer; it observes real mainnet
            data and proposes, as a dry run. Only your own wallet can ever sign.
          </li>
          <li>
            <b>On-chain Guard — roadmap.</b> Enforcing per-transaction limits, daily budgets and an
            Emergency Stop <i>on-chain</i> needs a dedicated Guard contract. It is designed (see the
            security docs) but not deployed, and autonomous execution stays off until it exists and
            is independently reviewed.
          </li>
        </ol>
      </section>
      <ProvenanceNote />
    </>
  );
}
