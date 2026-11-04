import Link from 'next/link';
import { tryApi } from '../../lib/api';
import { shortToken, tone, ts, usd } from '../../lib/format';
import type { PriceObs, PriceRow } from '../../lib/types';

export const dynamic = 'force-dynamic';

const price = (o: PriceObs | null) =>
  o?.priceUsd ? usd(o.priceUsd, Number(o.priceUsd) < 10 ? 6 : 2) : '—';
const ageS = (o: PriceObs | null) =>
  o?.ageMs === null || o?.ageMs === undefined ? '—' : `${Math.round(o.ageMs / 1000)} s`;

export default async function PricesPage() {
  const { data, error } = await tryApi<{
    snapshot: { id: string; blockHeight: number; takenAt: string } | null;
    assets: PriceRow[];
  }>('/v1/analytics/prices');
  if (!data) return <p className="bad">Analytics API unavailable: {error}</p>;
  const curated = data.assets.filter((a) => a.curated);
  const tail = data.assets.filter((a) => !a.curated);
  const Row = ({ a }: { a: PriceRow }) => (
    <tr>
      <td>
        <Link href={`/prices/${encodeURIComponent(a.asset)}`}>
          <code>{shortToken(a.asset)}</code>
        </Link>
      </td>
      <td className="num">{price(a.pyth)}</td>
      <td className={`small ${tone(a.pyth?.status)}`}>
        {a.pyth ? `${a.pyth.status}${a.pyth.reason ? `: ${a.pyth.reason}` : ''}` : 'no feed'}
      </td>
      <td className="num">{price(a.defillama)}</td>
      <td className="small">
        {a.defillama ? `${a.defillama.status} (conf ${a.defillama.confidence ?? '—'})` : '—'}
      </td>
      <td className="num">
        {a.divergenceBps === null ? '—' : `${(a.divergenceBps / 100).toFixed(2)} %`}
      </td>
      <td className="small">{ts(a.defillama?.publishedAt ?? a.pyth?.publishedAt)}</td>
      <td className="num">{ageS(a.defillama ?? a.pyth)}</td>
      <td className={tone(a.status)}>{a.status}</td>
    </tr>
  );
  const head = (
    <thead>
      <tr>
        <th>Asset</th>
        <th className="num">Pyth</th>
        <th>Pyth status</th>
        <th className="num">DefiLlama</th>
        <th>DefiLlama status</th>
        <th className="num">Divergence</th>
        <th>Published</th>
        <th className="num">Age</th>
        <th>Check</th>
      </tr>
    </thead>
  );
  return (
    <>
      <h1>Price Intelligence</h1>
      <p className="small">
        Snapshot #{data.snapshot?.blockHeight ?? '—'} taken {ts(data.snapshot?.takenAt)}. Each
        source is stored separately; a missing price is never 0 and the more favourable source is
        never picked automatically. Divergence above the asset limit is LOW_CONFIDENCE; one source
        only is SINGLE_SOURCE.
      </p>
      <section className="block">
        <h2>Curated assets (Pyth + DefiLlama)</h2>
        <table>
          {head}
          <tbody>
            {curated.map((a) => (
              <Row key={a.asset} a={a} />
            ))}
          </tbody>
        </table>
      </section>
      <section className="block">
        <h2>Long-tail tokens (DefiLlama only; below 0.9 confidence = discovery only)</h2>
        <div className="scroll">
          <table>
            {head}
            <tbody>
              {tail.map((a) => (
                <Row key={a.asset} a={a} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
