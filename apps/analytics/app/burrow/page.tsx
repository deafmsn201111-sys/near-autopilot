import Link from 'next/link';
import { tryApi } from '../../lib/api';
import { pct, shortToken, tone, usd } from '../../lib/format';
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
  if (!data) return <p className="bad">Analytics API unavailable: {error}</p>;
  const all = data.markets;
  const sorters: Record<string, (a: Market, b: Market) => number> = {
    net: (a, b) => n(b.netSupplyApr) - n(a.netSupplyApr),
    borrow: (a, b) => n(b.borrowApr) - n(a.borrowApr),
    utilization: (a, b) => n(b.utilization) - n(a.utilization),
    liquidity: (a, b) => n(b.availableUsd) - n(a.availableUsd),
  };
  const rows = all.filter((m) => !status || m.status === status).sort(sorters[sort] ?? sorters.net);
  const count = (f: (m: Market) => boolean) => all.filter(f).length;
  return (
    <>
      <h1>Burrow Explorer</h1>
      <p className="small">
        {all.length} markets discovered · {count((m) => m.status === 'OK')} with valid data ·{' '}
        {count((m) => m.activeRewardProgrammes > 0)} with active supply rewards ·{' '}
        {count((m) => m.status !== 'OK')} unpriced / invalid (reasons per row). A missing market is
        never a 0 % APR.
      </p>
      <p className="small dim">
        Supply APR is what the contract reports (simple rate at current utilisation). Net supply =
        supply + CONFIRMED base reward APR only. Borrow APR is a cost, shown for risk analysis,
        never a recommendation. {all[0]?.note}
      </p>
      <form className="filters" method="get">
        <label>
          Status
          <select name="status" defaultValue={status}>
            {['', 'OK', 'LOW_CONFIDENCE', 'UNPRICED', 'DATA_INVALID'].map((s) => (
              <option key={s} value={s}>
                {s || 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select name="sort" defaultValue={sort}>
            <option value="net">net supply APR</option>
            <option value="borrow">borrow APR</option>
            <option value="utilization">utilisation</option>
            <option value="liquidity">available liquidity</option>
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th className="num">Supply APR</th>
              <th className="num">Borrow APR</th>
              <th className="num">Utilisation</th>
              <th className="num">Available</th>
              <th className="num">Collateral factor</th>
              <th className="num">Rewards</th>
              <th className="num">Net supply</th>
              <th>Status</th>
              <th>Risk</th>
              <th>Allowlist</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.token}>
                <td>
                  <Link href={`/burrow/${encodeURIComponent(m.token)}`}>
                    <code>{shortToken(m.token)}</code>
                  </Link>
                </td>
                <td className="num">{pct(m.supplyApr)}</td>
                <td className="num">{pct(m.borrowApr)}</td>
                <td className="num">{pct(m.utilization, 1)}</td>
                <td className="num">{usd(m.availableUsd)}</td>
                <td className="num">
                  {m.canUseAsCollateral ? pct(m.collateralFactor, 0) : 'not collateral'}
                </td>
                <td className="num">
                  {m.rewardApr ? pct(m.rewardApr) : m.activeRewardProgrammes > 0 ? 'unpriced' : '—'}
                </td>
                <td className="num">{pct(m.netSupplyApr)}</td>
                <td className={tone(m.status)}>{m.status}</td>
                <td className="small">{m.risk.join('; ') || '—'}</td>
                <td>{m.inExecutionAllowlist ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
