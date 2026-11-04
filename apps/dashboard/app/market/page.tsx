import { getMarketData, getPolicy } from '../../lib/api';
import { formatTimestamp } from '../../lib/format';

export const dynamic = 'force-dynamic';

const STATUS_TEXT: Record<string, string> = {
  corroborated: 'Corroborated (two providers agree)',
  single_source: 'Single source (flagged)',
  price_disputed: 'DISPUTED: excluded from decisions',
  unpriced: 'Unpriced',
};

const age = (ms: number | null) => (ms === null ? '—' : `${Math.round(ms / 1000)} s`);

export default async function MarketPage() {
  const [market, policy] = await Promise.all([getMarketData(), getPolicy()]);

  if (!market.enabled) {
    return (
      <>
        <h1>Market data</h1>
        <p className="lede">
          {policy.dataSource === 'simulation'
            ? 'Simulation uses fixed demo prices: no market data is fetched.'
            : `This deployment prices tokens from the Burrow oracle on ${policy.network} only; mainnet reference data is off.`}
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Market data</h1>
      <p className="provenance provenance-test" role="status">
        {market.flow}. Prices are read from MAINNET sources and applied to{' '}
        {market.executionNetwork.toUpperCase()} test tokens as REFERENCE prices: they do not confirm
        any value, liquidity or redeemability of the test tokens.
      </p>
      {market.error && (
        <p className="provenance provenance-unknown" role="alert">
          {market.error}
        </p>
      )}
      <p className="muted small">
        Fetched {market.fetchedAt ? formatTimestamp(market.fetchedAt) : '—'}. Priority: Pyth, then
        DefiLlama. Disputed or unpriced assets are excluded from every decision.
      </p>

      <section className="block" aria-labelledby="sources">
        <h2 id="sources">Sources</h2>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Network</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {market.sources.map((s) => (
              <tr key={s.source}>
                <td>{s.source}</td>
                <td>{market.marketNetwork}</td>
                <td>{s.health}</td>
                <td>{s.detail ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="block" aria-labelledby="assets">
        <h2 id="assets">Testnet asset → mainnet reference → price</h2>
        <table>
          <thead>
            <tr>
              <th>Testnet token</th>
              <th>Reference</th>
              <th>Price (USD)</th>
              <th>Status</th>
              <th>Source</th>
              <th>Age</th>
              <th>Spread</th>
              <th>24h range</th>
            </tr>
          </thead>
          <tbody>
            {market.assets.map((a) => (
              <tr key={a.testnetToken}>
                <td>{a.testnetToken}</td>
                <td>
                  {a.referenceSymbol}
                  <div className="muted small">{a.mainnetContract}</div>
                </td>
                <td>
                  {a.priceUsd ?? '—'}
                  {a.priceUsd && <div className="muted small">{a.label}</div>}
                </td>
                <td>
                  {STATUS_TEXT[a.status] ?? a.status}
                  {a.reason && <div className="muted small">{a.reason}</div>}
                </td>
                <td>
                  {a.source ?? '—'}
                  {a.sourceAssetId && <div className="muted small">{a.sourceAssetId}</div>}
                </td>
                <td>{age(a.ageMs)}</td>
                <td>{a.spreadBps === null ? '—' : `${a.spreadBps} bps`}</td>
                <td>{a.range24hBps === null ? '—' : `${a.range24hBps} bps`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="block" aria-labelledby="observations">
        <h2 id="observations">Every observation</h2>
        <table>
          <thead>
            <tr>
              <th>Testnet token</th>
              <th>Source / id</th>
              <th>Price</th>
              <th>Published</th>
              <th>Age</th>
              <th>Confidence</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {market.assets.flatMap((a) =>
              a.observations.map((o) => (
                <tr key={`${a.testnetToken}:${o.source}:${o.assetId}`}>
                  <td>{a.testnetToken}</td>
                  <td>
                    {o.source} ({o.network})<div className="muted small">{o.assetId}</div>
                  </td>
                  <td>{o.priceUsd ?? '—'}</td>
                  <td>{o.publishedAt ? formatTimestamp(o.publishedAt) : '—'}</td>
                  <td>{age(o.ageMs)}</td>
                  <td>{o.confidence ?? '—'}</td>
                  <td>
                    {o.status}
                    {o.reason && <div className="muted small">{o.reason}</div>}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
