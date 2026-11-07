import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LineChart } from '../../../components/LineChart';
import { Pair } from '../../../components/Token';
import { EmptyState, Facts, Level, PageHeader, Section, Status } from '../../../components/ui';
import { ErrorState } from '../../../components/states';
import { pct, usd, usdCompact } from '../../../lib/format';
import { opportunity } from '../../../lib/product';

export const dynamic = 'force-dynamic';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

interface Window {
  window: string;
  annualizedApr: string | null;
  realizedYield: string | null;
  volumeUsd: string | null;
  lpFeesUsd?: string | null;
  quality: string;
  observations?: number;
}
interface DclRange {
  width: number;
  inRangeShare: number;
  liquidityShare: number;
  feesUsd: number;
  divergenceLossUsd: number;
  swapUsd: number;
  gasUsd: number;
  netUsd: number;
  feeApr: number;
  backtest: { feesUsd: number; divergenceLossUsd: number; netUsd: number };
}
interface Dcl {
  capitalUsd: number;
  horizonDays: number;
  windowSeconds: number;
  observations: number;
  maxMove: number;
  poolLpFeesUsd: number;
  ranges: DclRange[];
  method: string;
}

const money2 = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;

/** Concentrated-liquidity pool: each simulated range, the stress estimate for the horizon and the realised backtest. */
function DclSection({ e }: { e: Dcl }) {
  const hours = Math.round(e.windowSeconds / 3600);
  return (
    <Section
      title="Concentrated liquidity: what each range would do"
      note={`A position of $${Math.round(e.capitalUsd).toLocaleString('en-US')} opened ${hours} hours ago (${e.observations} observations). Analysis only: nothing is executed.`}
    >
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Range</th>
                <th className="num">In range</th>
                <th className="num">Fees, {e.horizonDays} days</th>
                <th className="num">Divergence loss (stress)</th>
                <th className="num">Swaps + gas</th>
                <th className="num">Net, {e.horizonDays} days</th>
                <th className="num">Last {hours} h, as it happened</th>
              </tr>
            </thead>
            <tbody>
              {e.ranges.map((r) => (
                <tr key={r.width}>
                  <td>±{Math.round(r.width * 100)}% of the price</td>
                  <td className="num">{Math.round(r.inRangeShare * 100)}%</td>
                  <td className="num">
                    {money2(r.feesUsd)}{' '}
                    <span className="muted-note">({(r.feeApr * 100).toFixed(1)}%/yr)</span>
                  </td>
                  <td className="num">{money2(-r.divergenceLossUsd)}</td>
                  <td className="num">{money2(-(r.swapUsd + r.gasUsd))}</td>
                  <td className={`num ${r.netUsd < 0 ? 'neg' : 'pos'}`}>
                    <b>{money2(r.netUsd)}</b>
                  </td>
                  <td className={`num ${r.backtest.netUsd < 0 ? 'neg' : 'pos'}`}>
                    {money2(r.backtest.netUsd)}{' '}
                    <span className="muted-note">
                      (fees {money2(r.backtest.feesUsd)}, loss{' '}
                      {money2(r.backtest.divergenceLossUsd)})
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">
          The pool&apos;s liquidity providers earned {money2(e.poolLpFeesUsd)} in that time; the
          price moved up to {(e.maxMove * 100).toFixed(1)}%. A narrow range earns a larger share of
          the fees but only while the price stays inside it, and loses more when the price moves.
          The {e.horizonDays}-day loss assumes the largest move seen, scaled to the horizon (a
          stress case); the last column is what actually happened.
        </p>
        <p className="note">Method: {e.method}.</p>
      </div>
    </Section>
  );
}

interface Sim {
  capitalUsd?: number;
  horizonDays?: number;
  window?: string;
  expectedFeesUsd?: string;
  impermanentLossUsd?: string;
  entryCostUsd?: string;
  exitCostUsd?: string;
  gasUsd?: string;
  netReturnUsd?: string;
  netReturnPct?: string;
  assumptions?: string;
  risks?: string[];
}

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data, error } = await opportunity(decodeURIComponent(id));
  if (!data) {
    if (error?.includes('HTTP 404')) notFound();
    return <ErrorState what="This opportunity" error={error} />;
  }
  const o = data.opportunity;
  const d = o.detail;
  const windows = (d['windows'] as Window[] | undefined) ?? [];
  const sim = (d['simulation'] as Sim | null | undefined) ?? null;
  const dcl = (d['dcl'] as Dcl | null | undefined) ?? null;
  const h = data.history;
  return (
    <>
      <PageHeader
        crumbs={[{ href: '/opportunities', label: 'Opportunities' }]}
        title={o.title}
        lead={o.why}
        meta={
          <>
            Rank {data.rank} of {data.of}
            <br />
            {o.protocol === 'rhea' ? 'Rhea liquidity pool' : 'Burrow lending market'}
          </>
        }
      />
      <div className="kpis">
        <div className="card tile">
          <div className="label">Yield before costs</div>
          <div className="value">{o.grossApr === null ? '—' : pct(o.grossApr, 2)}</div>
          <div className="sub">{o.grossBasis}</div>
        </div>
        <div className="card tile">
          <div className="label">Net after costs</div>
          <div className={`value ${o.netApr !== null && o.netApr < 0 ? 'neg' : ''}`}>
            {o.netApr === null ? 'not simulated' : pct(o.netApr, 2)}
          </div>
          <div className="sub">
            {o.netBasis ?? 'No stored cost simulation covers this opportunity.'}
          </div>
        </div>
        <div className="card tile">
          <div className="label">Liquidity</div>
          <div className="value">{usdCompact(o.liquidityUsd)}</div>
          <div className="sub">
            {o.volume24hUsd === null
              ? 'no volume figure'
              : `${usdCompact(o.volume24hUsd)} traded in 24 h`}
          </div>
        </div>
        <div className="card tile">
          <div className="label">Autopilot view</div>
          <div className="value" style={{ fontSize: 18, display: 'grid', gap: 6 }}>
            <Status code={o.status} />
            <Level level={o.risk.level} score={o.risk.score} what="risk" />
          </div>
          <div className="sub">
            confidence {o.confidence.score} / 100 · data {o.fresh ? 'up to date' : 'out of date'}
          </div>
        </div>
      </div>

      <Section title="Why it is ranked like this">
        <div className="grid-2">
          <div className="card">
            <h3 className="card-title">What speaks for it</h3>
            <ul>
              {o.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
          <div className="card">
            <h3 className="card-title">Limits of these numbers</h3>
            <ul>
              {[...o.confidence.notes, ...o.limitations].map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="note">
          The autopilot never acts on this list by itself: a proposal would still need to pass the
          policy engine&apos;s 12 checks, and in shadow mode even an allowed plan is only simulated.{' '}
          <Link href="/policy">See policy decisions →</Link>
        </p>
      </Section>

      <Section
        title="Risk analysis"
        note="Each factor 0 (none) to 100 (highest), weighted into the risk score."
      >
        <div className="card">
          {o.risk.factors.map((f) => (
            <div className="factor" key={f.name}>
              <span>{f.name}</span>
              <span className="bar" aria-hidden="true">
                <span style={{ width: `${Math.round(f.value * 100)}%` }} />
              </span>
              <span className="num">{Math.round(f.value * 100)}</span>
              <span className="note">
                {f.note} · weight {f.weight}%
              </span>
            </div>
          ))}
        </div>
      </Section>

      {o.protocol === 'rhea' ? (
        <>
          {!dcl && (
            <Section
              title="Yield breakdown"
              note="Realised LP fees in each window, annualised. A window needs enough observations to count."
            >
              {windows.length === 0 ? (
                <EmptyState title="No fee window measured yet.">
                  The collector needs at least two observations an hour apart.
                </EmptyState>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Window</th>
                        <th className="num">Volume</th>
                        <th className="num">LP fees</th>
                        <th className="num">Yield in window</th>
                        <th className="num">Annualised</th>
                        <th>Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {windows.map((w) => (
                        <tr key={w.window}>
                          <td>{w.window}</td>
                          <td className="num">{usd(w.volumeUsd)}</td>
                          <td className="num">{usd(w.lpFeesUsd ?? null, 2)}</td>
                          <td className="num">{pct(w.realizedYield, 3)}</td>
                          <td className="num">{pct(w.annualizedApr)}</td>
                          <td>
                            <Status code={w.quality} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          )}
          {dcl && <DclSection e={dcl} />}
          {!dcl && (
            <Section
              title="Simulation"
              note="What a position of the demo capital would have earned, after costs. Analysis only: nothing is executed."
            >
              {sim ? (
                <div className="card">
                  <Facts
                    items={[
                      ['Capital', usd(sim.capitalUsd ?? null)],
                      [
                        'Horizon',
                        `${sim.horizonDays ?? '—'} days (fees from the ${sim.window ?? '—'} window)`,
                      ],
                      ['Fees earned', usd(num(sim.expectedFeesUsd), 2)],
                      ['Impermanent loss', usd(num(sim.impermanentLossUsd), 2)],
                      ['Entry cost (swap + impact)', usd(num(sim.entryCostUsd), 2)],
                      ['Exit cost', usd(num(sim.exitCostUsd), 2)],
                      ['Gas', usd(num(sim.gasUsd), 2)],
                      [
                        'Net result',
                        <b
                          key="n"
                          className={
                            num(sim.netReturnUsd) !== null && (num(sim.netReturnUsd) ?? 0) < 0
                              ? 'neg'
                              : 'pos'
                          }
                        >
                          {usd(num(sim.netReturnUsd), 2)} ({sim.netReturnPct ?? '—'}%)
                        </b>,
                      ],
                    ]}
                  />
                  {sim.assumptions && <p className="note">Assumptions: {sim.assumptions}</p>}
                  {sim.risks && sim.risks.length > 0 && (
                    <p className="note">Flags: {sim.risks.join('; ')}</p>
                  )}
                </div>
              ) : (
                <EmptyState title="Not simulated.">
                  Cost simulations run only for pools that are ready for simulation, against the
                  demo portfolios. <Link href="/lp">See all LP simulations →</Link>
                </EmptyState>
              )}
            </Section>
          )}
          <Section
            title="Liquidity history"
            note="Pool value in USD at each observation. It moves with token prices, not only with deposits."
          >
            <div className="chart-card">
              <LineChart
                unit="usd"
                height={240}
                series={[
                  {
                    name: 'TVL',
                    slot: 1,
                    points: h.map((x) => ({ t: Number(x['t']), v: num(x['tvlUsd']) })),
                  },
                ]}
              />
            </div>
          </Section>
        </>
      ) : (
        <>
          <Section title="Yield breakdown">
            <div className="card">
              <Facts
                items={[
                  ['Supply rate', pct(num(d['supplyApr']), 2)],
                  [
                    'Confirmed rewards',
                    d['rewardApr'] === null ? 'none confirmed' : pct(num(d['rewardApr']), 2),
                  ],
                  ['Borrowed share (utilisation)', pct(num(d['utilization']), 1)],
                  [
                    'Usable as collateral',
                    d['canUseAsCollateral']
                      ? `yes, counts at ${pct(num(d['collateralFactor']), 0)}`
                      : 'no',
                  ],
                ]}
              />
              <p className="note">
                A variable rate set by utilisation; it is not a guaranteed return.
              </p>
            </div>
          </Section>
          <Section title="Rate history, 30 days">
            <div className="chart-card">
              <LineChart
                unit="pct"
                height={240}
                zeroBased
                series={[
                  {
                    name: 'supply APR',
                    slot: 1,
                    points: h.map((x) => ({ t: Number(x['t']), v: num(x['supplyApr']) })),
                  },
                  {
                    name: 'borrow APR',
                    slot: 2,
                    points: h.map((x) => ({ t: Number(x['t']), v: num(x['borrowApr']) })),
                  },
                ]}
              />
            </div>
          </Section>
        </>
      )}

      <Section title="Price quality">
        <div className="card">
          <Status code={o.priceConfidence === 'OK' ? 'CORROBORATED' : o.priceConfidence} />{' '}
          <span className="dim">
            {o.priceConfidence === 'OK'
              ? 'The token prices behind these numbers were confirmed by at least two independent sources.'
              : 'At least one token price is not confirmed by two sources; values in USD are less certain.'}
          </span>{' '}
          <Link href="/prices">Prices →</Link>
        </div>
      </Section>

      <details className="more" style={{ marginTop: 24 }}>
        <summary>Technical details</summary>
        <div className="card" style={{ marginTop: 10 }}>
          <Facts
            items={[
              ['Identifier', <code key="id">{o.id}</code>],
              ['Tokens', <Pair key="p" tokens={o.tokens} />],
              ['Score', `${o.score} (risk ${o.risk.score}, confidence ${o.confidence.score})`],
              ['Data age', `${o.dataAgeSeconds} s`],
            ]}
          />
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>
            {JSON.stringify(d, null, 2)}
          </pre>
          {o.protocol === 'rhea' ? (
            <Link href={`/rhea/${encodeURIComponent(o.ref)}`}>Full pool record →</Link>
          ) : (
            <Link href={`/burrow/${encodeURIComponent(o.ref)}`}>Full market record →</Link>
          )}
        </div>
      </details>
    </>
  );
}
