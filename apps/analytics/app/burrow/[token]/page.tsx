import { tryApi } from '../../../lib/api';
import { pct, ts, usd } from '../../../lib/format';

export const dynamic = 'force-dynamic';

interface History {
  token: string;
  history: {
    blockHeight: number;
    blockTimestamp: string;
    supplyApr: string | null;
    borrowApr: string | null;
    utilization: string | null;
    availableUsd: string | null;
    rewardApr: string | null;
    quality: string;
  }[];
}

export default async function MarketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { data, error } = await tryApi<History>(
    `/v1/analytics/burrow/markets/${encodeURIComponent(decodeURIComponent(token))}`,
  );
  if (!data) return <p className="bad">Market unavailable: {error}</p>;
  return (
    <>
      <h1>
        Burrow market <code>{data.token}</code>
      </h1>
      <p className="small dim">
        History of APR, utilisation, liquidity and rewards (last 30 days, one row per collector
        snapshot).
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th className="num">Block</th>
              <th className="num">Supply APR</th>
              <th className="num">Borrow APR</th>
              <th className="num">Utilisation</th>
              <th className="num">Available</th>
              <th className="num">Reward APR</th>
              <th>Quality</th>
            </tr>
          </thead>
          <tbody>
            {[...data.history].reverse().map((h) => (
              <tr key={h.blockHeight}>
                <td className="small">{ts(h.blockTimestamp)}</td>
                <td className="num">{h.blockHeight}</td>
                <td className="num">{pct(h.supplyApr)}</td>
                <td className="num">{pct(h.borrowApr)}</td>
                <td className="num">{pct(h.utilization, 1)}</td>
                <td className="num">{usd(h.availableUsd)}</td>
                <td className="num">{pct(h.rewardApr)}</td>
                <td>{h.quality}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
