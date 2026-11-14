import { cookies } from 'next/headers';
import Link from 'next/link';

/** Below this idle amount every option is eaten by network fees: the page says so instead of listing losses. */
const SMALL_IDLE_USD = 50;

import { PortfolioSwitch, portfolioOf } from '../components/PortfolioSwitch';
import { ErrorState } from '../components/states';
import {
  accountRecommendations,
  accountView,
  ago,
  money,
  portfolioView,
  savedAnalysis,
  type PortfolioAction,
} from '../lib/product';
import { Recommendations } from '../components/Recommendations';
import { intentTokens } from '../lib/recommendation-intent';
import { AccountWatcher } from '../components/AccountWatcher';
import { walletSigningEnabled } from '../lib/wallet-signing';
import { portfolioMode } from '../lib/portfolio-mode';
import { AccountForm } from '../components/AccountForm';
import { DepositButton } from '../components/DepositDialog';
import { WithdrawDialog } from '../components/WithdrawDialog';
import { curatedId, tokenIcons } from '../lib/tokens';
import { OwnershipCheck } from '../components/OwnershipCheck';
import { StrategyPicker } from '../components/StrategyPicker';
import { PortfolioSummary } from '../components/PortfolioSummary';
import { HoldingsPanel } from '../components/Holdings';
import {
  savedStrategy,
  STRATEGY_COOKIE,
  STRATEGY_IDS,
  strategyOf,
} from '@near-autopilot/core/strategy';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

