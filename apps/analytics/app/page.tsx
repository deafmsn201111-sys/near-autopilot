import Link from 'next/link';
import { tryApi } from '../lib/api';
import { age, shortToken, tone, ts, usd2 } from '../lib/format';
import type { Overview } from '../lib/types';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const { data, error } = await tryApi<Overview>('/v1/analytics/overview');
  if (!data) return <p className="bad">Analytics API unavailable: {error}</p>;
  const c = data.collector;
  const src = (name: string) => c.sources.find((s) => s.source === name);
  const curated = src('prices.curated');
  return (
    <>
      <h1>Overview</h1>
      <p className="muted small">
        Read-only view of stored data. Generated {ts(data.generatedAt)}. Opening this page never
        collects anything.
      </p>
      <section className="grid">
        <div className="card">
          <h3>Collector</h3>
          <div className={`big ${c.running ? 'warn' : 'ok'}`}>{c.running ? 'running' : 'idle'}</div>
          <div className="small">last completed {ts(c.lastCompletedAt)}</div>
          <div className="small">
            next run ≈ {ts(c.nextRunAt)} (every {Math.round(c.intervalSeconds / 60)} min)
          </div>
          <div className="small">
            cycles: <span className="ok">{c.successfulCycles} ok</span> ·{' '}
            <span className="warn">{c.partialCycles} partial</span> ·{' '}
            <span className="bad">{c.failedCycles} failed</span>
          </div>
        </div>
        <div className="card">
          <h3>Mainnet snapshot</h3>
          <div className="big">{data.snapshot ? `#${data.snapshot.blockHeight}` : '—'}</div>
          <div className="small">taken {ts(data.snapshot?.takenAt)}</div>
          <div
            className={`small ${data.snapshot && data.snapshot.ageSeconds > c.intervalSeconds * 2 ? 'warn' : ''}`}
          >
            age {age(data.snapshot?.ageSeconds)}
          </div>
        </div>
        <div className="card">
          <h3>Sources</h3>
          {[
            'prices.curated',
            'prices.long_tail',
            'rhea.registry',
            'rhea.tracked',
            'burrow',
            'yields.agents',
            'portfolios',
          ].map((s) => {
            const r = src(s);
            return r ? (
              <div key={s} className="small">
                <span className={tone(r.health)}>●</span> {s}: {r.health}
              </div>
            ) : null;
          })}
          {curated?.detail && <div className="small dim">{curated.detail}</div>}
        </div>
        <div className="card">
          <h3>Rhea</h3>
          <div className="big">{data.rhea.discovered.toLocaleString('en-US')}</div>
          <div className="small">
            pools discovered ({data.rhea.byFamily.v1 ?? 0} v1, {data.rhea.byFamily.dcl ?? 0} DCL)
          </div>
          <div className="small">
            liquid {data.rhea.liquid} · LP-eligible {data.rhea.lpEligible}
          </div>
        </div>
        <div className="card">
          <h3>Burrow</h3>
          <div className="big">{data.burrow.markets}</div>
          <div className="small">markets; {data.burrow.supported} with valid data</div>
          <div className="small">
            supply opportunities {data.burrow.opportunities} · with rewards{' '}
            {data.burrow.withRewards}
          </div>
        </div>
      </section>

      <section className="block">
        <h2>Prices in the snapshot</h2>
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th className="num">USD</th>
              <th>Quality</th>
              <th>Chosen source</th>
            </tr>
          </thead>
          <tbody>
            {(data.snapshot?.summary.prices ?? []).map((p) => (
              <tr key={p.token}>
                <td>
                  <code>{shortToken(p.token)}</code>
                </td>
                <td className="num">{usd2(p.usd)}</td>
                <td className={tone(p.quality)}>{p.quality}</td>
                <td>{p.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small dim">
          {data.snapshot?.summary.pricedTokens ?? 0} tokens priced in total (see{' '}
          <Link href="/prices">Prices</Link>).
        </p>
      </section>

      <section className="block">
        <h2>Demo portfolios (same snapshot)</h2>
        <table>
          <thead>
            <tr>
              <th>Portfolio</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {data.portfolios.map((p) => (
              <tr key={p.portfolioId}>
                <td>{p.portfolioId}</td>
                <td className="small">{p.outcome ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small">
          Details: <Link href="/portfolios">Portfolio comparison</Link> ·{' '}
          <Link href="/strategies">Strategies</Link>
        </p>
      </section>
    </>
  );
}
