import type { YieldDataDto } from '@near-autopilot/core';
import { getYieldData } from '../../lib/api';
import { formatFractionPercent as percent, formatTimestamp } from '../../lib/format';

export const dynamic = 'force-dynamic';

const SOURCE_TEXT: Record<string, string> = {
  burrow: 'Burrow (lending)',
  rhea_v1: 'Rhea v1 (pools)',
  rhea_dcl: 'Rhea DCL (concentrated liquidity)',
};
const TYPE_TEXT: Record<string, string> = {
  lending_supply: 'Supply APR',
  lending_borrow: 'Borrow APR (a cost, not a yield)',
  lp_fee: 'LP fee APR (historical)',
};
const STATUS_TEXT: Record<string, string> = {
  valid: 'Valid',
  rejected: 'Rejected',
  informational: 'Informational',
};

const usd = (v: string | null) =>
  v === null ? '—' : `$${Number(v.split('.')[0]).toLocaleString('en-US')}`;

function Estimates({ rows }: { rows: YieldDataDto['estimates'] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Source</th>
          <th>Market</th>
          <th>Type</th>
          <th>APR</th>
          <th>APY</th>
          <th>Utilisation</th>
          <th>Liquidity</th>
          <th>Price</th>
          <th>Status</th>
          <th>Reasons</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={`${e.source}:${e.marketId}:${e.yieldType}`}>
            <td>{SOURCE_TEXT[e.source] ?? e.source}</td>
            <td>
              <code>{e.marketId}</code>
            </td>
            <td>{TYPE_TEXT[e.yieldType] ?? e.yieldType}</td>
            <td>
              {percent(e.apr)}
              {e.observationPeriodSeconds !== null && (
                <span className="muted small">
                  {' '}
                  over {Math.round(e.observationPeriodSeconds / 3600)} h
                </span>
              )}
            </td>
            <td>{e.apy === null ? 'not computed' : percent(e.apy)}</td>
            <td>{percent(e.utilization)}</td>
            <td>{usd(e.liquidityUsd)}</td>
            <td>{e.priceStatus}</td>
            <td>{STATUS_TEXT[e.validationStatus] ?? e.validationStatus}</td>
            <td className="small">
              {e.reasons.length === 0
                ? '—'
                : e.reasons.map((r, i) => (
                    <div key={i}>
                      <code>{r.code}</code> {r.detail}
                    </div>
                  ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function YieldPage() {
  const data = await getYieldData();
  if (!data.enabled) {
    return (
      <>
        <h1>Yield data</h1>
        <p className="lede">This deployment reads no yield data (YIELD_DATA=none).</p>
      </>
    );
  }
  const valid = data.estimates.filter((e) => e.validationStatus === 'valid');
  const other = data.estimates.filter((e) => e.validationStatus !== 'valid');
  return (
    <>
      <h1>Yield data</h1>
      <p className="provenance provenance-test" role="status">
        {data.label}. Read-only views of TESTNET contracts at one block. A rate shown here is not an
        investment opportunity: only valid Burrow supply rates reach the Capital Allocator, and no
        transaction is ever made from this page.
      </p>
      {data.error && (
        <p className="provenance provenance-unknown" role="alert">
          {data.error}
        </p>
      )}
      <p className="muted small">
        Observed {data.observedAt ? formatTimestamp(data.observedAt) : '—'} at block{' '}
        {data.blockHeight ?? '—'}. Valid {data.counts.valid}, rejected {data.counts.rejected},
        informational {data.counts.informational}.
      </p>

      <section className="block" aria-labelledby="sources">
        <h2 id="sources">Sources</h2>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Contract</th>
              <th>Status</th>
              <th>Markets read</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((s) => (
              <tr key={s.source}>
                <td>{SOURCE_TEXT[s.source] ?? s.source}</td>
                <td>
                  <code>{s.contract || '—'}</code>
                </td>
                <td>{s.health}</td>
                <td>{s.marketsRead}</td>
                <td className="small">{s.detail ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="block" aria-labelledby="valid">
        <h2 id="valid">Valid estimates</h2>
        {valid.length === 0 ? (
          <p className="muted">None: nothing passed validation.</p>
        ) : (
          <Estimates rows={valid} />
        )}
      </section>

      <section className="block" aria-labelledby="other">
        <h2 id="other">Rejected and informational</h2>
        <Estimates rows={other} />
      </section>
    </>
  );
}
