import { LineChart } from '../../components/LineChart';
import { StressCurve } from '../../components/StressCurve';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { splitOutcome, ts, usd2 } from '../../lib/format';
import { riskReport, type RiskReport } from '../../lib/series';
import type { Analysis } from '../../lib/types';

export const dynamic = 'force-dynamic';

const micro = (v: string | undefined) => (v === undefined ? null : Number(v) / 1e6);
// Order matches the orchestrator's agent list (see apps/api/src/wiring.ts).
const AGENTS = [
  'market-intelligence',
  'portfolio-intelligence',
  'lp-optimizer',
  'liquidation-guardian',
  'capital-allocator',
];

function agents(outcome: string | null): Map<string, string> {
  return new Map(splitOutcome(outcome).parts.map((p) => [p.agent, p.text] as const));
}

/** "healthy (no abnormal ...)" -> status code "healthy" + the rest as detail. */
function agentState(text: string | undefined) {
  if (!text) return { code: null, detail: '' };
  if (/^\d+ proposal/.test(text)) return { code: 'proposed', detail: text };
  const m = /^([a-z_]+)\s*(?:\(([\s\S]*)\))?$/i.exec(text.trim());
  if (!m) return { code: 'reported', detail: text };
  const code = m[1] ?? '';
  return { code: /^\d/.test(code) ? 'proposal' : code, detail: m[2] ?? text };
}

const SLOTS = [1, 2, 3] as const;

/** Risk of the simulated demo portfolios: today's stress curve and the health factor over time. */
function RiskSection({ risk }: { risk: RiskReport }) {
  const list = risk.portfolios.filter((p) => p.latest?.healthFactor !== null);
  if (list.length === 0) return null;
  const b = risk.bands;
  const bandRefs = [
    { v: b.watch, label: `watch < ${b.watch}` },
    { v: b.danger, label: `danger < ${b.danger}` },
    { v: b.liquidation, label: 'liquidation < 1.0' },
  ];
  const stress = list.map((p, i) => ({
    name: p.portfolioId,
    slot: SLOTS[i % 3] ?? 1,
    liquidationAt: p.latest?.collateralDropToLiquidation ?? null,
    points: [
      { drop: 0, hf: p.latest?.healthFactor ?? 0 },
      ...(p.latest?.stress ?? []).flatMap((s) => {
        const m = /^collateral -(\d+)%$/.exec(s.scenario);
        return m && s.healthFactor !== null
          ? [{ drop: Number(m[1]) / 100, hf: s.healthFactor }]
          : [];
      }),
    ].sort((x, y) => x.drop - y.drop),
  }));
  return (
    <Section
      title="Liquidation risk"
      note={`${risk.label} Health factor = risk-adjusted collateral / risk-adjusted debt; below 1.0 the position can be liquidated. Bands are the orchestrator's (critical < ${b.critical} not drawn: it sits on the liquidation line).`}
    >
      <div className="kpis">
        {list.map((p) => {
          const drop = p.latest?.collateralDropToLiquidation ?? null;
          return (
            <Tile
              key={p.portfolioId}
              label={`${p.portfolioId} · health factor`}
              value={p.latest?.healthFactor?.toFixed(3) ?? '—'}
              sub={
                <>
                  <Status code={p.latest?.level ?? 'unknown'} /> LTV{' '}
                  {p.latest?.ltvBps === null || p.latest?.ltvBps === undefined
                    ? '—'
                    : `${(p.latest.ltvBps / 100).toFixed(1)}%`}
                  {drop !== null && ` · liquidatable after collateral −${(drop * 100).toFixed(1)}%`}
                </>
              }
            />
          );
        })}
      </div>
      <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
        <div className="chart-card">
          <h3 className="card-title">If collateral prices fall</h3>
          <p className="note" style={{ marginTop: 0 }}>
            Points are the engine&apos;s stress scenarios on the latest snapshot (debt unchanged).
          </p>
          <StressCurve series={stress} bands={bandRefs} />
        </div>
        <div className="chart-card">
          <h3 className="card-title">Health factor over time, {risk.hours} h</h3>
          <p className="note" style={{ marginTop: 0 }}>
            One point per collector cycle: the same simulated holdings at that cycle&apos;s mainnet
            prices.
          </p>
          <LineChart
            unit="ratio"
            height={280}
            refs={bandRefs.filter((r) => r.v > 1)}
            series={list.map((p, i) => ({
              name: p.portfolioId,
              slot: SLOTS[i % 3] ?? 1,
              points: p.history.map((h) => ({ t: h.t, v: h.healthFactor })),
            }))}
          />
        </div>
      </div>
    </Section>
  );
}

