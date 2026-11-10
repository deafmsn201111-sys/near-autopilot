/**
 * Mainnet token -> price sources. Every identifier here was checked against the live source (see
 * docs/mainnet-shadow.md):
 *  - Pyth: GET hermes.pyth.network/v2/price_feeds?query=..&asset_type=crypto (feed id <-> symbol, quote USD);
 *  - DefiLlama: GET coins.llama.fi/prices/current/<keys> (symbol, decimals of the mainnet contract).
 *
 * An asset not listed here stays unpriced. The mapping is re-validated at run time: the token's ft_metadata decimals
 * must equal `decimals` and the decimals reported by DefiLlama must equal `mainnetDecimals`, otherwise the asset is
 * refused.
 */
export interface ReferenceAsset {
  /** Token contract the price is applied to. */
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  /** What it stands in for on mainnet. */
  readonly reference: {
    readonly symbol: string;
    readonly mainnetContract: string;
    readonly mainnetDecimals: number;
  };
  /** Pyth feed (USD quote). Null if Pyth has no feed for it. */
  readonly pyth: { readonly feedId: string; readonly symbol: string } | null;
  /** DefiLlama coin keys, in priority order. */
  readonly defillama: readonly {
    readonly key: string;
    readonly symbol: string;
    readonly decimals: number | null;
  }[];
  /** Sources further apart than this make the asset `price_disputed`. */
  readonly maxDeviationBps: number;
  /** Exchange last-trade markets (public, no key). A USDT quote is converted with the corroborated USDT/USD price. */
  readonly exchanges?: readonly ExchangeMarket[];
  /** Stricter resolution: see AssetPriceStatus. */
  readonly quorum?: { readonly min: number; readonly maxDeviationBps: number };
  /** This asset's corroborated price converts other assets' quotes in this currency to USD. */
  readonly convertsQuote?: 'USDT';
  readonly note: string;
}

export interface ExchangeMarket {
  readonly source: 'coinbase' | 'kraken' | 'binance';
  /** Coinbase product id, Kraken pair, Binance symbol. */
  readonly symbol: string;
  readonly quote: 'USD' | 'USDT';
}

/**
 * NEAR/USD from three exchanges besides the oracles. Checked on 2026-11-05 (no key): Coinbase
 * /products/NEAR-USD/ticker, Kraken /0/public/Trades?pair=NEARUSD, Binance /api/v3/trades?symbol=NEARUSDT.
 * Quorum: 2 providers within 150 bps of their median, each at most 180 s old.
 */
const NEAR_EXCHANGES: readonly ExchangeMarket[] = [
  { source: 'coinbase', symbol: 'NEAR-USD', quote: 'USD' },
  { source: 'kraken', symbol: 'NEARUSD', quote: 'USD' },
  { source: 'binance', symbol: 'NEARUSDT', quote: 'USDT' },
];
const NEAR_QUORUM = { min: 2, maxDeviationBps: 150 } as const;

export const referenceAssetFor = (token: string): ReferenceAsset | undefined =>
  MAINNET_ASSETS.find((a) => a.token === token);

/**
 * MAINNET tokens priced as themselves, for the read-only shadow analysis (DATA_SOURCE=simulation with
 * MARKET_DATA=mainnet-live): the demo portfolio holds these ids, nothing is executed. Decimals are re-read from mainnet ft_metadata at run time.
 * Checked on 2026-11-05: ft_metadata (wNEAR 24, USDt 6, USDC 6), DefiLlama keys (coingecko:* confidence 0.999; the
 * near:<contract> keys report confidence 0.7 and are rejected as low confidence).
 */
const NATIVE_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const MAINNET_ASSETS: readonly ReferenceAsset[] = [
  {
    token: 'wrap.near',
    symbol: 'wNEAR',
    decimals: 24,
    reference: { symbol: 'NEAR', mainnetContract: 'wrap.near', mainnetDecimals: 24 },
    pyth: {
      feedId: 'c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750',
      symbol: 'Crypto.NEAR/USD',
    },
    defillama: [
      { key: 'coingecko:near', symbol: 'NEAR', decimals: null },
      { key: 'near:wrap.near', symbol: 'wNEAR', decimals: 24 },
    ],
    maxDeviationBps: 200,
    exchanges: NEAR_EXCHANGES,
    quorum: NEAR_QUORUM,
    note: 'mainnet wNEAR, priced as NEAR',
  },
  {
    token: 'usdt.tether-token.near',
    symbol: 'USDt',
    decimals: 6,
    reference: { symbol: 'USDT', mainnetContract: 'usdt.tether-token.near', mainnetDecimals: 6 },
    pyth: {
      feedId: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
      symbol: 'Crypto.USDT/USD',
    },
    defillama: [
      { key: 'coingecko:tether', symbol: 'USDT', decimals: null },
      { key: 'near:usdt.tether-token.near', symbol: 'USDt', decimals: 6 },
    ],
    maxDeviationBps: 100,
    convertsQuote: 'USDT',
    note: 'native USDt on NEAR mainnet',
  },
  {
    token: NATIVE_USDC,
    symbol: 'USDC',
    decimals: 6,
    reference: { symbol: 'USDC', mainnetContract: NATIVE_USDC, mainnetDecimals: 6 },
    pyth: {
      feedId: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
      symbol: 'Crypto.USDC/USD',
    },
    defillama: [
      { key: 'coingecko:usd-coin', symbol: 'USDC', decimals: null },
      { key: `near:${NATIVE_USDC}`, symbol: 'USDC', decimals: 6 },
    ],
    maxDeviationBps: 100,
    note: 'native USDC on NEAR mainnet',
  },
];
