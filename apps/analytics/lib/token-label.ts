/**
 * Token labels. The symbol a token contract reports (`ft_metadata`) is UNTRUSTED: any contract can call itself "USDC".
 * So only the contracts below are marked verified (curated by this project, mainnet ids checked by hand). A token
 * that reports one of these symbols from another contract is flagged as an impersonation.
 */
export const CURATED: Readonly<Record<string, { symbol: string; name: string }>> = {
  'wrap.near': { symbol: 'wNEAR', name: 'Wrapped NEAR' },
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': {
    symbol: 'USDC',
    name: 'USD Coin (native)',
  },
  'usdt.tether-token.near': { symbol: 'USDt', name: 'Tether USD (native)' },
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near': {
    symbol: 'USDC.e',
    name: 'USD Coin (Rainbow bridge)',
  },
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near': {
    symbol: 'USDT.e',
    name: 'Tether USD (Rainbow bridge)',
  },
  '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near': {
    symbol: 'DAI',
    name: 'Dai (Rainbow bridge)',
  },
  '2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near': {
    symbol: 'WBTC',
    name: 'Wrapped BTC (Rainbow bridge)',
  },
  '853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near': {
    symbol: 'FRAX',
    name: 'Frax (Rainbow bridge)',
  },
  'aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near': {
    symbol: 'AURORA',
    name: 'Aurora (Rainbow bridge)',
  },
  aurora: { symbol: 'ETH', name: 'Ether (Aurora bridge)' },
  'eth.bridge.near': { symbol: 'ETH', name: 'Ether (Omni bridge)' },
  'zec.omft.near': { symbol: 'ZEC', name: 'Zcash (Omni bridge)' },
  'nbtc.bridge.near': { symbol: 'nBTC', name: 'NEAR BTC bridge' },
  'token.v2.ref-finance.near': { symbol: 'REF', name: 'Ref Finance' },
  'token.rhealab.near': { symbol: 'RHEA', name: 'Rhea' },
  'meta-pool.near': { symbol: 'stNEAR', name: 'Meta Pool staked NEAR' },
  'linear-protocol.near': { symbol: 'LiNEAR', name: 'LiNEAR staked NEAR' },
  'token.burrow.near': { symbol: 'BRRR', name: 'Burrow' },
};

export interface TokenLabel {
  readonly id: string;
  readonly symbol: string;
  readonly name: string | null;
  readonly verified: boolean;
  /** Reports a curated symbol from a different contract. */
  readonly impersonates: boolean;
  /** No metadata stored yet: the label is a shortened contract id. */
  readonly unknown: boolean;
}

const CURATED_SYMBOLS = new Set(Object.values(CURATED).map((c) => c.symbol.toUpperCase()));

const short = (id: string) => (id.length > 22 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

export function label(id: string, onChain: ReadonlyMap<string, string>): TokenLabel {
  const curated = CURATED[id];
  if (curated)
    return {
      id,
      symbol: curated.symbol,
      name: curated.name,
      verified: true,
      impersonates: false,
      unknown: false,
    };
  const symbol = onChain.get(id)?.trim();
  if (!symbol)
    return {
      id,
      symbol: short(id),
      name: null,
      verified: false,
      impersonates: false,
      unknown: true,
    };
  // Untrusted text: drop control characters (code points below 32 and 127), cap the length.
  const clean = [...symbol]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 32 && c !== 127;
    })
    .join('')
    .slice(0, 24);
  return {
    id,
    symbol: clean,
    name: null,
    verified: false,
    impersonates: CURATED_SYMBOLS.has(clean.toUpperCase()),
    unknown: false,
  };
}

export const nearblocks = (id: string) => `https://nearblocks.io/token/${encodeURIComponent(id)}`;

/**
 * Makes stored free text readable: curated token ids (full, or shortened as `<first 12>…`) become their symbols, and
 * pool keys `v1:N` become `#N`. Display only; the stored text is unchanged.
 */
export function humanize(text: string): string {
  let out = text;
  for (const [id, c] of Object.entries(CURATED)) {
    out = out.split(id).join(c.symbol);
    if (id.length > 20) out = out.split(`${id.slice(0, 12)}…`).join(c.symbol);
  }
  return out.replace(/\bv1:(\d+)/g, '#$1');
}
