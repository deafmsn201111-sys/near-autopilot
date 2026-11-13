import { CURATED } from './token-label';

/** Locally stored logos for contracts in the curated token list. Unknown contracts deliberately get no logo. */
const CURATED_TOKEN_ICONS: Readonly<Record<string, string>> = {
  'wrap.near': '/token-icons/near.jpg',
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1':
    '/token-icons/usdc-native.svg',
  'usdt.tether-token.near': '/token-icons/usdt-native.svg',
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near': '/token-icons/usdc-bridged.svg',
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near': '/token-icons/usdt-bridged.svg',
  '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near': '/token-icons/dai-bridged.svg',
  '2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near': '/token-icons/wbtc-bridged.svg',
  '853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near': '/token-icons/frax-bridged.svg',
  'aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near': '/token-icons/aurora-bridged.svg',
  aurora: '/token-icons/eth-aurora.png',
  'eth.bridge.near': '/token-icons/eth-omft.png',
  'zec.omft.near': '/token-icons/zec-omft.svg',
  'nbtc.bridge.near': '/token-icons/nbtc-bridged.svg',
  'token.v2.ref-finance.near': '/token-icons/ref.svg',
  'token.rhealab.near': '/token-icons/rhea.png',
  'meta-pool.near': '/token-icons/stnear.svg',
  'linear-protocol.near': '/token-icons/linear.svg',
  'token.burrow.near': '/token-icons/brrr.png',
};

export function tokenIcon(token: string | undefined, symbol: string): string | null {
  if (token) return CURATED[token] ? (CURATED_TOKEN_ICONS[token] ?? null) : null;
  // Native NEAR is not an NEP-141 contract, so its trusted identity has no token id.
  return symbol.toUpperCase() === 'NEAR' ? '/token-icons/near.jpg' : null;
}
