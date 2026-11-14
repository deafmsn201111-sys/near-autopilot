import { describe, expect, it } from 'vitest';
import { curatedId, iconView } from '../lib/token-label';

describe('curatedId', () => {
  it('finds the curated contract of a demo symbol, native NEAR as "near"', () => {
    expect(curatedId('NEAR')).toBe('near');
    expect(curatedId('wNEAR')).toBe('wrap.near');
    expect(curatedId('USDC')).toBe(
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    );
    expect(curatedId('PEPE')).toBeUndefined();
  });
});

describe('iconView', () => {
  it('shows a checked logo as an image', () => {
    expect(iconView('data:image/png;base64,AAAA', 'USDC')).toEqual({
      src: 'data:image/png;base64,AAAA',
    });
  });

  it('falls back to the first letter for a missing, unsafe or broken logo', () => {
    expect(iconView(null, 'usdc')).toEqual({ letter: 'U' });
    expect(iconView(undefined, 'wNEAR')).toEqual({ letter: 'W' });
    expect(iconView('data:text/html,<script>alert(1)</script>', 'EVIL')).toEqual({ letter: 'E' });
    expect(iconView('https://evil.example/x.png', 'X')).toEqual({ letter: 'X' });
    expect(iconView('data:image/png;base64,AAAA', 'USDC', true)).toEqual({ letter: 'U' });
    expect(iconView(null, '')).toEqual({ letter: '?' });
  });
});
