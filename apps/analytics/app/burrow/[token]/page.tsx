import { LineChart } from '../../../components/LineChart';
import { Token } from '../../../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../../components/ui';
import { tryApi } from '../../../lib/api';
import { pct, ts, usd, usdCompact } from '../../../lib/format';

export const dynamic = 'force-dynamic';

interface History {
  token: string;
  history: {
    blockHeight: number;
    blockTimestamp: string;
    supplyApr: string | null;
    borrowApr: string | null;
    utilization: string | null;
    availableUsd: string | null;
    rewardApr: string | null;
    quality: string;
  }[];
}

const num = (v: string | null) => (v === null ? null : Number(v));

export default async function MarketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { data, error } = await tryApi<History>(
    `/v1/analytics/burrow/markets/${encodeURIComponent(decodeURIComponent(token))}`,
  );
  if (!data) return <ApiError what="Market" error={error} />;
  const h = data.history;
  const last = h[h.length - 1];
  const t = (x: History['history'][number]) => Date.parse(x.blockTimestamp);
  return (
    <>
      <PageHeader
        crumbs={[{ href: '/burrow', label: 'Burrow markets' }]}
        title={
          <>
            Burrow market <Token id={data.token} />
          </>
        }
        lead={
          <>
            Rates, utilisation and liquidity per collector snapshot (last 30 days). Contract{' '}
            <code>{data.token}</code>.
          </>
        }
        meta={`${h.length} snapshots`}
      />
      <div className="kpis">
        <Tile
          label="Supply APR"
          value={pct(last?.supplyApr ?? null)}
          sub={`reward ${pct(last?.rewardApr ?? null)}`}
        />
        <Tile label="Borrow APR" value={pct(last?.borrowApr ?? null)} />
        <Tile label="Utilisation" value={pct(last?.utilization ?? null, 1)} />
        <Tile
          label="Available"
          value={usdCompact(last?.availableUsd ?? null)}
          sub={last ? <Status code={last.quality} /> : null}
        />
      </div>
      <Section title="Supply and borrow APR" note="Both in % a year, one axis.">
        <div className="card">
          <LineChart
            unit="pct"
            zeroBased
            series={[
              {
                name: 'Supply APR',
                slot: 1,
                points: h.map((x) => ({ t: t(x), v: num(x.supplyApr) })),
              },
              {
                name: 'Borrow APR',
                slot: 2,
                points: h.map((x) => ({ t: t(x), v: num(x.borrowApr) })),
              },
            ]}
          />
        </div>
      </Section>
      <Section title="Utilisation">
        <div className="card">
          <LineChart
            unit="pct"
            zeroBased
            series={[
              {
                name: 'Utilisation',
                slot: 1,
                points: h.map((x) => ({ t: t(x), v: num(x.utilization) })),
              },
            ]}
          />
        </div>
      </Section>
      <Section title="Snapshots">
        <details className="table-view">
          <summary>{h.length} rows</summary>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th className="num">Block</th>
                  <th className="num">Supply</th>
                  <th className="num">Borrow</th>
                  <th className="num">Utilisation</th>
                  <th className="num">Available</th>
                  <th className="num">Reward</th>
                  <th>Quality</th>
                </tr>
              </thead>
              <tbody>
                {[...h].reverse().map((x) => (
                  <tr key={x.blockHeight}>
                    <td>{ts(x.blockTimestamp)}</td>
                    <td className="num">{x.blockHeight}</td>
                    <td className="num">{pct(x.supplyApr)}</td>
                    <td className="num">{pct(x.borrowApr)}</td>
                    <td className="num">{pct(x.utilization, 1)}</td>
                    <td className="num">{usd(x.availableUsd)}</td>
                    <td className="num">{pct(x.rewardApr)}</td>
                    <td>
                      <Status code={x.quality} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </details>
      </Section>
    </>
  );
}
