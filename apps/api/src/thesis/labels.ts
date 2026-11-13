const KNOWN: Readonly<Record<string, string>> = {
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': 'USDC',
  'usdt.tether-token.near': 'USDt',
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near': 'USDT.e',
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near': 'USDC.e',
  '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near': 'DAI',
  '2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near': 'WBTC',
  'aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near': 'AURORA',
  '853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near': 'FRAX',
  'zec.omft.near': 'ZEC',
  'wrap.near': 'wNEAR',
  aurora: 'ETH (aurora)',
  'token.v2.ref-finance.near': 'REF',
  'token.rhealab.near': 'RHEA',
  'meta-pool.near': 'stNEAR',
  'linear-protocol.near': 'LiNEAR',
  near: 'NEAR',
};

/** USD stablecoins: never a concentration risk. */
export const STABLES: ReadonlySet<string> = new Set([
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  'usdt.tether-token.near',
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near',
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near',
  '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near',
  '853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near',
]);

/** Labels for the pools' other token: the account id, shortened where it is a bridge address. */
export function tokenLabel(id: string): string {
  if (KNOWN[id]) return KNOWN[id];
  const head = id.split('.')[0] ?? id;
  return head.length > 18 ? `${head.slice(0, 8)}…` : head;
}

/** What the LLM calls a token: our own name for it, else its contract id (shortened when long), never its ft_metadata. */
export function modelTokenLabel(id: string): string {
  return KNOWN[id] ?? (id.length > 20 ? `${id.slice(0, 12)}…` : id);
}

/** Tokens on our own curated list (beside Burrow's): a token outside both is shown as "Unverified". */
export const isKnownToken = (id: string): boolean => id in KNOWN;
