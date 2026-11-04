import { tryApi } from '../../../lib/api';
import { age, pct, shortToken, tone, ts, usd, usd2 } from '../../../lib/format';
import type { FeeWindow } from '../../../lib/types';

export const dynamic = 'force-dynamic';

interface PoolDetail {
  pool: {
    poolKey: string;
    contract: string;
    family: string;
    poolType: string;
    tokens: string[];
    feeBps: number | null;
    tvlUsd: string | null;
    category: string;
    modelStatus: string;
    priceQuality: string;
    reasons: { code: string; detail: string }[];
    firstSeenAt: string;
    lastSeenAt: string;
    lastBlockHeight: number;
    active: boolean;
    latest: {
      windows?: FeeWindow[];
      tvlMethod?: string | null;
      tracked?: boolean;
      historySeconds?: number;
      reserves?: string[];
    };
  };
  history: {
    blockHeight: number;
    blockTimestamp: string;
    tvlUsd: string | null;
    reserves: string[];
    volumesIn: string[] | null;
    quality: string;
    priceQuality: string;
  }[];
}

export default async function PoolPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { data, error } = await tryApi<PoolDetail>(
    `/v1/analytics/rhea/pools/${encodeURIComponent(decodeURIComponent(key))}`,
  );
  if (!data) return <p className="bad">Pool unavailable: {error}</p>;
  const p = data.pool;
  const windows = p.latest.windows ?? [];
  return (
    <>
      <h1>
        Pool <code>{p.poolKey}</code>
      </h1>
      <p className="small">
        {p.poolType} on <code>{p.contract}</code> · {p.tokens.map(shortToken).join(' / ')} · fee{' '}
        {p.feeBps ?? '—'} bps · {p.active ? 'active' : <span className="bad">inactive</span>}
      </p>
      <section className="grid">
        <div className="card">
          <h3>TVL</h3>
          <div className="big">{usd(p.tvlUsd)}</div>
          <div className="small">
            method: {p.latest.tvlMethod ?? '—'} · prices {p.priceQuality}
          </div>
        </div>
        <div className="card">
          <h3>Category</h3>
          <div className={`big ${tone(p.category)}`}>{p.category}</div>
          <div className="small">model {p.modelStatus}</div>
        </div>
        <div className="card">
          <h3>History</h3>
          <div className="big">{age(p.latest.historySeconds ?? 0)}</div>
          <div className="small">first seen {ts(p.firstSeenAt)}</div>
          <div className="small">last block #{p.lastBlockHeight}</div>
        </div>
      </section>
      <section className="block">
        <h2>Reasons</h2>
        <ul>
          {p.reasons.length === 0 ? (
            <li>none</li>
          ) : (
            p.reasons.map((r, i) => (
              <li key={i}>
                <code>{r.code}</code> {r.detail}
              </li>
            ))
          )}
        </ul>
      </section>
      <section className="block">
        <h2>Fee windows</h2>
        <p className="small dim">
          Realised yield = LP fees / average pool value over the window (not annualised). Fee APR =
          the same scaled to a year: a short-term extrapolation, never a forecast. Average value =
          mean of the start and end observations.
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Window</th>
                <th>Quality</th>
                <th className="num">Obs.</th>
                <th className="num">Seconds</th>
                <th className="num">Volume</th>
                <th className="num">Gross fees</th>
                <th className="num">Admin fees</th>
                <th className="num">LP fees</th>
                <th className="num">Avg TVL</th>
                <th className="num">End TVL</th>
                <th className="num">Realised yield</th>
                <th className="num">Fee APR</th>
                <th>Confidence</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((w) => (
                <tr key={w.window}>
                  <td>{w.window}</td>
                  <td className={tone(w.quality)}>{w.quality}</td>
                  <td className="num">{w.observations}</td>
                  <td className="num">{w.seconds ?? '—'}</td>
                  <td className="num">{usd(w.volumeUsd)}</td>
                  <td className="num">{usd2(w.grossFeesUsd)}</td>
                  <td className="num">{usd2(w.adminFeesUsd)}</td>
                  <td className="num">{usd2(w.lpFeesUsd)}</td>
                  <td className="num">{usd(w.avgTvlUsd)}</td>
                  <td className="num">{usd(w.endTvlUsd)}</td>
                  <td className="num">{pct(w.realizedYield, 4)}</td>
                  <td className="num">{pct(w.annualizedApr)}</td>
                  <td>{w.confidence ?? '—'}</td>
                  <td className="small">{w.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="block">
        <h2>Observations (last 30 days)</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th className="num">Block</th>
                <th className="num">TVL</th>
                <th>Reserves (raw)</th>
                <th>Cumulative input volume (raw)</th>
                <th>Quality</th>
              </tr>
            </thead>
            <tbody>
              {[...data.history]
                .reverse()
                .slice(0, 300)
                .map((h) => (
                  <tr key={h.blockHeight}>
                    <td className="small">{ts(h.blockTimestamp)}</td>
                    <td className="num">{h.blockHeight}</td>
                    <td className="num">{usd(h.tvlUsd)}</td>
                    <td className="small">{h.reserves.join(' / ')}</td>
                    <td className="small">{h.volumesIn?.join(' / ') ?? '—'}</td>
                    <td className={tone(h.quality)}>{h.quality}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
