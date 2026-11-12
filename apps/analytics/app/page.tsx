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
  NEAR: ['linear-gradient(135deg,#8e9f84,#6c7d62)', '#111411'],
  WNEAR: ['linear-gradient(135deg,#70846d,#53664e)', '#f1f3ed'],
  STNEAR: ['linear-gradient(135deg,#a2b196,#7a8a70)', '#111411'],
  USDC: ['linear-gradient(135deg,#8596a7,#627688)', '#ffffff'],
  'USDC.E': ['linear-gradient(135deg,#74869b,#53677d)', '#ffffff'],
  USDT: ['linear-gradient(135deg,#91a391,#6d816e)', '#111411'],
} as const;
const tokenVisual = (s: string): readonly [string, string] =>
  TOKEN_COLORS[s.toUpperCase()] ?? ['linear-gradient(135deg,#788575,#596653)', '#ffffff'];

/** A short "what kind of token" subtitle for the holdings table. */
const TOKEN_KIND: Record<string, string> = {
  NEAR: 'Native token',
  WNEAR: 'Wrapped NEAR',
  STNEAR: 'Liquid staking',
  USDC: 'Stablecoin',
  'USDC.E': 'Bridged stablecoin',
  USDT: 'Stablecoin',
};

/** Muted natural tones shared by the hero allocation bar and its legend. */
const ALLOC_COLORS = ['#81947a', '#c1ad91', '#75847b', '#b27769', '#596a56'] as const;
import Link from 'next/link';
import { PortfolioSwitch, portfolioOf } from '../components/PortfolioSwitch';
import { ErrorState } from '../components/states';
import { accountRecommendations, accountView, ago, money, portfolioView } from '../lib/product';
import { Recommendations } from '../components/Recommendations';
import { ActionRail } from '../components/ActionRail';
import { AccountWatcher } from '../components/AccountWatcher';
import { walletSigningEnabled } from '../lib/wallet-signing';
import { AccountForm } from '../components/AccountForm';
import { OwnershipCheck } from '../components/OwnershipCheck';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

const WHERE = {
  wallet: 'In the wallet',
  collateral: 'Deposited on Burrow (collateral)',
  deposited: 'Deposited on Burrow',
  borrowed: 'Borrowed from Burrow',
} as const;

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const isAccount = sp.p === 'account';
  // The account id can come from the URL (?account=) or, when navigating back to "Your account" without it, from the
  // cookie the wallet set on connect — otherwise the view would read empty until the wallet is reconnected.
  const urlAccount = typeof sp.account === 'string' ? sp.account.trim().toLowerCase() : '';
  const cookieAccount = (await cookies()).get('np_account')?.value?.trim().toLowerCase() ?? '';
  const accountParam = urlAccount || (isAccount ? cookieAccount : '');
  const accountMode = accountParam && accountParam === cookieAccount ? 'connected' : 'lookup';
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
            accountMode={accountMode}
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
      {isAccount && accountParam && <AccountWatcher account={accountParam} />}
      <header className="portfolio-intro">
        <div>
          <p className="portfolio-context">
            {isAccount
              ? accountMode === 'connected'
                ? 'Connected wallet'
                : 'Read-only mainnet lookup'
              : 'Explore the demo'}
          </p>
          <h1>{isAccount ? 'Your NEAR portfolio' : 'Portfolio'}</h1>
          <p className="portfolio-lead">
            {isAccount
              ? 'Your positions, liabilities and loan resilience. Review every action before signing.'
              : 'Your simulated positions, liabilities and loan resilience. No hidden balances.'}
          </p>
        </div>
        <span className="portfolio-mode">
          {isAccount
            ? accountMode === 'connected'
              ? 'Connected wallet'
              : 'Read-only account'
            : 'Simulated portfolio'}
        </span>
      </header>
      <div className="hero-head">
        <PortfolioSwitch
          current={isAccount ? 'account' : id}
          path="/"
          withAccount
          account={accountParam}
          accountMode={accountMode}
        />
        <span className="sync-note">
          <span className="dot" aria-hidden="true" />
          {isAccount
            ? `Mainnet · ${accountMode === 'connected' ? 'wallet connected' : 'read only'} · just now`
            : `Demo portfolio · updated ${ago(data.asOf)}`}
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
        <div className="hero-main summary-primary">
          <span className="eyebrow">
            Net worth · {isAccount ? 'Your account' : 'Demo portfolio'}
          </span>
          <div className="hero-top">
            <div className="hero-value num">{money(t.netWorthUsd, false)}</div>
            <span className={`hero-live ${isAccount ? 'is-live' : ''}`}>
              <span className="dot" aria-hidden="true" />
              {isAccount
                ? accountMode === 'connected'
                  ? 'Wallet linked'
                  : 'Read only'
                : 'Simulated'}
            </span>
          </div>
          <span className="muted-note">
            {money(t.assetsUsd, false)} in assets − {money(t.debtUsd, false)} borrowed
          </span>
        </div>
        <div className="hero-stat summary-stat">
          <span className="eyebrow">Monthly result now</span>
          <div className={`hero-num num ${(data.earnings.monthlyNetUsd ?? 0) < 0 ? 'neg' : 'pos'}`}>
            {data.earnings.monthlyNetUsd === null
              ? '—'
              : `${data.earnings.monthlyNetUsd >= 0 ? '+' : ''}${money(data.earnings.monthlyNetUsd, true)}`}
          </div>
          <span className="muted-note">{data.earnings.sentence}</span>
        </div>
        <div className="hero-stat summary-stat">
          <span className="eyebrow">Loan safety</span>
          <div className="hero-safe">
            <span className={`safe-chip health-${data.health.level}`}>
              <span className="dot" aria-hidden="true" />
              {data.health.label}
            </span>
          </div>
          <span className="muted-note">{data.health.sentence}</span>
        </div>
      </section>

      {isAccount && recs && (
        <OwnershipCheck account={accountParam} verified={recs.ownerVerified === true} />
      )}

      {isAccount && recs && (
        <section className="block">
          <Recommendations
            key={accountParam}
            account={accountParam}
            recommendations={recs.recommendations}
            signingEnabled={signingEnabled}
          />
        </section>
      )}

      {!isAccount && (
        <section className="block recommendation-block">
          <div className="block-head">
            <div>
              <span className="eyebrow">Decisions / Autopilot</span>
              <h2>What you could do with {money(t.idleUsd, false)}</h2>
            </div>
            <span className="muted-note">
              {data.actions.length} {data.actions.length === 1 ? 'option' : 'options'} · Updated{' '}
              {ago(data.asOf)}
            </span>
          </div>
          {data.actions.length === 0 ? (
            <p className="muted-note">
              {t.idleUsd < SMALL_IDLE_USD
                ? `${money(t.idleUsd, false)} is too small to put to work: network fees would cost more than it can earn. Doing nothing is the right call here.`
                : 'No option could be computed from the latest data.'}
            </p>
          ) : (
            <ActionRail actions={data.actions} />
          )}
        </section>
      )}

      <section className="block">
        <div className="block-head">
          <h2>Holdings and liabilities</h2>
          <span className="muted-note">
            {rows.length} {rows.length === 1 ? 'asset' : 'assets'} ·{' '}
            {isAccount ? 'read just now' : `updated ${ago(data.asOf)}`}
          </span>
        </div>
        {allocSegs.length > 0 && (
          <div className="holdings-allocation" aria-label="Asset allocation">
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
          </div>
        )}
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
