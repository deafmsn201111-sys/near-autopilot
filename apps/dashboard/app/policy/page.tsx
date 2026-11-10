import { getPolicy } from '../../lib/api';
import { formatUsd } from '../../lib/format';

export const dynamic = 'force-dynamic';

export default async function PolicyPage() {
  const p = await getPolicy();
  const rows: Array<[string, string]> = [
    [
      'Data source',
      p.dataSource === 'simulation'
        ? `Simulation (${p.simulationPortfolio ?? 'demo'}): mock RPC, no network access`
        : `NEAR ${p.network}`,
    ],
    [
      'Market data',
      p.marketData === 'mainnet-live'
        ? 'MAINNET prices (Pyth, DefiLlama, exchanges)'
        : p.dataSource === 'simulation'
          ? 'Fixed demo prices'
          : `Burrow oracle on ${p.network}`,
    ],
    ['Decision engine', p.engine],
    ['Kill switch', p.enabled ? 'Off (autopilot allowed to act)' : 'On (all actions blocked)'],
    ['Execution mode', p.executionMode === 'dry-run' ? 'Dry run: nothing is sent' : 'Live'],
    ['Largest single action', formatUsd(p.maxActionUsd)],
    ['Held for your approval above', formatUsd(p.approvalThresholdUsd)],
    ['Daily limit', formatUsd(p.dailyLimitUsd)],
    ['Maximum slippage', `${(p.maxSlippageBps / 100).toFixed(2)}%`],
    ['Maximum gap to oracle price', `${(p.maxOracleDeviationBps / 100).toFixed(2)}%`],
    ['Pause between swaps', `${p.cooldownSeconds} seconds`],
    ['Acts when health factor drops below', p.guardian.triggerHealthFactor.toFixed(2)],
    ['Restores health factor to', p.guardian.targetHealthFactor.toFixed(2)],
  ];

  return (
    <>
      <h1>Policy</h1>
      <p className="lede">
        Hard limits enforced before anything is signed. Change them in the config file, not here.
      </p>
      <dl className="facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <section className="block">
        <h2>Allowed contracts</h2>
        <ul className="plain">
          {p.allowedContracts.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>
      <section className="block">
        <h2>Allowed tokens</h2>
        <ul className="plain">
          {p.allowedTokens.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
