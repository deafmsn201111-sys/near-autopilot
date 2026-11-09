import { PUBLIC_DEMO } from '../lib/public-demo';
import { cookies } from 'next/headers';

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

/** Token coin chip: a deterministic gradient + readable foreground per known symbol, neutral otherwise. */
const TOKEN_COLORS: Record<string, readonly [string, string]> = {
  NEAR: ['linear-gradient(135deg,#00ec97,#00935f)', '#03140c'],
  WNEAR: ['linear-gradient(135deg,#00b876,#064e3b)', '#eafff6'],
  STNEAR: ['linear-gradient(135deg,#2bffb0,#00b57a)', '#03140c'],
  USDC: ['linear-gradient(135deg,#3b82f6,#1d5fd1)', '#ffffff'],
  'USDC.E': ['linear-gradient(135deg,#5b7fb8,#2d4a73)', '#ffffff'],
  USDT: ['linear-gradient(135deg,#26a17b,#13795b)', '#ffffff'],
} as const;
const tokenVisual = (s: string): readonly [string, string] =>
  TOKEN_COLORS[s.toUpperCase()] ?? ['linear-gradient(135deg,#6f857b,#334039)', '#ffffff'];

/** A short "what kind of token" subtitle for the holdings table. */
const TOKEN_KIND: Record<string, string> = {
  NEAR: 'Native token',
  WNEAR: 'Wrapped NEAR',
  STNEAR: 'Liquid staking',
  USDC: 'Stablecoin',
  'USDC.E': 'Bridged stablecoin',
  USDT: 'Stablecoin',
};

