/**
 * Testnet asset -> mainnet reference asset -> price sources. Every identifier here was checked against the live
 * source on 2026-11-04 (see docs/market-data.md):
 *  - testnet: ft_metadata of each token on rpc.testnet.near.org (symbol, decimals);
 *  - Pyth: GET hermes.pyth.network/v2/price_feeds?query=..&asset_type=crypto (feed id <-> symbol, quote USD);
 *  - DefiLlama: GET coins.llama.fi/prices/current/<keys> (symbol, decimals of the mainnet contract).
 *
 * The testnet tokens are TEST tokens with no market: a mainnet price applied to them is a REFERENCE price for exercising
 * the decision logic, never their value, liquidity or redeemability. An asset not listed here stays unpriced.
 * The mapping is re-validated at run time: testnet decimals must equal `testnetDecimals` and the mainnet contract's
 * decimals reported by DefiLlama must equal `mainnetDecimals`, otherwise the asset is refused.
 */
export interface ReferenceAsset {
  /** Testnet token contract the price is applied to. */
  readonly testnetToken: string;
  readonly testnetSymbol: string;
  readonly testnetDecimals: number;
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
  readonly note: string;
}

export const REFERENCE_ASSETS: readonly ReferenceAsset[] = [
  {
    testnetToken: 'wrap.testnet',
    testnetSymbol: 'wNEAR',
    testnetDecimals: 24,
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
    note: 'wrap.testnet wraps testnet NEAR 1:1, which has no market value; priced as mainnet NEAR for analysis only',
  },
  {
    testnetToken: 'usdt.fakes.testnet',
    testnetSymbol: 'USDT.e',
    testnetDecimals: 6,
    reference: {
      symbol: 'USDT.e',
      mainnetContract: 'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near',
      mainnetDecimals: 6,
    },
    pyth: {
      feedId: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
      symbol: 'Crypto.USDT/USD',
    },
    defillama: [
      { key: 'coingecko:tether', symbol: 'USDT', decimals: null },
      {
        key: 'near:dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near',
        symbol: 'USDT.e',
        decimals: 6,
      },
    ],
    maxDeviationBps: 100,
    note: 'a freely minted test token named after bridged USDT; priced as USDT for analysis only',
  },
  {
    testnetToken: 'usdc.fakes.testnet',
    testnetSymbol: 'USDC.e',
    testnetDecimals: 6,
    reference: {
      symbol: 'USDC.e',
      mainnetContract: 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near',
      mainnetDecimals: 6,
    },
    pyth: {
      feedId: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
      symbol: 'Crypto.USDC/USD',
    },
    defillama: [
      { key: 'coingecko:usd-coin', symbol: 'USDC', decimals: null },
      {
        key: 'near:a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near',
        symbol: 'USDC.e',
        decimals: 6,
      },
    ],
    maxDeviationBps: 100,
    note: 'a freely minted test token named after bridged USDC; priced as USDC for analysis only',
  },
];

export const referenceAssetFor = (token: string): ReferenceAsset | undefined =>
  REFERENCE_ASSETS.find((a) => a.testnetToken === token);
