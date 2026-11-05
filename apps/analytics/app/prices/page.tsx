import Link from 'next/link';
import { Token } from '../../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { ts, usd } from '../../lib/format';
import type { PriceObs, PriceRow } from '../../lib/types';

export const dynamic = 'force-dynamic';

const SOURCES = ['pyth', 'defillama', 'coinbase', 'kraken', 'binance'] as const;
const LABEL: Record<string, string> = {
  pyth: 'Pyth',
  defillama: 'DefiLlama',
  coinbase: 'Coinbase',
  kraken: 'Kraken',
  binance: 'Binance',
};

const price = (o: PriceObs) =>
  o.priceUsd ? usd(o.priceUsd, Number(o.priceUsd) < 10 ? 4 : 2) : '—';

/** One source's quote: the price, with status, quote currency and age on hover. */
function Quote({ o }: { o: PriceObs | null | undefined }) {
  if (!o) return <span className="dim">—</span>;
  const tip = [
    `${LABEL[o.source] ?? o.source}: ${o.status}${o.reason ? ` (${o.reason})` : ''}`,
    `quoted in ${o.quoteCurrency}`,
    o.ageMs === null ? null : `age ${Math.round(o.ageMs / 1000)} s`,
    o.confidence ? `confidence ${o.confidence}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const valid = o.status === 'valid';
  return (
    <span
      data-tip={tip}
      tabIndex={0}
      className={valid ? '' : 'dim'}
      style={valid ? undefined : { textDecoration: 'line-through' }}
    >
      {o.quoteCurrency === 'USD'
        ? price(o)
        : `${Number(o.priceUsd ?? 0).toFixed(4)} ${o.quoteCurrency}`}
    </span>
  );
}

export default async function PricesPage() {
  const { data, error } = await tryApi<{
    snapshot: { id: string; blockHeight: number; takenAt: string } | null;
    assets: PriceRow[];
  }>('/v1/analytics/prices');
  if (!data) return <ApiError what="Prices" error={error} />;
  const curated = data.assets.filter((a) => a.curated);
  const tail = data.assets.filter((a) => !a.curated);
  const by = (a: PriceRow, s: string) => a.sources?.find((o) => o?.source === s);
  return (
    <>
      <PageHeader
        title="Prices"
        lead="Every source is stored separately. A price needs two independent USD sources within the asset's limit (NEAR: 150 bps); a missing price is never 0, and the more favourable source is never picked."
        meta={`Snapshot #${data.snapshot?.blockHeight ?? '—'} · ${ts(data.snapshot?.takenAt)}`}
      />
      <div className="kpis">
        <Tile
          label="Curated assets"
          value={curated.length}
          sub={`${curated.filter((a) => a.status === 'CORROBORATED').length} corroborated`}
        />
        <Tile
          label="Long-tail tokens"
          value={tail.length}
          sub="DefiLlama only; below 0.9 confidence = discovery only"
        />
      </div>
      <Section
        title="Curated assets"
        note="Struck-through quotes were rejected (stale, invalid, unavailable): hover for the reason. Binance quotes NEAR in USDT; the price service converts it through the corroborated USDT/USD."
      >
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                {SOURCES.map((s) => (
                  <th key={s} className="num">
                    {LABEL[s]}
                  </th>
                ))}
                <th className="num">Spread</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {curated.map((a) => (
                <tr key={a.asset}>
                  <td>
                    <Token id={a.asset} />
                  </td>
                  {SOURCES.map((s) => (
                    <td key={s} className="num">
                      <Quote o={by(a, s)} />
                    </td>
                  ))}
                  <td
                    className="num"
                    data-tip={
                      a.maxDeviationBps === null ? 'no limit' : `limit ${a.maxDeviationBps} bps`
                    }
                  >
                    {a.spreadBps === null ? '—' : `${a.spreadBps} bps`}
                  </td>
                  <td>
                    <Status code={a.status} />
                  </td>
                  <td>
                    <Link href={`/prices/${encodeURIComponent(a.asset)}`}>History →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Section>
      <Section title="Long-tail tokens">
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th className="num">DefiLlama</th>
                <th className="num">Confidence</th>
                <th>Published</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tail.map((a) => (
                <tr key={a.asset}>
                  <td>
                    <Token id={a.asset} />
                  </td>
                  <td className="num">
                    <Quote o={a.defillama} />
                  </td>
                  <td className="num">{a.defillama?.confidence ?? '—'}</td>
                  <td className="dim">{ts(a.defillama?.publishedAt)}</td>
                  <td>
                    <Status code={a.status} />
                  </td>
                  <td>
                    <Link href={`/prices/${encodeURIComponent(a.asset)}`}>History →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Section>
    </>
  );
}
