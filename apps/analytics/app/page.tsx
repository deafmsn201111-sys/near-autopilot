import Link from 'next/link';
import { Token } from '../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../components/ui';
import { tryApi } from '../lib/api';
import { age, int, splitOutcome, ts, usd2 } from '../lib/format';
import type { Overview } from '../lib/types';

export const dynamic = 'force-dynamic';

const SOURCES = [
  'prices.curated',
  'prices.long_tail',
  'routes.probe',
  'rhea.registry',
  'rhea.tracked',
  'burrow',
  'yields.agents',
  'tokens.metadata',
  'portfolios',
];

export default async function OverviewPage() {
  const { data, error } = await tryApi<Overview>('/v1/analytics/overview');
  if (!data) return <ApiError what="Analytics API" error={error} />;
  const c = data.collector;
  const near = data.snapshot?.summary.prices?.find((p) => p.token === 'wrap.near');
  const stale = data.snapshot ? data.snapshot.ageSeconds > c.intervalSeconds * 2 : true;
  return (
    <>
      <PageHeader
        title="Overview"
        lead="What the collector last read from NEAR mainnet: prices, Rhea pools, Burrow markets, and what the autopilot would do with the two demo portfolios."
        meta={
          <>
            Generated {ts(data.generatedAt)}
            <br />
            Snapshot block #{data.snapshot?.blockHeight ?? '—'}
          </>
        }
      />
      <div className="kpis">
        <Tile
          hero
          label="NEAR / USD (quorum)"
          value={near ? usd2(near.usd) : '—'}
          sub={near ? `${near.quality} · chosen source ${near.source}` : 'no usable price'}
          href="/prices"
        />
        <Tile
          label="Snapshot age"
          value={age(data.snapshot?.ageSeconds)}
          sub={
            <Status
              code={stale ? 'STALE' : 'OK'}
              label={
                stale
                  ? 'older than two cycles'
                  : `fresh · every ${Math.round(c.intervalSeconds / 60)} min`
              }
            />
          }
          href="/collector"
        />
        <Tile
          label="Rhea pools"
          value={int(data.rhea.discovered)}
          sub={`${data.rhea.liquid} liquid · ${data.rhea.lpEligible} LP-eligible · ${data.rhea.byFamily.v1 ?? 0} v1 / ${data.rhea.byFamily.dcl ?? 0} DCL`}
          href="/rhea"
        />
        <Tile
          label="Burrow markets"
          value={data.burrow.markets}
          sub={`${data.burrow.supported} with valid data · ${data.burrow.opportunities} supply opportunities`}
          href="/burrow"
        />
        <Tile
          label="Collector cycles"
          value={<Status code={c.running ? 'RUNNING' : 'IDLE'} />}
          sub={`${c.successfulCycles} ok · ${c.partialCycles} partial · ${c.failedCycles} failed · next ${ts(c.nextRunAt).slice(11, 16)} UTC`}
          href="/collector"
        />
      </div>

      <div className="grid-2">
        <Section
          title="Prices in the snapshot"
          aside={
            <Link href="/prices">
              All {data.snapshot?.summary.pricedTokens ?? 0} priced tokens →
            </Link>
          }
        >
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th className="num">USD</th>
                  <th>Quality</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {(data.snapshot?.summary.prices ?? []).map((p) => (
                  <tr key={p.token}>
                    <td>
                      <Token id={p.token} />
                    </td>
                    <td className="num">{usd2(p.usd)}</td>
                    <td>
                      <Status code={p.quality} />
                    </td>
                    <td className="dim">{p.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Section>
        <Section
          title="Sources in the last cycle"
          aside={<Link href="/collector">Collector →</Link>}
        >
          <TableWrap>
            <table>
              <tbody>
                {SOURCES.map((s) => c.sources.find((x) => x.source === s))
                  .filter((s) => s !== undefined)
                  .map((s) => (
                    <tr key={s.source}>
                      <td>{s.source}</td>
                      <td>
                        <Status code={s.health} />
                      </td>
                      <td className="wrap">{s.detail ?? ''}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </TableWrap>
        </Section>
      </div>

      <Section
        title="Demo portfolios on this snapshot"
        note="Simulated portfolios ($500 and $5,000) analysed against real mainnet data. Dry-run: nothing is ever sent."
        aside={<Link href="/portfolios">Comparison →</Link>}
      >
        <div className="grid-2">
          {data.portfolios.map((p) => {
            const so = splitOutcome(p.outcome);
            const o = { decision: so.head, agents: so.parts };
            return (
              <div className="card" key={p.portfolioId}>
                <div className="section-head">
                  <h2>{p.portfolioId}</h2>
                  <span className="chip">{o.decision ?? 'no run'}</span>
                </div>
                <table>
                  <tbody>
                    {o.agents.map((a) => (
                      <tr key={a.agent}>
                        <td style={{ whiteSpace: 'nowrap' }}>{a.agent}</td>
                        <td className="wrap">{a.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}
