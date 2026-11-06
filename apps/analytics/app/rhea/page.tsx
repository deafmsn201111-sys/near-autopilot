import Link from 'next/link';
import { Sparkline } from '../../components/Sparkline';
import { Pair } from '../../components/Token';
import { ApiError, PageHeader, Status, TableWrap } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { int, pct, poolName, usd } from '../../lib/format';
import { index, poolSeries } from '../../lib/series';
import type { FeeWindow, Pool } from '../../lib/types';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const win = (p: Pool, name: string): FeeWindow | undefined =>
  p.windows.find((w) => w.window === name);

const CATEGORIES = [
  'LP_SIMULATION_ELIGIBLE',
  'ANALYTICS_ELIGIBLE',
  'LIQUID',
  'UNSUPPORTED',
  'LOW_LIQUIDITY',
  'DISCOVERED',
  'DATA_INVALID',
];

interface PoolList {
  total: number;
  matching: number;
  counts: Record<string, number>;
  types: string[];
  pools: Pool[];
}

export default async function RheaPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = {
    token: one(sp.token),
    type: one(sp.type),
    category: one(sp.category),
    minTvl: one(sp.minTvl),
    sort: one(sp.sort) || 'tvl',
  };
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '')).toString();
  const { data, error } = await tryApi<PoolList>(`/v1/analytics/rhea/pools?${qs}`);
  if (!data) return <ApiError what="Rhea pools" error={error} />;
  const series = await poolSeries(24);
  const byPool = index(series.data?.pools, (p) => p.poolKey);
  const withCategory = (c: string) =>
    `/rhea?${new URLSearchParams(Object.entries({ ...q, category: c }).filter(([, v]) => v !== '')).toString()}`;
  return (
    <>
      <PageHeader
        title="Rhea pools"
        lead="Every pool on v2.ref-finance.near (v1) and dclv2.ref-labs.near (DCL), with the category the collector gave it and why. Fee APR is a short window annualised: a measurement, not a forecast."
        meta={`${int(data.total)} pools discovered`}
      />
      <div className="counts">
        <Link href={withCategory('')} aria-current={q.category === '' ? 'true' : undefined}>
          <span className="chip">All {int(data.total)}</span>
        </Link>
        {CATEGORIES.filter((c) => data.counts[c]).map((c) => (
          <Link key={c} href={withCategory(c)} aria-current={q.category === c ? 'true' : undefined}>
            <span className="chip">
              {c.replace(/_/g, ' ').toLowerCase()} {int(data.counts[c])}
            </span>
          </Link>
        ))}
      </div>
      <form className="filters" method="get">
        <input type="hidden" name="category" value={q.category} />
        <label>
          Token contract contains
          <input name="token" defaultValue={q.token} placeholder="wrap.near" />
        </label>
        <label>
          Pool type
          <select name="type" defaultValue={q.type}>
            <option value="">any</option>
            {data.types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Min TVL (USD)
          <input name="minTvl" defaultValue={q.minTvl} inputMode="numeric" placeholder="10000" />
        </label>
        <label>
          Sort by
          <select name="sort" defaultValue={q.sort}>
            <option value="tvl">TVL</option>
            <option value="volume">24h volume</option>
            <option value="apr">fee APR</option>
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>
      <p className="note" style={{ margin: '0 0 8px' }}>
        Showing {data.pools.length} of {int(data.matching)} matching (top 200 by the chosen sort).
        Discovery never makes a pool tradable: execution is limited to the operator allowlist.
      </p>
      <TableWrap>
        <table>
          <thead>
            <tr>
              <th>Pool</th>
              <th>Pair</th>
              <th>Type</th>
              <th className="num">TVL</th>
              <th>TVL 24 h</th>
              <th className="num">24h volume</th>
              <th className="num">Fee APR</th>
              <th className="num">7d yield</th>
              <th className="num">30d yield</th>
              <th>Category</th>
              <th>Prices</th>
            </tr>
          </thead>
          <tbody>
            {data.pools.map((p) => {
              const w24 = win(p, '24H');
              const w1 = win(p, '1H');
              const apr = w24?.annualizedApr ? w24 : w1?.annualizedApr ? w1 : undefined;
              const reasons = p.reasons.map((r) => `${r.code}: ${r.detail}`).join('\n');
              return (
                <tr key={p.poolKey}>
                  <td>
                    <Link
                      className="row-link"
                      href={`/rhea/${encodeURIComponent(p.poolKey)}`}
                      data-tip={p.poolKey}
                    >
                      {poolName(p.poolKey)}
                    </Link>
                  </td>
                  <td>
                    <Pair tokens={p.tokens} />
                  </td>
                  <td>
                    <span className="chip">{p.poolType.replace(/_/g, ' ').toLowerCase()}</span>
                  </td>
                  <td className="num">{usd(p.tvlUsd)}</td>
                  <td>
                    {byPool.has(p.poolKey) ? (
                      <Sparkline
                        label="TVL in USD as stored per observation, 24 h (moves with token prices, not only deposits)"
                        points={(byPool.get(p.poolKey)?.points ?? []).map((x) => ({
                          t: x.t,
                          v: x.tvl,
                        }))}
                        format={(v) => usd(v)}
                      />
                    ) : (
                      <span
                        className="dim spark-empty"
                        data-tip="only tracked pools are observed each cycle"
                        tabIndex={0}
                      >
                        not tracked
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {w24?.volumeUsd ? usd(w24.volumeUsd) : <span className="dim">—</span>}
                  </td>
                  <td
                    className="num"
                    data-tip={apr ? `${apr.window} window, annualised` : 'no window'}
                  >
                    {apr ? pct(apr.annualizedApr) : '—'}
                  </td>
                  <td className="num">{pct(win(p, '7D')?.realizedYield, 3)}</td>
                  <td className="num">{pct(win(p, '30D')?.realizedYield, 3)}</td>
                  <td data-tip={reasons || 'no reasons recorded'}>
                    <Status code={p.category} />
                  </td>
                  <td>
                    <Status code={p.priceQuality} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}
