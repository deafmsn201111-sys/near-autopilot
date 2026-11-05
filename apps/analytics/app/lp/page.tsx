import Link from 'next/link';
import { DivergingBars } from '../../components/DivergingBars';
import { Pair } from '../../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { pct, poolName, signed, usd2 } from '../../lib/format';
import { humanize } from '../../lib/token-label';
import type { Analysis, Pool } from '../../lib/types';

export const dynamic = 'force-dynamic';

export default async function LpPage() {
  const [{ data, error }, pools] = await Promise.all([
    tryApi<{ snapshot: { id: string; blockHeight: number } | null; analyses: Analysis[] }>(
      '/v1/analytics/portfolios',
    ),
    tryApi<{ pools: Pool[] }>('/v1/analytics/rhea/pools?category=LP_SIMULATION_ELIGIBLE'),
  ]);
  if (!data) return <ApiError what="LP simulation" error={error} />;
  const tokensOf = new Map((pools.data?.pools ?? []).map((p) => [p.poolKey, p.tokens]));
  return (
    <>
      <PageHeader
        title="LP simulation"
        lead="Entering each LP-eligible Rhea pool with the demo capital. Net = LP fees + confirmed rewards − impermanent loss − entry − exit − gas. Fees are the realised rate of the stored window extrapolated linearly: not a forecast."
        meta={`Snapshot #${data.snapshot?.blockHeight ?? '—'}`}
      />
      {data.analyses.map((a) => {
        const sims = [...a.result.lpSimulations].sort(
          (x, y) => Number(y.netReturnUsd ?? -1e9) - Number(x.netReturnUsd ?? -1e9),
        );
        const label = (key: string) => {
          const t = tokensOf.get(key);
          return (
            <>
              <b>{poolName(key)}</b> {t ? <Pair tokens={t} /> : null}
            </>
          );
        };
        return (
          <Section
            key={a.portfolioId}
            title={`${a.portfolioId}: ${usd2(a.result.portfolio.capitalUsd)} over ${sims[0]?.horizonDays ?? 30} days`}
            note={sims[0]?.assumptions ? humanize(sims[0].assumptions) : undefined}
          >
            {sims.length === 0 ? (
              <div className="callout">
                No LP-eligible pool yet (a pool needs at least 1 h of fee history and volume). See{' '}
                <Link href="/rhea?category=LIQUID">liquid pools</Link>.
              </div>
            ) : (
              <>
                <div className="card" style={{ marginBottom: 12 }}>
                  <DivergingBars
                    format={(v) => usd2(v)}
                    rows={sims.map((s) => ({
                      key: s.poolKey,
                      label: label(s.poolKey),
                      value: s.netReturnUsd === null ? null : Number(s.netReturnUsd),
                      tip: `${s.poolKey}\nnet ${usd2(s.netReturnUsd)} (${s.netReturnPct ?? '—'}%)\nfees ${usd2(s.expectedFeesUsd)} · IL ${usd2(s.impermanentLossUsd)} · costs ${usd2(Number(s.entryCostUsd ?? 0) + Number(s.exitCostUsd ?? 0) + Number(s.gasUsd ?? 0))}`,
                    }))}
                  />
                </div>
                <TableWrap>
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
                        <th>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sims.map((s) => (
                        <tr key={s.poolKey}>
                          <td>
                            <Link
                              href={`/rhea/${encodeURIComponent(s.poolKey)}`}
                              style={{ textDecoration: 'none' }}
                            >
                              {label(s.poolKey)}
                            </Link>
                          </td>
                          <td>{s.window ?? <Status code={s.status} />}</td>
                          <td className="num">{s.poolShare ? pct(s.poolShare, 4) : '—'}</td>
                          <td className="num">{usd2(s.expectedFeesUsd)}</td>
                          <td className="num">{usd2(s.impermanentLossUsd)}</td>
                          <td className="num">
                            {s.priceMoveAssumed ? pct(s.priceMoveAssumed) : '—'}
                          </td>
                          <td className="num">{usd2(s.entryCostUsd)}</td>
                          <td className="num">{usd2(s.exitCostUsd)}</td>
                          <td className="num">{usd2(s.gasUsd)}</td>
                          <td
                            className={`num ${signed(s.netReturnUsd)}`}
                            data-tip={s.reason ?? (s.risks.join('\n') || 'no risk flags')}
                          >
                            <b>{usd2(s.netReturnUsd)}</b>
                          </td>
                          <td>
                            {s.confidence ? (
                              <Status code={s.confidence} />
                            ) : (
                              <span className="dim">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </>
            )}
          </Section>
        );
      })}
    </>
  );
}
