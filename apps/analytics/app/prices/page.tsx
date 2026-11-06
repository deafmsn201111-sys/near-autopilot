import Link from 'next/link';
import { LineChart } from '../../components/LineChart';
import { Sparkline } from '../../components/Sparkline';
import { Token } from '../../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { ts, usd } from '../../lib/format';
import { index, priceSeries } from '../../lib/series';
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
  // One 48 h read: the spread charts use all of it, the sparklines the last 24 h.
  const spreads = await priceSeries(48);
  const byAsset = index(spreads.data?.assets, (a) => a.asset);
  const dayAgo = Date.now() - 86_400_000;
  const spark = (asset: string) => (
    <Sparkline
      label="median valid USD price, 24 h"
      points={(byAsset.get(asset)?.points ?? [])
        .filter((p) => p.t >= dayAgo)
        .map((p) => ({ t: p.t, v: p.price }))}
      format={(v) => usd(v, v < 10 ? 4 : 2)}
    />
  );
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
                <th>24 h</th>
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
                  <td>{spark(a.asset)}</td>
                  <td>
                    <Link href={`/prices/${encodeURIComponent(a.asset)}`}>History →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Section>
      <Section
        title="Disagreement between sources, 48 h"
        note="The widest gap between any two valid USD quotes of the asset in each snapshot, against the asset's limit (dashed). Above the limit the price is LOW_CONFIDENCE and the policy refuses to act on it (oracle_deviation). A gap appears only where at least two sources were valid."
      >
        {spreads.data ? (
          <div className="multiples">
            {curated.map((a) => {
              const s = byAsset.get(a.asset);
              const pts = (s?.points ?? []).map((p) => ({ t: p.t, v: p.spreadBps }));
              const last = [...pts].reverse().find((p) => p.v !== null)?.v ?? null;
              return (
                <div className="multiple" key={a.asset}>
                  <h3>
                    <Token id={a.asset} />
                    <span className="dim">
                      now {last === null ? '—' : `${last} bps`}
                      {s?.limitBps ? ` · limit ${s.limitBps} bps` : ''}
                    </span>
                  </h3>
                  <LineChart
                    unit="bps"
                    width={440}
                    height={170}
                    zeroBased
                    series={[{ name: 'spread', slot: 1, points: pts }]}
                    refs={s?.limitBps ? [{ v: s.limitBps, label: 'limit' }] : []}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <ApiError what="Spread history" error={spreads.error} />
        )}
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
                <th>24 h</th>
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
                  <td>{spark(a.asset)}</td>
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
