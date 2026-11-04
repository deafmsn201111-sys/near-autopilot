import Link from 'next/link';
import { tryApi } from '../../lib/api';
import { pct, tone, usd2 } from '../../lib/format';
import type { Analysis } from '../../lib/types';

export const dynamic = 'force-dynamic';

export default async function LpPage() {
  const { data, error } = await tryApi<{
    snapshot: { id: string; blockHeight: number } | null;
    analyses: Analysis[];
  }>('/v1/analytics/portfolios');
  if (!data) return <p className="bad">Analytics API unavailable: {error}</p>;
  return (
    <>
      <h1>LP Analytics (entry simulation)</h1>
      <p className="small dim">
        Every LP_SIMULATION_ELIGIBLE Rhea pool (two-token SIMPLE_POOL, prices OK, enough fee history
        and volume). Net = LP fees + confirmed rewards (none) − impermanent loss − entry − exit −
        gas. Fees are the realised rate of the stored window extrapolated linearly: NOT a forecast.
        Analysis only; DCL and other pool types have no implemented model (UNSUPPORTED_POOL_MODEL).
        Snapshot #{data.snapshot?.blockHeight ?? '—'}.
      </p>
      {data.analyses.map((a) => {
        const sims = [...a.result.lpSimulations].sort(
          (x, y) => Number(y.netReturnUsd ?? -1e9) - Number(x.netReturnUsd ?? -1e9),
        );
        return (
          <section className="block" key={a.portfolioId}>
            <h2>
              {a.portfolioId}: capital {usd2(a.result.portfolio.capitalUsd)} (idle wallet value),
              horizon {sims[0]?.horizonDays ?? 30} days
            </h2>
            {sims.length === 0 ? (
              <p className="warn">
                No LP_SIMULATION_ELIGIBLE pool yet (pools need ≥ 1 h of fee history and volume). See{' '}
                <Link href="/rhea?category=LIQUID">liquid pools</Link>.
              </p>
            ) : (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Pool</th>
                      <th>Window</th>
                      <th className="num">Pool share</th>
                      <th className="num">Fees</th>
                      <th className="num">IL</th>
                      <th className="num">Price move</th>
                      <th className="num">Entry</th>
                      <th className="num">Exit</th>
                      <th className="num">Gas</th>
                      <th className="num">Net</th>
                      <th className="num">Net %</th>
                      <th>Confidence</th>
                      <th>Risks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sims.map((s) => (
                      <tr key={s.poolKey}>
                        <td>
                          <Link href={`/rhea/${encodeURIComponent(s.poolKey)}`}>
                            <code>{s.poolKey}</code>
                          </Link>
                        </td>
                        <td>{s.window ?? <span className="warn">{s.status}</span>}</td>
                        <td className="num">{s.poolShare ? pct(s.poolShare, 4) : '—'}</td>
                        <td className="num">{usd2(s.expectedFeesUsd)}</td>
                        <td className="num">{usd2(s.impermanentLossUsd)}</td>
                        <td className="num">
                          {s.priceMoveAssumed ? pct(s.priceMoveAssumed) : '—'}
                        </td>
                        <td className="num">{usd2(s.entryCostUsd)}</td>
                        <td className="num">{usd2(s.exitCostUsd)}</td>
                        <td className="num">{usd2(s.gasUsd)}</td>
                        <td className={`num ${Number(s.netReturnUsd) > 0 ? 'ok' : 'bad'}`}>
                          {usd2(s.netReturnUsd)}
                        </td>
                        <td className="num">{s.netReturnPct ? `${s.netReturnPct} %` : '—'}</td>
                        <td className={tone(s.confidence)}>{s.confidence ?? '—'}</td>
                        <td className="small">{s.reason ?? (s.risks.join('; ') || '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="small dim">{sims[0]?.assumptions}</p>
          </section>
        );
      })}
    </>
  );
}
