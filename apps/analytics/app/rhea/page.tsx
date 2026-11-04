import Link from 'next/link';
import { tryApi } from '../../lib/api';
import { pct, shortToken, tone, usd } from '../../lib/format';
import type { FeeWindow, Pool } from '../../lib/types';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const win = (p: Pool, name: string): FeeWindow | undefined =>
  p.windows.find((w) => w.window === name);

const CATEGORIES = [
  '',
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
  if (!data) return <p className="bad">Analytics API unavailable: {error}</p>;
  const shown = data.pools;
  return (
    <>
      <h1>Rhea Explorer</h1>
      <p className="small">
        {data.total.toLocaleString('en-US')} pools discovered (v1 and DCL), every one listed with
        its category and reason.{' '}
        {Object.entries(data.counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(' · ')}
      </p>
      <p className="small dim">
        Fee APR is a SHORT-TERM ANNUALISED figure from the stored window (not a forecast); realised
        yield is the actual LP fee earned over the window. Discovery never makes a pool tradable:
        execution stays limited to the operator allowlist.
      </p>
      <form className="filters" method="get">
        <label>
          Token contains
          <input name="token" defaultValue={q.token} />
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
          Category
          <select name="category" defaultValue={q.category}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c || 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Min TVL (USD)
          <input name="minTvl" defaultValue={q.minTvl} inputMode="numeric" />
        </label>
        <label>
          Sort
          <select name="sort" defaultValue={q.sort}>
            <option value="tvl">TVL</option>
            <option value="volume">volume</option>
            <option value="apr">fee APR</option>
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>
      <p className="small">
        Showing {shown.length} of {data.matching} matching (top 200 by the chosen sort).
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Pool</th>
              <th>Pair</th>
              <th>Type</th>
              <th className="num">TVL</th>
              <th className="num">24h volume</th>
              <th className="num">Fee APR (short-term)</th>
              <th className="num">7d yield</th>
              <th className="num">30d yield</th>
              <th>Category</th>
              <th>Model</th>
              <th>Price quality</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const w24 = win(p, '24H');
              const w1 = win(p, '1H');
              const apr = w24?.annualizedApr ? w24 : w1?.annualizedApr ? w1 : undefined;
              return (
                <tr key={p.poolKey}>
                  <td>
                    <Link href={`/rhea/${encodeURIComponent(p.poolKey)}`}>
                      <code>{shortToken(p.poolKey)}</code>
                    </Link>
                  </td>
                  <td className="small">{p.tokens.map(shortToken).join(' / ')}</td>
                  <td>{p.poolType}</td>
                  <td className="num">{usd(p.tvlUsd)}</td>
                  <td className="num">
                    {w24?.volumeUsd ? (
                      usd(w24.volumeUsd)
                    ) : (
                      <span className="dim">{w24?.quality ?? '—'}</span>
                    )}
                  </td>
                  <td className="num">{apr ? `${pct(apr.annualizedApr)} (${apr.window})` : '—'}</td>
                  <td className="num">{pct(win(p, '7D')?.realizedYield, 3)}</td>
                  <td className="num">{pct(win(p, '30D')?.realizedYield, 3)}</td>
                  <td className={tone(p.category)}>{p.category}</td>
                  <td className={tone(p.modelStatus)}>{p.modelStatus}</td>
                  <td className={tone(p.priceQuality)}>{p.priceQuality}</td>
                  <td className="small">{p.reasons.map((r) => r.code).join(', ') || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
