import { tryApi } from '../../lib/api';
import { tone, usd2 } from '../../lib/format';
import type { Analysis } from '../../lib/types';

export const dynamic = 'force-dynamic';

export default async function StrategiesPage() {
  const { data, error } = await tryApi<{
    snapshot: { id: string; blockHeight: number } | null;
    analyses: Analysis[];
  }>('/v1/analytics/portfolios');
  if (!data) return <p className="bad">Analytics API unavailable: {error}</p>;
  return (
    <>
      <h1>Strategy comparison</h1>
      <p className="small dim">
        Same capital, same horizon, same snapshot (#{data.snapshot?.blockHeight ?? '—'}). Lending
        rates are held constant (simple, not compounded); LP fees are a realised short window
        extrapolated linearly; neither is a forecast. &quot;Current structure&quot; is the whole
        demo Burrow position, not the comparison capital. Analysis only.
      </p>
      {[...data.analyses]
        .sort((a, b) => a.portfolioId.localeCompare(b.portfolioId))
        .map((a) => (
          <section className="block" key={a.portfolioId}>
            <h2>
              {a.portfolioId}: capital {usd2(a.result.portfolio.capitalUsd)},{' '}
              {a.result.strategies[0]?.horizonDays ?? 30} days
            </h2>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th className="num">Gross</th>
                    <th className="num">Fees earned</th>
                    <th className="num">Rewards</th>
                    <th className="num">IL</th>
                    <th className="num">Gas</th>
                    <th className="num">Slippage</th>
                    <th className="num">Net</th>
                    <th>Liquidity risk</th>
                    <th>Confidence</th>
                    <th>Basis</th>
                    <th>Codes</th>
                  </tr>
                </thead>
                <tbody>
                  {a.result.strategies.map((s) => (
                    <tr key={s.strategy}>
                      <td>{s.label}</td>
                      <td className="num">{usd2(s.grossReturnUsd)}</td>
                      <td className="num">{usd2(s.feesUsd)}</td>
                      <td className="num">{usd2(s.rewardsUsd)}</td>
                      <td className="num">{usd2(s.impermanentLossUsd)}</td>
                      <td className="num">{usd2(s.gasUsd)}</td>
                      <td className="num">{usd2(s.slippageUsd)}</td>
                      <td
                        className={`num ${s.netReturnUsd === null ? 'dim' : s.netReturnUsd > 0 ? 'ok' : 'bad'}`}
                      >
                        {usd2(s.netReturnUsd)}
                      </td>
                      <td className="small">{s.liquidityRisk}</td>
                      <td className={tone(s.confidence)}>{s.confidence ?? '—'}</td>
                      <td className="small">{s.basis}</td>
                      <td className="small">{s.reasonCodes.join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
    </>
  );
}
