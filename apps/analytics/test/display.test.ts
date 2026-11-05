import { describe, expect, it } from 'vitest';
import { poolName, statusOf } from '../lib/format';
import { label, nearblocks } from '../lib/token-label';

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

describe('token labels (symbols are untrusted)', () => {
  it('curated contracts get their curated symbol, verified', () => {
    expect(label(USDC, new Map([[USDC, 'anything']]))).toMatchObject({
      symbol: 'USDC',
      verified: true,
      impersonates: false,
    });
    expect(label('wrap.near', new Map())).toMatchObject({ symbol: 'wNEAR', verified: true });
  });

  it('another contract reporting a curated symbol is flagged as an impersonation', () => {
    expect(label('usdc.scam.near', new Map([['usdc.scam.near', 'usdc']]))).toMatchObject({
      symbol: 'usdc',
      verified: false,
      impersonates: true,
    });
  });

  it('unknown symbols are shown unverified; no metadata falls back to a shortened contract id', () => {
    expect(
      label('blackdragon.tkn.near', new Map([['blackdragon.tkn.near', 'BLACKDRAGON']])),
    ).toMatchObject({
      symbol: 'BLACKDRAGON',
      verified: false,
      impersonates: false,
      unknown: false,
    });
    expect(
      label('853d955acef822db058eb8505911ed77f175b99f.factory.bridge.near', new Map()),
    ).toMatchObject({
      symbol: '853d955a…e.near',
      unknown: true,
    });
  });

  it('control characters are stripped and length is capped', () => {
    const t = label('x.near', new Map([['x.near', `AB\u0000C\u0007D${'Z'.repeat(40)}`]]));
    expect(t.symbol).toBe(`ABCD${'Z'.repeat(20)}`);
  });

  it('links to the token on NearBlocks', () => {
    expect(nearblocks('wrap.near')).toBe('https://nearblocks.io/token/wrap.near');
  });
});

describe('display helpers', () => {
  it('pool names', () => {
    expect(poolName('v1:4512')).toBe('#4512');
    expect(poolName(`dcl:${USDC}|token.rhealab.near|100`)).toBe('DCL 0.01%');
    expect(poolName('dcl:a|b|2000')).toBe('DCL 0.20%');
  });

  it('status codes map to an icon kind and a readable label', () => {
    expect(statusOf('LP_SIMULATION_ELIGIBLE')).toEqual({
      kind: 'good',
      label: 'LP simulation eligible',
    });
    expect(statusOf('DATA_INVALID').kind).toBe('critical');
    expect(statusOf('LOW_CONFIDENCE').kind).toBe('warning');
    expect(statusOf('UNPRICED').kind).toBe('serious');
    expect(statusOf(null)).toEqual({ kind: 'neutral', label: 'unknown' });
  });
});
