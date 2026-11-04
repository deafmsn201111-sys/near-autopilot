import { HealthGauge } from '../components/HealthGauge';
import { HoldingsTable } from '../components/HoldingsTable';
import { getPolicy, getPortfolio } from '../lib/api';
import { formatTimestamp, formatUsd } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function PositionPage() {
  const [portfolio, policy] = await Promise.all([getPortfolio(), getPolicy()]);

  return (
    <>
      <h1>{portfolio.accountId}</h1>
      <p className="lede">
        <span className="figure">{formatUsd(portfolio.netValueUsd)}</span> net value across wallet
        and Burrow.{' '}
        {policy.executionMode === 'dry-run'
          ? 'The autopilot is in dry-run: it plans and checks every action but sends nothing.'
          : 'The autopilot is live: approved actions are sent on-chain.'}
        {!policy.enabled && ' Policy kill switch is ON; every action is blocked.'}
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
        title="Borrowed on Burrow"
        holdings={portfolio.borrowed}
        empty="No outstanding loans."
      />

      <p className="muted small">
        Prices from the Burrow oracle as of {formatTimestamp(portfolio.pricesAsOf)}. Tokens without
        an oracle price are listed but not counted in totals.
      </p>
    </>
  );
}
