import { cookies } from 'next/headers';
import { Suspense } from 'react';
import Loading from './loading';

/** Below this idle amount every option is eaten by network fees: the page says so instead of listing losses. */
const SMALL_IDLE_USD = 50;

import { portfolioOf } from '../components/PortfolioSwitch';
import { ContextStrip, SwitchView } from '../components/ContextStrip';
import { Intro } from '../components/Intro';
import { ErrorState, StaleNotice } from '../components/states';
import { plainReadError, staleNotices } from '../lib/plain-error';
import { freshness } from '../lib/series';
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
import { CheckedAndSkipped, NothingToDo, SuggestionCard } from '../components/SuggestionCard';
import { ProvenanceMark } from '../components/primitives';
import { demoFacts, splitDemo } from '../lib/suggestions';
import { intentTokens } from '../lib/recommendation-intent';
import { AccountWatcher } from '../components/AccountWatcher';
import { walletSigningEnabled } from '../lib/wallet-signing';
import { portfolioMode } from '../lib/portfolio-mode';
import { AccountForm } from '../components/AccountForm';
import { DepositButton } from '../components/DepositButton';
import { WithdrawDialog } from '../components/WithdrawDialog';
import { curatedId, tokenIcons } from '../lib/tokens';
import { OwnershipCheck } from '../components/OwnershipCheck';
import { signBlocked } from '../lib/sign-review';
import { StrategyPicker } from '../components/StrategyPicker';
import { LiveHoldings, LiveSummary } from '../components/OtherChains';
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

const DEMO_AGENT: Record<PortfolioAction['kind'], string> = {
  keep: 'Liquidation Guardian',
  lend: 'Capital Allocator',
  liquidity: 'Capital Allocator',
  loop: 'Capital Allocator',
};

function DemoPlan({ a }: { a: PortfolioAction }) {
  return (
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
      <p className="fine">
        {a.autopilot.sentence} {a.basis}
      </p>
    </details>
  );
}

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  // A fresh boundary per URL: under app/loading.tsx alone, a production build never commits a soft navigation to this
  // page with other search params (demo switch, another account) and keeps the old one on screen (#263). A strategy
  // switch keeps the boundary, so the focused strategy radio and the scroll position survive it (#288).
  const { strategy: _, ...view } = sp;
  return (
    <Suspense key={JSON.stringify(view)} fallback={<Loading />}>
      <Portfolio sp={sp} />
    </Suspense>
  );
}

