import { tryApi } from '../../../lib/api';
import { ts, usd } from '../../../lib/format';

export const dynamic = 'force-dynamic';

interface History {
  asset: string;
  history: {
    id: string;
    source: string;
    priceUsd: string | null;
    confidence: string | null;
    publishedAt: string | null;
    observedAt: string;
    status: string;
    reason: string | null;
  }[];
}

export default async function AssetPage({ params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  const { data, error } = await tryApi<History>(
    `/v1/analytics/prices/${encodeURIComponent(decodeURIComponent(asset))}`,
  );
  if (!data) return <p className="bad">Asset unavailable: {error}</p>;
  return (
    <>
      <h1>
        Price history <code>{data.asset}</code>
      </h1>
      <table>
        <thead>
          <tr>
            <th>Observed</th>
            <th>Source</th>
            <th className="num">USD</th>
            <th>Confidence</th>
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
                <td className="small">{ts(h.observedAt)}</td>
                <td>{h.source}</td>
                <td className="num">{h.priceUsd ? usd(h.priceUsd, 6) : '—'}</td>
                <td>{h.confidence ?? '—'}</td>
                <td className="small">{ts(h.publishedAt)}</td>
                <td className="small">
                  {h.status}
                  {h.reason ? `: ${h.reason}` : ''}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </>
  );
}
