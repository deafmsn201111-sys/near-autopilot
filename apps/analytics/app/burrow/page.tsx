import Link from 'next/link';
import { LineChart } from '../../components/LineChart';
import { Sparkline } from '../../components/Sparkline';
import { Token } from '../../components/Token';
import { ApiError, Meter, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { pct, usd, usdCompact } from '../../lib/format';
import { index, marketSeries } from '../../lib/series';
import type { Market } from '../../lib/types';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const n = (v: string | null) => (v === null ? -1 : Number(v));

export default async function BurrowPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const sort = one(sp.sort) || 'net';
  const status = one(sp.status);
  const { data, error } = await tryApi<{ markets: Market[] }>('/v1/analytics/burrow/markets');
  if (!data) return <ApiError what="Burrow markets" error={error} />;
  const series = await marketSeries(48);
  const byToken = index(series.data?.markets, (m) => m.token);
  const points = (token: string, k: 'supplyApr' | 'borrowApr' | 'utilization') =>
    (byToken.get(token)?.points ?? []).map((p) => ({ t: p.t, v: p[k] }));
  const all = data.markets;
  const sorters: Record<string, (a: Market, b: Market) => number> = {
    net: (a, b) => n(b.netSupplyApr) - n(a.netSupplyApr),
    borrow: (a, b) => n(b.borrowApr) - n(a.borrowApr),
    utilization: (a, b) => n(b.utilization) - n(a.utilization),
    liquidity: (a, b) => n(b.availableUsd) - n(a.availableUsd),
  };
  const rows = all.filter((m) => !status || m.status === status).sort(sorters[sort] ?? sorters.net);
  const ok = all.filter((m) => m.status === 'OK');
  const best = [...ok].sort((a, b) => n(b.netSupplyApr) - n(a.netSupplyApr))[0];
  const liquidity = ok.reduce((s, m) => s + (m.availableUsd ? Number(m.availableUsd) : 0), 0);
  const statuses = ['OK', 'LOW_CONFIDENCE', 'UNPRICED', 'DATA_INVALID'];
  // The rate charts: the valid markets with the most liquidity, in that fixed order.
  const charted = [...ok].sort((a, b) => n(b.availableUsd) - n(a.availableUsd)).slice(0, 6);
  const href = (s: string) =>
    `/burrow?${new URLSearchParams({ ...(s ? { status: s } : {}), sort }).toString()}`;
  return (
    <>
      <PageHeader
        title="Burrow markets"
        lead="Supply and borrow rates as contract.main.burrow.near reports them (simple rate at current utilisation). A market without valid data is never shown as 0% APR."
        meta={`${all.length} markets`}
      />
      <div className="kpis">
        <Tile
          label="Markets with valid data"
          value={`${ok.length} / ${all.length}`}
          sub="priced and consistent"
        />
        <Tile
          label="Highest net supply APR"
          value={best ? pct(best.netSupplyApr) : '—'}
          sub={best ? <Token id={best.token} /> : 'no valid market'}
        />
        <Tile label="Available liquidity" value={usdCompact(liquidity)} sub="valid markets, USD" />
        <Tile
          label="Active supply rewards"
          value={all.filter((m) => m.activeRewardProgrammes > 0).length}
          sub="markets with a reward programme"
        />
      </div>
      <div className="counts" style={{ marginTop: 20 }}>
        <Link href={href('')} aria-current={status === '' ? 'true' : undefined}>
          <span className="chip">All {all.length}</span>
        </Link>
        {statuses
          .filter((s) => all.some((m) => m.status === s))
          .map((s) => (
            <Link key={s} href={href(s)} aria-current={status === s ? 'true' : undefined}>
              <span className="chip">
                {s.replace(/_/g, ' ').toLowerCase()} {all.filter((m) => m.status === s).length}
              </span>
            </Link>
          ))}
      </div>
      <form className="filters" method="get">
        <input type="hidden" name="status" value={status} />
        <label>
          Sort by
          <select name="sort" defaultValue={sort}>
            <option value="net">net supply APR</option>
            <option value="borrow">borrow APR</option>
            <option value="utilization">utilisation</option>
            <option value="liquidity">available liquidity</option>
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>
      <TableWrap>
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th className="num">Supply APR</th>
              <th>48 h</th>
              <th className="num">Rewards</th>
              <th className="num">Net supply</th>
              <th className="num">Borrow APR</th>
              <th>Utilisation</th>
              <th className="num">Available</th>
              <th className="num">Collateral</th>
              <th>Data</th>
              <th>Allowed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.token}>
                <td>
                  <Token id={m.token} />{' '}
                  <Link
                    className="dim"
                    style={{ fontSize: 12 }}
                    href={`/burrow/${encodeURIComponent(m.token)}`}
                  >
                    history
                  </Link>
                </td>
                <td className="num">{pct(m.supplyApr)}</td>
                <td>
                  <Sparkline
                    label="supply APR, 48 h"
                    change="pp"
                    points={points(m.token, 'supplyApr')}
                    format={(v) => pct(v)}
                  />
                </td>
                <td className="num dim">
                  {m.rewardApr ? pct(m.rewardApr) : m.activeRewardProgrammes > 0 ? 'unpriced' : '—'}
                </td>
                <td className="num">
                  <b>{pct(m.netSupplyApr)}</b>
                </td>
                <td className="num">{pct(m.borrowApr)}</td>
                <td>
                  <Meter value={m.utilization === null ? null : Number(m.utilization)} />
                </td>
                <td className="num">{usd(m.availableUsd)}</td>
                <td className="num">
                  {m.canUseAsCollateral ? (
                    pct(m.collateralFactor, 0)
                  ) : (
                    <span className="dim">no</span>
                  )}
                </td>
                <td data-tip={m.risk.join('\n') || 'no risk flags'}>
                  <Status code={m.status} />
                </td>
                <td className="dim">{m.inExecutionAllowlist ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <Section
        title="Rates over time, 48 h"
        note="Supply and borrow APR of the six valid markets with the most available liquidity, as the contract reported them at each observation. Borrow is what a borrower pays; the gap is the protocol's spread plus reserve."
      >
        {series.data ? (
          <div className="multiples">
            {charted.map((m) => (
              <div className="multiple" key={m.token}>
                <h3>
                  <Token id={m.token} />
                  <span className="dim">utilisation {pct(m.utilization, 1)}</span>
                </h3>
                <LineChart
                  unit="pct"
                  width={440}
                  height={190}
                  zeroBased
                  series={[
                    { name: 'supply APR', slot: 1, points: points(m.token, 'supplyApr') },
                    { name: 'borrow APR', slot: 2, points: points(m.token, 'borrowApr') },
                  ]}
                />
              </div>
            ))}
          </div>
        ) : (
          <ApiError what="Rate history" error={series.error} />
        )}
      </Section>
      <p className="note">
        Net supply = supply APR + confirmed base reward APR only. Borrow APR is a cost, shown for
        risk analysis, never a recommendation. {all[0]?.note}
      </p>
    </>
  );
}
