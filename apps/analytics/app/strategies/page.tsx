import { DivergingBars } from '../../components/DivergingBars';
import { ApiError, PageHeader, Section, Status, TableWrap } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { signed, usd2 } from '../../lib/format';
import { humanize } from '../../lib/token-label';
import type { Analysis } from '../../lib/types';

export const dynamic = 'force-dynamic';

export default async function StrategiesPage() {
  const { data, error } = await tryApi<{
    snapshot: { id: string; blockHeight: number } | null;
    analyses: Analysis[];
  }>('/v1/analytics/portfolios');
  if (!data) return <ApiError what="Strategies" error={error} />;
  return (
    <>
      <PageHeader
        title="Strategy comparison"
        lead="Same capital, same horizon, same mainnet snapshot. Lending rates held constant (simple, not compounded); LP fees are a realised short window extrapolated linearly. Neither is a forecast. Analysis only."
        meta={`Snapshot #${data.snapshot?.blockHeight ?? '—'}`}
      />
      {[...data.analyses]
        .sort((a, b) => a.portfolioId.localeCompare(b.portfolioId))
        .map((a) => {
          const s = [...a.result.strategies].sort(
            (x, y) => (y.netReturnUsd ?? -1e12) - (x.netReturnUsd ?? -1e12),
          );
          return (
            <Section
              key={a.portfolioId}
              title={`${a.portfolioId}: ${usd2(a.result.portfolio.capitalUsd)} over ${a.result.strategies[0]?.horizonDays ?? 30} days`}
              note={a.result.portfolio.description}
            >
              <div className="card" style={{ marginBottom: 12 }}>
                <div className="section-head">
                  <h2 style={{ fontSize: 14 }}>Net return after fees, IL, gas and slippage</h2>
                </div>
                <DivergingBars
                  format={(v) => usd2(v)}
                  rows={s.map((x) => ({
                    key: x.strategy,
                    label: humanize(x.label),
                    value: x.netReturnUsd,
                    tip: `${humanize(x.label)}\nnet ${usd2(x.netReturnUsd)} · gross ${usd2(x.grossReturnUsd)}\n${x.basis}`,
                  }))}
                />
              </div>
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th className="num">Gross</th>
                      <th className="num">Fees</th>
                      <th className="num">Rewards</th>
                      <th className="num">IL</th>
                      <th className="num">Gas</th>
                      <th className="num">Slippage</th>
                      <th className="num">Net</th>
                      <th>Confidence</th>
                      <th>Liquidity risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.map((x) => (
                      <tr key={x.strategy}>
                        <td
                          data-tip={`${x.basis}${x.reasonCodes.length ? `\n${x.reasonCodes.join(', ')}` : ''}`}
                        >
                          {humanize(x.label)}
                        </td>
                        <td className="num">{usd2(x.grossReturnUsd)}</td>
                        <td className="num">{usd2(x.feesUsd)}</td>
                        <td className="num">{usd2(x.rewardsUsd)}</td>
                        <td className="num">{usd2(x.impermanentLossUsd)}</td>
                        <td className="num">{usd2(x.gasUsd)}</td>
                        <td className="num">{usd2(x.slippageUsd)}</td>
                        <td className={`num ${signed(x.netReturnUsd)}`}>
                          <b>{usd2(x.netReturnUsd)}</b>
                        </td>
                        <td>
                          {x.confidence ? (
                            <Status code={x.confidence} />
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                        <td className="wrap">{x.liquidityRisk}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Section>
          );
        })}
    </>
  );
}