async function Portfolio({ sp }: { sp: Search }) {
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
  const current = isAccount ? 'account' : id;
  if (isAccount && !accountParam)
    return (
      <>
        <div className="ctx">
          <SwitchView current="account" connected="" />
        </div>
        <Intro />
        <AccountForm />
      </>
    );
  const [read, prices] = await Promise.all([
    isAccount ? accountView(accountParam, strategy) : portfolioView(id),
    freshness(),
  ]);
  const { data, error, status } = read;
  if (!data) {
    const plain = plainReadError(status, error);
    return (
      <>
        <ContextStrip
          mode={portfolioMode({
            isAccount,
            account: accountParam,
            connected: cookieAccount,
            verified: null,
            signingEnabled: isAccount && walletSigningEnabled(),
          })}
          account={accountParam}
          current={current}
          connected={cookieAccount}
        />
        {isAccount && <AccountForm value={accountParam} />}
        <ErrorState
          what={isAccount ? `Account ${accountParam}` : 'Your portfolio'}
          error={null}
          hint={
            plain.blamesInput && isAccount
              ? `${plain.text} Check the account name (for example alice.near). Only NEAR mainnet accounts are read.`
              : plain.text
          }
        />
      </>
    );
  }
  const notices = staleNotices({
    read: { stale: read.stale, asOf: data.asOf, status, error },
    prices: prices.data,
    now: prices.data?.now ?? new Date().toISOString(),
  });
  const age = ago(data.asOf);
  const t = data.totals;
  const demo = splitDemo(data.actions);

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
  // The API's allocation counts verified tokens only (D44).
  const alloc = data.metrics
    ? data.metrics.byToken.map((b) => ({
        key: b.token,
        symbol: b.symbol,
        pct: b.pct / 100,
        verified: true,
        icon: icons[b.token] ?? null,
      }))
    : allocBySymbol(
        data.holdings.filter((h) => h.where !== 'borrowed' && (h.usd ?? 0) > 0),
        assetsTotal,
      ).map((a) => {
        const token = curatedId(a.symbol);
        return { ...a, key: a.symbol, verified: true, icon: token ? (icons[token] ?? null) : null };
      });
  const serverSigning = isAccount && walletSigningEnabled();
  // An old read is for looking only: actions are built from a fresh one.
  const stale = read.stale || recsRead?.stale === true;
  const signingEnabled = serverSigning && !stale;
  const mode = portfolioMode({
    isAccount,
    account: accountParam,
    connected: cookieAccount,
    verified: recs && !recs.ownerCheckFailed ? recs.ownerVerified === true : null,
    signingEnabled: serverSigning,
    stale,
  });
  // Other-chain balances belong to whoever is connected here: shown on their own portfolio only.
  const mine = isAccount && accountParam && accountParam === cookieAccount ? accountParam : null;
  return (
    <>
      {isAccount && accountParam && <AccountWatcher account={accountParam} />}
      {mode.kind === 'mine' && <h1 className="sr-only">Portfolio of {accountParam}</h1>}
      <ContextStrip
        key={`${current}:${accountParam}`}
        mode={mode}
        account={accountParam}
        current={current}
        connected={cookieAccount}
      />
      {mode.kind !== 'mine' && <Intro />}
      {notices.map((n) => (
        <StaleNotice key={n.title} title={n.title} detail={n.detail} />
      ))}

      {!data.asOf && (
        <div className="callout" style={{ marginBottom: 16 }}>
          <b>The first analysis is still running.</b> On a fresh install the autopilot first reads
          every pool and market from NEAR mainnet; without an RPC key this takes a few minutes. This
          page fills in by itself.
        </div>
      )}
      <LiveSummary
        account={mine}
        key={`summary:${isAccount ? accountParam : id}`}
        netWorthUsd={t.netWorthUsd}
        assetsUsd={t.assetsUsd}
        debtUsd={t.debtUsd}
        source={{
          kind: isAccount ? 'on_chain' : 'simulated',
          age,
        }}
        alloc={alloc}
        monthly={{ usd: data.earnings.monthlyNetUsd, sentence: data.earnings.sentence }}
        health={data.health}
        loanBy={isAccount ? 'your collateral' : 'NEAR'}
        actions={
          isAccount &&
          accountParam &&
          accountParam === cookieAccount &&
          !stale && (
            <>
              <DepositButton account={accountParam} />
              <WithdrawDialog
                label="Withdraw"
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

      {isAccount && !recs && (
        <StrategyPicker account={accountParam} current={strategy} note={data.strategyNote} />
      )}

      {isAccount && recs && (
        <section className="block">
          <Recommendations
            key={accountParam}
            account={accountParam}
            strategy={strategy}
            recommendations={recs.recommendations}
            skipped={recs.skipped ?? []}
            holdings={data.holdings}
            saved={saved}
            icons={icons}
            signingEnabled={signingEnabled}
            strategyNote={data.strategyNote}
            aiAllowed={recs.ownerVerified === true || recs.ownerCheckFailed === true}
            hasLoan={data.holdings.some((h) => h.where === 'borrowed')}
            loanValued={data.health.healthFactor !== null}
            hasLp={(data.positions ?? []).some((p) => p.key.startsWith('dcl-'))}
            signBlock={signBlocked({
              account: accountParam,
              connected: cookieAccount,
              signingEnabled,
            })}
          />
        </section>
      )}

      <LiveHoldings
        account={mine}
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
        provenance={{ kind: isAccount ? 'on_chain' : 'simulated', age }}
        source={
          isAccount
            ? 'Non-custodial · balances read directly from the chain'
            : 'Simulated balances valued at live NEAR prices'
        }
        unverifiedUsd={t.unverifiedUsd}
        emptyAction={
          isAccount &&
          accountParam &&
          accountParam === cookieAccount &&
          !stale && (
            <DepositButton account={accountParam} className="ds-btn ds-btn-primary ds-btn-sm" />
          )
        }
      >
        {isAccount && data.discovery?.complete === false && (
          <div className="callout warn hold-callout">
            A token or pool indexer did not answer, so only the tokens and pools on our list are
            shown. Reload in a minute to read the whole account.
          </div>
        )}
      </LiveHoldings>

      {/* The connected wallet gets live, one-click recommendations above; this cost-ranked idle-cash analysis is
          shown for the illustrative demo portfolios. */}
      {!isAccount && (
        <section className="block">
          <div className="block-head">
            <h2>What you could do with the idle {money(t.idleUsd, false)}</h2>
            <span className="muted-note">
              {demo.cards.length === 0
                ? 'none right now'
                : `${demo.cards.length} worth doing, ranked by what you keep`}
            </span>
          </div>
          {demo.cards.length === 0 && (
            <NothingToDo
              why={
                t.idleUsd < SMALL_IDLE_USD
                  ? `${money(t.idleUsd, false)} is too small to put to work: the network fees of any move would cost more than it can earn in a month.`
                  : data.actions.length === 0
                    ? 'No option could be computed from the latest data.'
                    : 'None of the options clears its costs at current rates.'
              }
            />
          )}
          {demo.cards.length > 0 && (
            <div className="sg-list">
              {demo.cards.map((a, i) => (
                <SuggestionCard
                  key={a.id}
                  top={i === 0}
                  agent={DEMO_AGENT[a.kind]}
                  logos={[]}
                  title={a.title}
                  facts={demoFacts(a)}
                  why={a.summary}
                  extra={<DemoPlan a={a} />}
                  tags={
                    <>
                      <ProvenanceMark kind="simulated">Simulated balances</ProvenanceMark>
                      <ProvenanceMark kind="estimate">Net after costs</ProvenanceMark>
                    </>
                  }
                  stage={{ kind: 'open' }}
                />
              ))}
            </div>
          )}
          <CheckedAndSkipped items={demo.skipped} />
        </section>
      )}
    </>
  );
}