/** The allocation palette (mint-forward, then blue/amber/grey) shared by the hero bar and its legend. */
const ALLOC_COLORS = ['#00ec97', '#2bffb0', '#3b82f6', '#f5b544', '#7d8f88'] as const;
import Link from 'next/link';
import { ConfirmAction } from '../components/ConfirmAction';
import { PortfolioSwitch, portfolioOf } from '../components/PortfolioSwitch';
import { ErrorState } from '../components/states';
import {
  accountRecommendations,
  accountView,
  ago,
  money,
  portfolioView,
  type PortfolioAction,
} from '../lib/product';
import { Recommendations } from '../components/Recommendations';
import { walletSigningEnabled } from '../lib/wallet-signing';
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
  const isAccount = sp.p === 'account';
  // The account id can come from the URL (?account=) or, when navigating back to "Your account" without it, from the
  // cookie the wallet set on connect — otherwise the view would read empty until the wallet is reconnected.
  const urlAccount = typeof sp.account === 'string' ? sp.account.trim().toLowerCase() : '';
  const cookieAccount = (await cookies()).get('np_account')?.value?.trim().toLowerCase() ?? '';
  const accountParam = urlAccount || (isAccount ? cookieAccount : '');
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
          <PortfolioSwitch
            current={isAccount ? 'account' : id}
            path="/"
            withAccount
            account={accountParam}
          />
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
  const best = data.actions.find((a) => (a.netUsd ?? -1) > 0);

  // Holdings for the premium table (non-dust, highest value first) and the hero allocation bar (assets only,
  // aggregated by symbol). All derived from the real balances — nothing invented.
  const rows = data.holdings.filter((h) => !isDust(h)).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const assetRows = rows.filter((h) => h.where !== 'borrowed' && (h.usd ?? 0) > 0);
  const assetsTotal = assetRows.reduce((s, h) => s + (h.usd ?? 0), 0) || 1;
  const bySymbol = new Map<string, number>();
  for (const h of assetRows) bySymbol.set(h.symbol, (bySymbol.get(h.symbol) ?? 0) + (h.usd ?? 0));
  const alloc = [...bySymbol.entries()]
    .map(([symbol, usd]) => ({ symbol, pct: usd / assetsTotal }))
    .sort((a, b) => b.pct - a.pct);
  const allocTop = alloc.slice(0, 4);
  const allocOther = alloc.slice(4).reduce((s, a) => s + a.pct, 0);
  const allocSegs = [
    ...allocTop.map((a, i) => ({ label: a.symbol, pct: a.pct, color: ALLOC_COLORS[i] as string })),
    ...(allocOther > 0.0005
      ? [{ label: 'Other', pct: allocOther, color: ALLOC_COLORS[4] as string }]
      : []),
  ];
  // For a connected wallet (a real mainnet account), the agents' recommendations with one-click intents.
  const recs = isAccount ? (await accountRecommendations(accountParam)).data : null;
  const signingEnabled = isAccount ? walletSigningEnabled() : false;
  return (
    <>
      <div className="hero-head">
        <PortfolioSwitch
          current={isAccount ? 'account' : id}
          path="/"
          withAccount
          account={accountParam}
        />
        <span className="muted-note">
          {isAccount
            ? `${accountParam} on NEAR mainnet · read just now, nothing is signed or sent`
            : `Demo portfolio: simulated balances valued at live NEAR prices · updated ${ago(data.asOf)}`}
        </span>
      </div>

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
        <div className="hero-main">
          <span className="eyebrow">
            Net worth · {isAccount ? 'Your account' : 'Demo portfolio'}
          </span>
          <div className="hero-top">
            <div className="hero-value num">{money(t.netWorthUsd, false)}</div>
            <span className={`hero-live ${isAccount ? 'is-live' : ''}`}>
              <span className="dot" aria-hidden="true" />
              {isAccount ? 'Live' : 'Simulated'}
            </span>
          </div>
          <span className="muted-note">
            {money(t.assetsUsd, false)} in assets − {money(t.debtUsd, false)} borrowed
          </span>
          {allocSegs.length > 0 && (
            <>
              <div className="alloc-bar" aria-hidden="true">
                {allocSegs.map((s) => (
                  <i key={s.label} style={{ width: `${s.pct * 100}%`, background: s.color }} />
                ))}
              </div>
              <div className="alloc-legend">
                {allocSegs.map((s) => (
                  <span key={s.label}>
                    <span className="sw" style={{ background: s.color }} />
                    <b>{s.label}</b> {(s.pct * 100).toFixed(1)}%
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="hero-side">
          <div className="hero-stat">
            <span className="eyebrow">Monthly result now</span>
            <div
              className={`hero-num num ${(data.earnings.monthlyNetUsd ?? 0) < 0 ? 'neg' : 'pos'}`}
            >
              {data.earnings.monthlyNetUsd === null
                ? '—'
                : `${data.earnings.monthlyNetUsd >= 0 ? '+' : ''}${money(data.earnings.monthlyNetUsd, true)}`}
            </div>
            <span className="muted-note">{data.earnings.sentence}</span>
          </div>
          <div className="hero-stat">
            <span className="eyebrow">Loan safety</span>
            <div className="hero-safe">
              <span className={`safe-chip health-${data.health.level}`}>
                <span className="dot" aria-hidden="true" />
                {data.health.label}
              </span>
            </div>
            <span className="muted-note">{data.health.sentence}</span>
          </div>
        </div>
      </section>

      {isAccount && recs && recs.recommendations.length > 0 && (
        <section className="block">
          <div className="block-head">
            <div>
              <h2>What the agents suggest</h2>
              <p className="muted-note">
                Each is a concrete, one-click action. The site assembles the exact transaction
                cascade; you review it and sign in your own wallet. The server holds no key.
              </p>
            </div>
          </div>
          <Recommendations
            account={accountParam}
            recommendations={recs.recommendations}
            signingEnabled={signingEnabled}
          />
        </section>
      )}

      <section className="block">
        <div className="block-head">
          <h2>What you hold</h2>
          <span className="muted-note">
            {rows.length} {rows.length === 1 ? 'asset' : 'assets'} ·{' '}
            {isAccount ? 'read just now' : `updated ${ago(data.asOf)}`}
          </span>
        </div>
        <div className="holdings-table">
          <div className="ht-head">
            <span>Asset</span>
            <span>Balance</span>
            <span>Allocation</span>
            <span className="r">Value</span>
          </div>
          {rows.map((r) => {
            const [bg, fg] = tokenVisual(r.symbol);
            const isDebt = r.where === 'borrowed';
            const kind =
              r.where === 'wallet'
                ? (TOKEN_KIND[r.symbol.toUpperCase()] ?? 'Token')
                : WHERE[r.where];
            const pct = isDebt ? 0 : (r.usd ?? 0) / assetsTotal;
            return (
              <div className="ht-row" key={`${r.where}-${r.symbol}`}>
                <div className="ht-asset">
                  <span className="coin" style={{ background: bg, color: fg }}>
                    {r.symbol.slice(0, 1)}
                  </span>
                  <div>
                    <div className="nm">{r.symbol}</div>
                    <div className="sub">{kind}</div>
                  </div>
                </div>
                <div className="ht-qty num">{amountText(r.amount)}</div>
                <div className="ht-alloc">
                  {isDebt ? (
                    <span className="muted-note">Borrowed</span>
                  ) : (
                    <>
                      <span className="track">
                        <span className="fill" style={{ width: `${Math.min(100, pct * 100)}%` }} />
                      </span>
                      <span className="pc num">{(pct * 100).toFixed(1)}%</span>
                    </>
                  )}
                </div>
                <div className={`ht-val num r ${isDebt ? 'neg' : ''}`}>
                  {isDebt ? '−' : ''}
                  {money(r.usd, false)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="ht-foot">
          <span className="muted-note">
            {isAccount
              ? 'Balances read directly from the NEAR mainnet · non-custodial'
              : 'Simulated balances valued at live NEAR prices'}
          </span>
        </div>
      </section>

      {/* The connected wallet gets live, one-click recommendations above; this cost-ranked idle-cash analysis is
          shown for the illustrative demo portfolios. */}
      {!isAccount && (
        <section className="block">
          <div className="block-head">
            <div>
              <h2>What you could do with the idle {money(t.idleUsd, false)}</h2>
              <p className="muted-note">
                Best result first, after every cost: fees, swaps, gas, borrowing interest and
                impermanent loss.
              </p>
            </div>
            {!PUBLIC_DEMO && (
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
                <ActionCard key={a.id} a={a} best={a === best} />
              ))}
            </div>
          )}
        </section>
      )}

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
