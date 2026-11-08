import { PUBLIC_DEMO } from '../lib/public-demo';
import { cookies } from 'next/headers';
import { AgentAction } from '../components/AgentAction';

/** The policy's per-action limit (config maxActionUsd): a larger amount is blocked, so one step never asks for more. */
const MAX_ACTION_USD = 100;

/** Below this idle amount every option is eaten by network fees: the page says so instead of listing losses. */
const SMALL_IDLE_USD = 50;

/** Dust: worth under a cent (or, unpriced, under 0.005 tokens). Shown nowhere: it would read as "0 TOKEN". */
const isDust = (h: { amount: number; usd: number | null }) =>
  h.usd !== null ? h.usd < 0.01 : h.amount < 0.005;

/** Small amounts keep two significant digits (0.0042 BTC is not "0"); others two decimals. */
const amountText = (n: number) =>
  n > 0 && n < 0.01
    ? n.toLocaleString('en-US', { maximumSignificantDigits: 2 })
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
import { ModeSwitch, type Mode } from '../components/ModeSwitch';
import Link from 'next/link';
import { ConfirmAction } from '../components/ConfirmAction';
import { PortfolioSwitch, portfolioOf } from '../components/PortfolioSwitch';
import { ErrorState } from '../components/states';
import { accountView, ago, money, portfolioView, type PortfolioAction } from '../lib/product';
import { AccountForm } from '../components/AccountForm';
import { runAnalysis } from './autopilot/actions';
import { resetDemo } from './request-actions';

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

const AGENT_CAN = new Set(['repay', 'lend-usdt', 'lend-near']);

/** What the user can do with this action, given the operating mode and whose portfolio it is. */
function ActionControls({
  a,
  mode,
  portfolio,
}: {
  a: PortfolioAction;
  mode: Mode;
  portfolio: string | null;
}) {
  if (portfolio === null) {
    // a real mainnet account
    if (mode === 'demo')
      return (
        <span className="locked-note">
          Switch to a mainnet mode above to act on your own account.
        </span>
      );
    if (mode === 'auto')
      return (
        <span className="locked-note">
          🔒 Mainnet autopilot needs the guard contract that holds your limits on-chain (next
          stage).
        </span>
      );
    return (
      <>
        <button type="button" className="btn primary small" disabled>
          🔒 Sign with your wallet
        </button>
        <span className="locked-note">
          Mainnet signing is locked until the final security tests. Nothing can be sent from this
          site yet.
        </span>
      </>
    );
  }
  if (mode !== 'demo')
    return (
      <span className="locked-note">
        Demo portfolios run in Demo mode. Switch to Demo to let the agent act.
      </span>
    );
  if (!AGENT_CAN.has(a.id))
    return (
      <span className="locked-note">
        {a.kind === 'loop'
          ? 'The agent never borrows: loops are shown for comparison only.'
          : a.kind === 'liquidity'
            ? 'The agent cannot open liquidity positions yet: it only advises on them.'
            : 'The agent cannot do this one as a single step yet (swap, then deposit).'}
      </span>
    );
  return (
    <AgentAction
      portfolio={portfolio}
      actionId={a.id}
      title={a.title}
      defaultUsd={Math.min(a.capitalUsd, 50)}
      maxUsd={Math.min(a.capitalUsd, MAX_ACTION_USD)}
    />
  );
}

