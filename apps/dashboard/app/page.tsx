import { HealthGauge } from '../components/HealthGauge';
import { HoldingsTable } from '../components/HoldingsTable';
import { getPolicy, getPortfolio } from '../lib/api';
import { formatAmount, formatTimestamp, formatUsd } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function PositionPage() {
  const [portfolio, policy] = await Promise.all([getPortfolio(), getPolicy()]);

  return (
    <>
      <h1>{portfolio.accountId}</h1>
      <p className="lede">
        <span className="figure">{formatUsd(portfolio.netValueUsd)}</span> net value across wallet
        and Burrow.{' '}
        {portfolio.dataSource === 'simulation'
          ? 'These are SIMULATED demo balances, not an on-chain position.'
          : policy.executionMode === 'dry-run'
            ? `The autopilot is in dry-run on ${portfolio.network}: it plans and checks every action but sends nothing.`
            : `The autopilot is live on ${portfolio.network}: approved actions are sent on-chain.`}
        {!policy.enabled && ' Policy kill switch is ON; every action is blocked.'}
      </p>

      {portfolio.pricing.unpriced.length > 0 && (
        <p className="provenance provenance-unknown" role="status">
          {portfolio.pricing.priced.length === 0
            ? 'No usable price: the oracle returned none for any tracked token. '
            : 'Some tokens have no usable price. '}
          Unpriced: {portfolio.pricing.unpriced.join(', ')}. They are excluded from the totals
          below, and the autopilot will not act on them.
        </p>
      )}

      <p className="muted">
        Native balance: {formatAmount(portfolio.nativeBalanceYocto, 24)} NEAR (not included in USD
        totals).
      </p>

      <section className="block" aria-labelledby="health">
        <h2 id="health">Liquidation distance</h2>
        <HealthGauge
          healthFactor={portfolio.healthFactor}
          trigger={policy.guardian.triggerHealthFactor}
          target={policy.guardian.targetHealthFactor}
        />
      </section>

      <HoldingsTable
        title="Wallet"
        holdings={portfolio.wallet}
        empty="No tracked tokens in the wallet."
      />
      <HoldingsTable
        title="Collateral on Burrow"
        holdings={portfolio.collateral}
        empty="Nothing posted as collateral."
      />
      <HoldingsTable
        title="Supplied on Burrow (not collateral)"
        holdings={portfolio.supplied}
        empty="Nothing supplied outside collateral."
      />
      <HoldingsTable
        title="Borrowed on Burrow"
        holdings={portfolio.borrowed}
        empty="No outstanding loans."
      />

      <p className="muted small">
        Read at {formatTimestamp(portfolio.asOf)}.{' '}
        {portfolio.dataSource === 'simulation'
          ? `Fixed demo prices (${portfolio.pricing.priced.length} tokens).`
          : portfolio.pricing.priced.length === 0
            ? `The Burrow oracle (answered at ${formatTimestamp(portfolio.pricesAsOf)}) priced no tracked token.`
            : `Prices from the Burrow oracle as of ${formatTimestamp(portfolio.pricesAsOf)} (${portfolio.pricing.priced.length} tokens).`}{' '}
        Tokens without an oracle price are listed but not counted in totals.
      </p>
    </>
  );
}