const allocBySymbol = (
  assets: readonly { symbol: string; usd: number | null }[],
  total: number,
) => {
  const bySymbol = new Map<string, number>();
  for (const h of assets) bySymbol.set(h.symbol, (bySymbol.get(h.symbol) ?? 0) + (h.usd ?? 0));
  return [...bySymbol.entries()]
    .map(([symbol, usd]) => ({ symbol, pct: usd / total }))
    .sort((a, b) => b.pct - a.pct);
};

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
          {best && <span className="tag">Highest net after costs</span>}
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
  // The account id can come from the URL (?account=) or, when navigating back to "Mainnet account" without it, from the
  // cookie the wallet set on connect — otherwise the view would read empty until the wallet is reconnected.
  const urlAccount = typeof sp.account === 'string' ? sp.account.trim().toLowerCase() : '';
  const cookieAccount = (await cookies()).get('np_account')?.value?.trim().toLowerCase() ?? '';
  const accountParam = urlAccount || (isAccount ? cookieAccount : '');
  // The URL wins (a shared link shows its strategy), then the last choice for this account in this browser.
  const strategy = strategyOf(
    STRATEGY_IDS.find((s) => s === sp.strategy) ??
      savedStrategy((await cookies()).get(STRATEGY_COOKIE)?.value, accountParam),
  );
  const id = portfolioOf(sp.p);
  if (isAccount && !accountParam)
    return (
      <>
        <div className="hero-head">
          <PortfolioSwitch current="account" path="/" withAccount account={cookieAccount} />
        </div>
        <AccountForm />
      </>
    );
  const { data, error } = isAccount
    ? await accountView(accountParam, strategy)
    : await portfolioView(id);
  if (!data)
    return (
      <>
        <div className="hero-head">
          <PortfolioSwitch
            current={isAccount ? 'account' : id}
            path="/"
            withAccount
            account={cookieAccount || accountParam}
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

  // Holdings for the premium table (highest value first) and the hero allocation bar. A real account's bar, totals and
  // LP rows come from the API's one list of priced legs; a demo's bar is aggregated here by symbol.
  // For a connected wallet (a real mainnet account), the agents' recommendations with one-click intents.
  // The API serves a saved analysis to the proven owner only, so it is asked in parallel and checked on its side.
  const [recsRead, saved] = isAccount
    ? await Promise.all([
        accountRecommendations(accountParam, strategy),
        savedAnalysis(accountParam, strategy),
      ])
    : [null, null];
  const recs = recsRead?.data ?? null;
  const tokenOf = (h: { token?: string; symbol: string }) => h.token ?? curatedId(h.symbol);
  const icons = await tokenIcons([
    ...data.holdings.flatMap((h) => tokenOf(h) ?? []),
    ...(data.positions ?? []).flatMap((r) => (r.tokens ?? []).map((t) => t.token)),
    ...(recs?.recommendations ?? []).flatMap((r) => intentTokens(r.intent)),
    ...(data.metrics?.byToken ?? []).map((b) => b.token),
  ]);
  // An unverified token may copy a real logo, so it keeps the letter placeholder.
  const logo = (token: string | undefined, symbol: string, verified = true) => ({
    icon: token && verified ? (icons[token] ?? null) : null,
    symbol,
  });
  const assetsTotal = t.assetsUsd || 1;
  const unverified = new Set([
    ...data.holdings.flatMap((h) => (h.verified === false && h.token ? [h.token] : [])),
    ...(data.positions ?? []).flatMap((r) =>
      r.verified === false ? (r.tokens ?? []).map((t) => t.token) : [],
    ),
  ]);
  const alloc = data.metrics
    ? data.metrics.byToken.map((b) => {
        const verified = !unverified.has(b.token);
        return {
          key: b.token,
          symbol: b.symbol,
          pct: b.pct / 100,
          verified,
          icon: verified ? (icons[b.token] ?? null) : null,
        };
      })
    : allocBySymbol(
        data.holdings.filter((h) => h.where !== 'borrowed' && (h.usd ?? 0) > 0),
        assetsTotal,
      ).map((a) => {
        const token = curatedId(a.symbol);
        return { ...a, key: a.symbol, verified: true, icon: token ? (icons[token] ?? null) : null };
      });
  const signingEnabled = isAccount ? walletSigningEnabled() : false;
  const own = isAccount && !!accountParam && accountParam === cookieAccount;
  const mode = portfolioMode({
    isAccount,
    account: accountParam,
    connected: cookieAccount,
    verified: recs && !recs.ownerCheckFailed ? recs.ownerVerified === true : null,
    signingEnabled,
  });
  return (
    <>
      {isAccount && accountParam && <AccountWatcher account={accountParam} />}
      <div className="hero-head">
        <PortfolioSwitch
          current={isAccount ? 'account' : id}
          path="/"
          withAccount
          account={cookieAccount || accountParam}
        />
      </div>

      {isAccount && <AccountForm compact />}

      {isAccount && (
        <StrategyPicker account={accountParam} current={strategy} note={data.strategyNote} />
      )}

      {!data.asOf && (
        <div className="callout" style={{ marginBottom: 16 }}>
          <b>The first analysis is still running.</b> On a fresh install the autopilot first reads
          every pool and market from NEAR mainnet; without an RPC key this takes a few minutes. This
          page fills in by itself.
        </div>
      )}
      <div className="hero-mode">
        <span className={`hero-live ${mode.mine ? 'is-live' : ''}`}>
          <span className="dot" aria-hidden="true" />
          {mode.label}
        </span>
        <span className="muted-note">{mode.note}</span>
        {mode.backTo && (
          <Link
            className="btn secondary small"
            href={`/?p=account&account=${encodeURIComponent(mode.backTo)}`}
          >
            ← Back to my wallet
          </Link>
        )}
      </div>
      <PortfolioSummary
        key={`summary:${isAccount ? accountParam : id}`}
        netWorthUsd={t.netWorthUsd}
        assetsUsd={t.assetsUsd}
        debtUsd={t.debtUsd}
        source={{
          kind: isAccount ? 'on_chain' : 'simulated',
          age: isAccount ? 'just now' : ago(data.asOf),
        }}
        alloc={alloc}
        monthly={{ usd: data.earnings.monthlyNetUsd, sentence: data.earnings.sentence }}
        health={data.health}
        loanBy={isAccount ? 'your collateral' : 'NEAR'}
        actions={
          own && (
            <>
              <DepositButton account={accountParam} label="Add funds" />
              <WithdrawDialog
                account={accountParam}
                balances={data.holdings.flatMap((h) =>
                  h.where === 'wallet' && h.token ? [{ token: h.token, amount: h.amount }] : [],
                )}
                signingEnabled={signingEnabled}
              />
            </>
          )
        }
      />

      {isAccount && recs && (
        <OwnershipCheck
          key={accountParam}
          account={accountParam}
          verified={recs.ownerVerified === true}
          checkFailed={recs.ownerCheckFailed === true}
        />
      )}

      {isAccount && recs && (
        <section className="block">
          <Recommendations
            key={`${accountParam}:${strategy}`}
            account={accountParam}
            strategy={strategy}
            recommendations={recs.recommendations}
            skipped={recs.skipped ?? []}
            holdings={data.holdings}
            saved={saved}
            icons={icons}
            signingEnabled={signingEnabled}
          />
        </section>
      )}

      <HoldingsPanel
        holdings={data.holdings.map((h) => ({
          ...h,
          logos: [logo(tokenOf(h), h.symbol, h.verified !== false)],
        }))}
        positions={(data.positions ?? []).map((r) => ({
          ...r,
          logos: r.tokens?.length
            ? r.tokens.map((x) => logo(x.token, x.symbol, r.verified !== false))
            : [logo(undefined, r.label)],
        }))}
        provenance={
          isAccount
            ? { kind: 'on_chain', age: 'just now' }
            : { kind: 'simulated', age: ago(data.asOf) }
        }
        source={
          isAccount
            ? 'Non-custodial · balances read directly from the chain'
            : 'Simulated balances valued at live NEAR prices'
        }
        flashScope={isAccount ? accountParam : undefined}
      >
        {isAccount && data.discovery?.complete === false && (
          <div className="callout warn hold-callout">
            A token or pool indexer did not answer, so only the tokens and pools on our list are
            shown. Reload in a minute to read the whole account.
          </div>
        )}
      </HoldingsPanel>

      {/* The connected wallet gets live, one-click recommendations above; this cost-ranked idle-cash analysis is
          shown for the illustrative demo portfolios. */}
      {!isAccount && (
        <section className="block">
          <div className="block-head">
            <h2>What you could do with the idle {money(t.idleUsd, false)}</h2>
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
    </>
  );
}
