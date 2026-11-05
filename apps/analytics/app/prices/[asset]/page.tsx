import { LineChart, type Series } from '../../../components/LineChart';
import { Token } from '../../../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap } from '../../../components/ui';
import { tryApi } from '../../../lib/api';
import { ts, usd } from '../../../lib/format';

export const dynamic = 'force-dynamic';

interface History {
  asset: string;
  history: {
    id: string;
    source: string;
    quoteCurrency?: string;
    priceUsd: string | null;
    confidence: string | null;
    publishedAt: string | null;
    observedAt: string;
    status: string;
    reason: string | null;
  }[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

export default async function AssetPage({ params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  const { data, error } = await tryApi<History>(
    `/v1/analytics/prices/${encodeURIComponent(decodeURIComponent(asset))}`,
  );
  if (!data) return <ApiError what="Price history" error={error} />;
  // Observations of one cycle share a minute: group them, take the median of the valid USD quotes.
  const usdValid = data.history.filter(
    (h) => h.status === 'valid' && h.priceUsd !== null && (h.quoteCurrency ?? 'USD') === 'USD',
  );
  const byMinute = new Map<number, { source: string; v: number }[]>();
  for (const h of usdValid) {
    const t = Math.floor(Date.parse(h.observedAt) / 60_000) * 60_000;
    byMinute.set(t, [...(byMinute.get(t) ?? []), { source: h.source, v: Number(h.priceUsd) }]);
  }
  const times = [...byMinute.keys()].sort((a, b) => a - b);
  const mid = new Map(times.map((t) => [t, median((byMinute.get(t) ?? []).map((x) => x.v))]));
  const counts = new Map<string, number>();
  for (const h of usdValid) counts.set(h.source, (counts.get(h.source) ?? 0) + 1);
  // Up to three sources (the categorical cap for one chart), the ones with the most valid quotes.
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([s]) => s);
  const deviation: Series[] = top.map((src, i) => ({
    name: src,
    slot: (i + 1) as 1 | 2 | 3,
    points: times.map((t) => {
      const q = byMinute.get(t)?.find((x) => x.source === src);
      const m = mid.get(t) ?? 0;
      return { t, v: q && m > 0 ? (q.v - m) / m : null };
    }),
  }));
  return (
    <>
      <PageHeader
        crumbs={[{ href: '/prices', label: 'Prices' }]}
        title={
          <>
            Price history <Token id={data.asset} />
          </>
        }
        lead={
          <>
            Median of the valid USD quotes per collector cycle, and how far each source sat from it.
            Asset <code>{data.asset}</code>.
          </>
        }
        meta={`${data.history.length} observations`}
      />
      <Section title="Median price (USD)">
        <div className="card">
          <LineChart
            unit="price"
            series={[
              {
                name: 'Median USD',
                slot: 1,
                points: times.map((t) => ({ t, v: mid.get(t) ?? null })),
              },
            ]}
          />
        </div>
      </Section>
      {top.length > 1 && (
        <Section
          title="Each source vs the median"
          note="Deviation from the median of that cycle, in % (0 = agrees). The quorum rule rejects sources more than the asset's limit apart."
        >
          <div className="card">
            <LineChart unit="pct" series={deviation} />
          </div>
        </Section>
      )}
      <Section title="All observations">
        <details className="table-view">
          <summary>{data.history.length} rows, every source, valid or not</summary>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Observed</th>
                  <th>Source</th>
                  <th className="num">Quote</th>
                  <th className="num">Confidence</th>
                  <th>Published</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {[...data.history]
                  .reverse()
                  .slice(0, 500)
                  .map((h) => (
                    <tr key={h.id}>
                      <td>{ts(h.observedAt)}</td>
                      <td>{h.source}</td>
                      <td className="num">
                        {h.priceUsd
                          ? (h.quoteCurrency ?? 'USD') === 'USD'
                            ? usd(h.priceUsd, 6)
                            : `${h.priceUsd} ${h.quoteCurrency}`
                          : '—'}
                      </td>
                      <td className="num">{h.confidence ?? '—'}</td>
                      <td className="dim">{ts(h.publishedAt)}</td>
                      <td data-tip={h.reason ?? h.status}>
                        <Status code={h.status} />
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
