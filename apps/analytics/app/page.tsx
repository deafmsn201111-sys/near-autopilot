import Link from 'next/link';
import { ConfirmAction } from '../components/ConfirmAction';
import { PortfolioSwitch, portfolioOf } from '../components/PortfolioSwitch';
import { ErrorState } from '../components/states';
import { ago, money, portfolioView, type PortfolioAction } from '../lib/product';
import { runAnalysis } from './autopilot/actions';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

const WHERE = {
  wallet: 'In the wallet',
  collateral: 'Deposited on Burrow (collateral)',
  deposited: 'Deposited on Burrow',
  borrowed: 'Borrowed from Burrow',
} as const;

const VERDICT = {
  worth_it: { cls: 'good', icon: '✓' },
  not_worth_it: { cls: 'warning', icon: '–' },
  not_allowed: { cls: 'neutral', icon: 'i' },
  no_data: { cls: 'neutral', icon: '?' },
} as const;

function ActionCard({ a, best }: { a: PortfolioAction; best: boolean }) {
  const v = VERDICT[a.autopilot.verdict];
  const net = a.netUsd;
  return (
    <article className={`action${best ? ' best' : ''}`}>
      <div className="action-main">
        <div>
          {best && <span className="tag">Best result after costs</span>}
          <h3>{a.title}</h3>
          <p>{a.summary}</p>
        </div>
        <div className="action-result-num">
          <span className={`big ${net !== null && net < 0 ? 'neg' : 'pos'}`}>
            {net === null ? '—' : `${net >= 0 ? '+' : ''}${money(net, true)}`}
          </span>
          <span className="small">
            per {a.horizonDays} days after costs
            {a.netAprOnCapital !== null && ` · ${(a.netAprOnCapital * 100).toFixed(1)}% a year`}
          </span>
        </div>
      </div>
      <p className={`verdict ${v.cls}`}>
        <i aria-hidden="true">{v.icon}</i>
        {a.autopilot.sentence}
      </p>
      <details className="plan">
        <summary>See the plan, the costs and the risks</summary>
        <div className="plan-grid">
          <div>
            <h4>What would happen</h4>
            <ol>
              {a.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
          <div>
            <h4>
              The numbers, {a.horizonDays} days on {money(a.capitalUsd)}
            </h4>
            <table className="mini">
              <tbody>
                <tr>
                  <td>Earned</td>
                  <td className="num">{money(a.grossUsd, true)}</td>
                </tr>
                {a.costs.map((c) => (
                  <tr key={c.label}>
                    <td>{c.label}</td>
                    <td className="num">−{money(c.usd, true)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>You keep</td>
                  <td className="num">{money(a.netUsd, true)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <h4>Risks</h4>
            <ul>
              {a.risks.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="fine">{a.basis}</p>
      </details>
    </article>
  );
}

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const id = portfolioOf(sp.p);
  const { data, error } = await portfolioView(id);
  if (!data) return <ErrorState what="Your portfolio" error={error} />;
  const t = data.totals;
  const groups = (['wallet', 'collateral', 'deposited', 'borrowed'] as const)
    .map((w) => ({ w, rows: data.holdings.filter((h) => h.where === w) }))
    .filter((g) => g.rows.length > 0);
  const best = data.actions.find((a) => (a.netUsd ?? -1) > 0);
  return (
    <>
      <div className="hero-head">
        <PortfolioSwitch current={id} path="/" />
        <span className="muted-note">
          Demo portfolio: simulated balances valued at live NEAR prices · updated {ago(data.asOf)}
        </span>
      </div>

      {!data.asOf && (
        <div className="callout" style={{ marginBottom: 16 }}>
          <b>The first analysis is still running.</b> On a fresh install the autopilot first reads
          every pool and market from NEAR mainnet; without an RPC key this takes a few minutes. This
          page fills in by itself.
        </div>
      )}
      <section className="hero">
        <div>
          <span className="eyebrow">Net worth</span>
          <div className="hero-value">{money(t.netWorthUsd, false)}</div>
          <span className="muted-note">
            {money(t.assetsUsd, false)} in assets − {money(t.debtUsd, false)} borrowed
          </span>
        </div>
        <div className="hero-stat">
          <span className="eyebrow">Monthly result now</span>
          <div className={`hero-num ${(data.earnings.monthlyNetUsd ?? 0) < 0 ? 'neg' : 'pos'}`}>
            {data.earnings.monthlyNetUsd === null
              ? '—'
              : `${data.earnings.monthlyNetUsd >= 0 ? '+' : ''}${money(data.earnings.monthlyNetUsd, true)}`}
          </div>
          <span className="muted-note">{data.earnings.sentence}</span>
        </div>
        <div className="hero-stat">
          <span className="eyebrow">Loan safety</span>
          <div className={`hero-num health-${data.health.level}`}>{data.health.label}</div>
          <span className="muted-note">{data.health.sentence}</span>
        </div>
      </section>

      <section className="block">
        <h2>What you hold</h2>
        <div className="holdings">
          {groups.map((g) => (
            <div className={`holding ${g.w}`} key={g.w}>
              <span className="eyebrow">{WHERE[g.w]}</span>
              <b>
                {money(
                  g.rows.reduce((s, r) => s + (r.usd ?? 0), 0),
                  false,
                )}
              </b>
              {g.rows.map((r) => (
                <span key={r.symbol} className="muted-note">
                  {r.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} {r.symbol}
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="block">
        <div className="block-head">
          <div>
            <h2>What you could do with the idle {money(t.idleUsd, false)}</h2>
            <p className="muted-note">
              Best result first, after every cost: fees, swaps, gas, borrowing interest and
              impermanent loss.
            </p>
          </div>
          <ConfirmAction
            label="Refresh with live data"
            title="Run a fresh analysis?"
            description="The autopilot reads the latest prices, pools and lending rates from NEAR mainnet and recomputes every option. It takes about a minute. Nothing is bought, sold or sent."
            confirmLabel="Run analysis"
            action={async () => {
              'use server';
              return runAnalysis();
            }}
          />
        </div>
        {data.actions.length === 0 ? (
          <p className="muted-note">No option could be computed from the latest data.</p>
        ) : (
          <div className="actions-list">
            {data.actions.map((a) => (
              <ActionCard key={a.id} a={a} best={a === best} />
            ))}
          </div>
        )}
      </section>

      {data.lastDecision && (
        <section className="block">
          <div className="block-head">
            <h2>What the autopilot decided</h2>
            <Link href={`/activity?p=${id}`} className="link">
              Every decision and why →
            </Link>
          </div>
          <div className="decision">
            <b>{data.lastDecision.headline}</b>
            <span className="muted-note"> · {ago(data.asOf)}</span>
            <ul>
              {data.lastDecision.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}
