import { LineChart } from '../../../components/LineChart';
import { Pair } from '../../../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../../components/ui';
import { tryApi } from '../../../lib/api';
import { age, pct, poolName, ts, usd, usd2, usdCompact } from '../../../lib/format';
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
  if (!data) return <ApiError what="Pool" error={error} />;
  const p = data.pool;
  const windows = p.latest.windows ?? [];
  const w30 = windows.find((w) => w.window === '30D');
  const tvl = data.history.map((h) => ({
    t: Date.parse(h.blockTimestamp),
    v: h.tvlUsd === null ? null : Number(h.tvlUsd),
  }));
  return (
    <>
      <PageHeader
        crumbs={[{ href: '/rhea', label: 'Rhea pools' }]}
        title={
          <>
            Pool {poolName(p.poolKey)} <Pair tokens={p.tokens} />
          </>
        }
        lead={
          <>
            {p.poolType.replace(/_/g, ' ').toLowerCase()} on <code>{p.contract}</code> · fee{' '}
            {p.feeBps ?? '—'} bps · key <code>{p.poolKey}</code>
          </>
        }
        meta={
          <>
            {p.active ? (
              <Status code="OK" label="active" />
            ) : (
              <Status code="FAILED" label="inactive" />
            )}
            <br />
            last block #{p.lastBlockHeight}
          </>
        }
      />
      <div className="kpis">
        <Tile
          label="TVL"
          value={usdCompact(p.tvlUsd)}
          sub={`${p.latest.tvlMethod ?? 'method —'} · prices ${p.priceQuality.toLowerCase()}`}
        />
        <Tile
          label="30-day fee APR"
          value={pct(w30?.annualizedApr)}
          sub={
            w30
              ? `realised ${pct(w30.realizedYield, 3)} over ${Math.round((w30.seconds ?? 0) / 86400)} days`
              : 'no 30-day window'
          }
        />
        <Tile
          label="Category"
          value={<Status code={p.category} />}
          sub={`model ${p.modelStatus.toLowerCase()}`}
        />
        <Tile
          label="History stored"
          value={age(p.latest.historySeconds ?? 0)}
          sub={`first seen ${ts(p.firstSeenAt)}`}
        />
      </div>

      {p.reasons.length > 0 && (
        <Section title="Why this category">
          <div className="callout">
            {p.reasons.map((r, i) => (
              <div key={i}>
                <code>{r.code}</code> {r.detail}
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="TVL"
        note="One point per stored observation (90-day archival backfill, then every collector cycle)."
      >
        <div className="card">
          <LineChart unit="usd" series={[{ name: 'TVL (USD)', slot: 1, points: tvl }]} />
        </div>
      </Section>

      <Section
        title="Fee windows"
        note="Realised yield = LP fees / average pool value over the window (not annualised). Fee APR = the same scaled to a year: a short-term extrapolation, never a forecast."
      >
        {windows.length === 0 ? (
          <div className="callout">
            No fee window in the pool&apos;s latest record. The full registry scan stores pools
            without windows; windows come back with the next tracked cycle.
          </div>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Quality</th>
                  <th className="num">Volume</th>
                  <th className="num">Gross fees</th>
                  <th className="num">Admin fees</th>
                  <th className="num">LP fees</th>
                  <th className="num">Avg TVL</th>
                  <th className="num">Realised</th>
                  <th className="num">Fee APR</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {windows.map((w) => (
                  <tr key={w.window}>
                    <td>
                      <b>{w.window}</b>
                    </td>
                    <td data-tip={w.reason ?? `${w.observations} observations`}>
                      <Status code={w.quality} />
                    </td>
                    <td className="num">{usd(w.volumeUsd)}</td>
                    <td className="num">{usd2(w.grossFeesUsd)}</td>
                    <td className="num">{usd2(w.adminFeesUsd)}</td>
                    <td className="num">{usd2(w.lpFeesUsd)}</td>
                    <td className="num">{usd(w.avgTvlUsd)}</td>
                    <td className="num">{pct(w.realizedYield, 4)}</td>
                    <td className="num">{pct(w.annualizedApr)}</td>
                    <td>
                      {w.confidence ? (
                        <Status code={w.confidence} />
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      <Section title="Raw observations">
        <details className="table-view">
          <summary>
            {data.history.length} observations with block heights, raw reserves and cumulative
            volumes
          </summary>
          <TableWrap>
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
                      <td>{ts(h.blockTimestamp)}</td>
                      <td className="num">{h.blockHeight}</td>
                      <td className="num">{usd(h.tvlUsd)}</td>
                      <td className="mono wrap">{h.reserves.join(' / ')}</td>
                      <td className="mono wrap">{h.volumesIn?.join(' / ') ?? '—'}</td>
                      <td>
                        <Status code={h.quality} />
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
