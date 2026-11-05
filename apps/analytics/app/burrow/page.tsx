import Link from 'next/link';
import { Token } from '../../components/Token';
import { ApiError, Meter, PageHeader, Status, TableWrap, Tile } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { pct, usd, usdCompact } from '../../lib/format';
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
              <th className="num">Rewards</th>
              <th className="num">Net supply</th>
              <th className="num">Borrow APR</th>
              <th>Utilisation</th>
              <th className="num">Available</th>
              <th className="num">Collateral</th>
              <th>Data</th>
              <th>Allowed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.token}>
                <td>
                  <Token id={m.token} />
                </td>
                <td className="num">{pct(m.supplyApr)}</td>
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
                <td>
                  <Link href={`/burrow/${encodeURIComponent(m.token)}`}>History →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <p className="note">
        Net supply = supply APR + confirmed base reward APR only. Borrow APR is a cost, shown for
        risk analysis, never a recommendation. {all[0]?.note}
      </p>
    </>
  );
}