function ActionCard({
  a,
  best,
  mode,
  portfolio,
}: {
  a: PortfolioAction;
  best: boolean;
  mode: Mode;
  portfolio: string | null;
}) {
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
      <div className="action-buttons">
        <ActionControls a={a} mode={mode} portfolio={portfolio} />
      </div>
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
  const cookieMode = (await cookies()).get('autopilot-mode')?.value;
  const mode: Mode = cookieMode === 'confirm' || cookieMode === 'auto' ? cookieMode : 'demo';
  const isAccount = sp.p === 'account';
  const accountParam = typeof sp.account === 'string' ? sp.account.trim().toLowerCase() : '';
  const id = portfolioOf(sp.p);
  if (isAccount && !accountParam)
    return (
      <>
        <div className="hero-head">
          <PortfolioSwitch current="account" path="/" withAccount />
        </div>
        <AccountForm />
      </>
    );
  const { data, error } = isAccount ? await accountView(accountParam) : await portfolioView(id);
  if (!data)
    return (
      <>
        <div className="hero-head">
          <PortfolioSwitch current={isAccount ? 'account' : id} path="/" withAccount />
        </div>
        {isAccount && <AccountForm value={accountParam} />}
        <ErrorState
          what={isAccount ? `Account ${accountParam}` : 'Your portfolio'}
          error={error}
          hint={
            isAccount
              ? 'Check the account name (for example alice.near). Only NEAR mainnet accounts are read.'
              : undefined
          }
        />
      </>
    );
  const t = data.totals;
  const groups = (['wallet', 'collateral', 'deposited', 'borrowed'] as const)
    .map((w) => ({ w, rows: data.holdings.filter((h) => h.where === w && !isDust(h)) }))
    .filter((g) => g.rows.length > 0);
  const best = data.actions.find((a) => (a.netUsd ?? -1) > 0);
  return (
    <>
      <div className="hero-head">
        <PortfolioSwitch current={isAccount ? 'account' : id} path="/" withAccount />
        <ModeSwitch current={mode} />
        <span className="muted-note">
          {isAccount
            ? `${accountParam} on NEAR mainnet · read just now, nothing is signed or sent`
            : `Demo portfolio: simulated balances valued at live NEAR prices · updated ${ago(data.asOf)}`}
        </span>
      </div>

      {!isAccount && !PUBLIC_DEMO && (
        <div className="callout intro" role="note" style={{ marginBottom: 16 }}>
          <b>New here?</b> You&apos;re looking at a <b>simulated</b> portfolio priced with live NEAR
          mainnet data. Below, the agent finds what is worth doing and explains every option — it
          only <b>proposes</b>; nothing is ever signed or sent. To see your <b>own</b> portfolio
          (read-only), use <b>Your account</b> above or connect your wallet.
        </div>
      )}

      {!data.asOf && (
        <div className="callout" style={{ marginBottom: 16 }}>
          <b>The first analysis is still running.</b> On a fresh install the autopilot first reads
          every pool and market from NEAR mainnet; without an RPC key this takes a few minutes. This
          page fills in by itself.
        </div>
      )}
      {!isAccount && data.simulatedChanges && data.simulatedChanges.count > 0 && (
        <div className="callout demo-changes" style={{ marginBottom: 16 }}>
          <span>
            <b>Changed by the agent (simulated).</b>{' '}
            {data.simulatedChanges.count === 1
              ? 'One action has run as a dry run on this demo portfolio'
              : `${data.simulatedChanges.count} actions have run as dry runs on this demo portfolio`}
            {data.simulatedChanges.since ? ` (the first ${ago(data.simulatedChanges.since)})` : ''}.
            The amounts below include them; nothing was sent.
          </span>
          <ConfirmAction
            label="Reset demo"
            title="Reset this demo portfolio?"
            description="Its balances go back to the starting amounts. The actions stay in Activity and in the audit trail."
            confirmLabel="Reset"
            action={async () => {
              'use server';
              return resetDemo(id);
            }}
          />
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
                  {amountText(r.amount)} {r.symbol}
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
          {!isAccount && !PUBLIC_DEMO && (
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
          )}
        </div>
        {data.actions.length === 0 ? (
          <p className="muted-note">
            {t.idleUsd < SMALL_IDLE_USD
              ? `${money(t.idleUsd, false)} is too small to put to work: the network fees of any move would cost more than it can earn in a month. Doing nothing is the right call here.`
              : 'No option could be computed from the latest data.'}
          </p>
        ) : (
          <div className="actions-list">
            {data.actions.map((a) => (
              <ActionCard
                key={a.id}
                a={a}
                best={a === best}
                mode={mode}
                portfolio={isAccount ? null : id}
              />
            ))}
          </div>
        )}
      </section>

      {!isAccount && data.lastDecision && (
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