export default async function PortfoliosPage() {
  const { data, error } = await tryApi<{
    snapshot: { id: string; blockHeight: number; takenAt: string } | null;
    analyses: Analysis[];
  }>('/v1/analytics/portfolios');
  if (!data) return <ApiError what="Portfolios" error={error} />;
  const risk = await riskReport(72);
  const list = [...data.analyses].sort((a, b) => a.portfolioId.localeCompare(b.portfolioId));
  const econ = (a: Analysis) => a.result.decision?.rejected.find((r) => r.economics)?.economics;
  return (
    <>
      <PageHeader
        title="Portfolio comparison"
        lead="Both demo portfolios (simulated holdings) analysed by the four agents and the decision engine against ONE real mainnet snapshot. Execution is dry-run: nothing is sent."
        meta={
          <>
            Snapshot #{data.snapshot?.blockHeight ?? '—'}
            <br />
            {ts(data.snapshot?.takenAt)}
          </>
        }
      />
      {risk.data ? <RiskSection risk={risk.data} /> : <ApiError what="Risk" error={risk.error} />}
      <Section title="Agents and decision, latest snapshot">
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th style={{ width: 200 }} />
                {list.map((a) => (
                  <th key={a.portfolioId}>{a.portfolioId}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="dim">Holdings</td>
                {list.map((a) => (
                  <td key={a.portfolioId} className="wrap">
                    {a.result.portfolio.description}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="dim">Idle wallet value</td>
                {list.map((a) => (
                  <td key={a.portfolioId}>{usd2(a.result.portfolio.walletUsd)}</td>
                ))}
              </tr>
              <tr>
                <td className="dim">Position risk</td>
                {list.map((a) => {
                  const r = a.result.decision?.risk;
                  return (
                    <td key={a.portfolioId}>
                      {r ? (
                        <>
                          <Status code={r.level === 'none' ? 'healthy' : r.level} />{' '}
                          <span className="dim">
                            HF{' '}
                            {r.healthFactorWad
                              ? (Number(r.healthFactorWad) / 1e18).toFixed(3)
                              : '—'}{' '}
                            · LTV {r.ltvBps ? (Number(r.ltvBps) / 100).toFixed(1) : '—'}%
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  );
                })}
              </tr>
              {AGENTS.map((name) => (
                <tr key={name}>
                  <td className="dim">{name}</td>
                  {list.map((a) => {
                    const s = agentState(agents(a.outcome).get(name));
                    return (
                      <td key={a.portfolioId}>
                        {s.code ? <Status code={s.code} /> : '—'}
                        <div className="wrap" style={{ marginTop: 2 }}>
                          {s.detail}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <td className="dim">Decision engine</td>
                {list.map((a) => (
                  <td key={a.portfolioId}>
                    {a.result.decision ? (
                      <>
                        <span className="chip">{a.result.decision.outcome}</span>
                        <div className="wrap" style={{ marginTop: 4 }}>
                          {a.result.decision.reasons.join(', ')}
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="dim">Best rejected trade</td>
                {list.map((a) => {
                  const e = econ(a);
                  const b = micro(e?.benefitUsdMicro);
                  const c = micro(e?.costUsdMicro);
                  return (
                    <td key={a.portfolioId}>
                      {e ? (
                        <>
                          size {usd2(micro(e.valueInUsdMicro))} · benefit {usd2(b)} · cost {usd2(c)}{' '}
                          · net{' '}
                          <b className={(micro(e.netUsdMicro) ?? 0) > 0 ? 'pos' : 'neg'}>
                            {usd2(micro(e.netUsdMicro))}
                          </b>
                          <div className="wrap" style={{ marginTop: 2 }}>
                            benefit / cost {b !== null && c ? (b / c).toFixed(2) : '—'}; the hurdle
                            needs ≥ {e.requiredMultiple ?? '3'} and net ≥{' '}
                            {usd2(micro(e.minNetUsdMicro))}
                          </div>
                        </>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
              <tr>
                <td className="dim">Reason codes</td>
                {list.map((a) => (
                  <td key={a.portfolioId} className="wrap">
                    {(a.result.decision?.rejected ?? [])
                      .map((r) => `${r.code} (${r.kind})`)
                      .join('; ') || '—'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </TableWrap>
      </Section>
    </>
  );
}
