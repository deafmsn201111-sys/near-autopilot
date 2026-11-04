import { tryApi } from '../../lib/api';
import { tone, ts, usd2 } from '../../lib/format';
import type { Analysis } from '../../lib/types';

export const dynamic = 'force-dynamic';

const micro = (v: string | undefined) => (v === undefined ? null : Number(v) / 1e6);

function agents(outcome: string | null): { agent: string; text: string }[] {
  if (!outcome) return [];
  return outcome
    .split('; ')
    .slice(1)
    .map((p) => {
      const i = p.indexOf(':');
      return { agent: p.slice(0, i), text: p.slice(i + 1).trim() };
    });
}

export default async function PortfoliosPage() {
  const { data, error } = await tryApi<{
    snapshot: { id: string; blockHeight: number; takenAt: string } | null;
    analyses: Analysis[];
  }>('/v1/analytics/portfolios');
  if (!data) return <p className="bad">Analytics API unavailable: {error}</p>;
  const list = [...data.analyses].sort((a, b) => a.portfolioId.localeCompare(b.portfolioId));
  return (
    <>
      <h1>Portfolio comparison</h1>
      <p className="small">
        Both demo portfolios were analysed against ONE market snapshot:{' '}
        <code>{data.snapshot?.id ?? '—'}</code>, block #{data.snapshot?.blockHeight ?? '—'},{' '}
        {ts(data.snapshot?.takenAt)}. Portfolio states are independent (synthetic, simulated).
        Execution: dry-run only, nothing is sent.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              {list.map((a) => (
                <th key={a.portfolioId}>{a.portfolioId}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Description</td>
              {list.map((a) => (
                <td key={a.portfolioId} className="small">
                  {a.result.portfolio.description}
                </td>
              ))}
            </tr>
            <tr>
              <td>Idle wallet value</td>
              {list.map((a) => (
                <td key={a.portfolioId}>{usd2(a.result.portfolio.walletUsd)}</td>
              ))}
            </tr>
            <tr>
              <td>Risk (Guardian)</td>
              {list.map((a) => {
                const r = a.result.decision?.risk;
                return (
                  <td
                    key={a.portfolioId}
                    className={tone(
                      r?.level === 'healthy' || r?.level === 'none' ? 'ok' : r?.level,
                    )}
                  >
                    {r
                      ? `${r.level}, HF ${r.healthFactorWad ? (Number(r.healthFactorWad) / 1e18).toFixed(3) : '—'}, LTV ${r.ltvBps ? (Number(r.ltvBps) / 100).toFixed(1) : '—'} %`
                      : '—'}
                  </td>
                );
              })}
            </tr>
            {[
              'market-intelligence',
              'lp-optimizer',
              'liquidation-guardian',
              'capital-allocator',
            ].map((name) => (
              <tr key={name}>
                <td>{name}</td>
                {list.map((a) => (
                  <td key={a.portfolioId} className="small">
                    {agents(a.outcome).find((x) => x.agent === name)?.text ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td>Decision engine</td>
              {list.map((a) => (
                <td key={a.portfolioId}>
                  {a.result.decision
                    ? `${a.result.decision.outcome}: ${a.result.decision.reasons.join(', ')}`
                    : '—'}
                </td>
              ))}
            </tr>
            {(['valueInUsdMicro', 'benefitUsdMicro', 'costUsdMicro', 'netUsdMicro'] as const).map(
              (k) => (
                <tr key={k}>
                  <td>
                    {
                      {
                        valueInUsdMicro: 'Trade size',
                        benefitUsdMicro: 'Benefit (30 d)',
                        costUsdMicro: 'Cost',
                        netUsdMicro: 'Net benefit',
                      }[k]
                    }
                  </td>
                  {list.map((a) => {
                    const e = a.result.decision?.rejected.find((r) => r.economics)?.economics;
                    return <td key={a.portfolioId}>{e ? usd2(micro(e[k])) : '—'}</td>;
                  })}
                </tr>
              ),
            )}
            <tr>
              <td>Benefit / cost</td>
              {list.map((a) => {
                const e = a.result.decision?.rejected.find((r) => r.economics)?.economics;
                const b = micro(e?.benefitUsdMicro);
                const c = micro(e?.costUsdMicro);
                return (
                  <td key={a.portfolioId}>
                    {b !== null && c
                      ? `${(b / c).toFixed(2)} (needs ≥ ${e?.requiredMultiple ?? '3'} and net ≥ ${usd2(micro(e?.minNetUsdMicro))})`
                      : '—'}
                  </td>
                );
              })}
            </tr>
            <tr>
              <td>Reason codes</td>
              {list.map((a) => (
                <td key={a.portfolioId} className="small">
                  {(a.result.decision?.rejected ?? [])
                    .map((r) => `${r.code} (${r.kind})`)
                    .join('; ') || '—'}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
