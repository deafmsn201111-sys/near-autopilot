import { describe, expect, it } from 'vitest';
import {
  absBig,
  clampBig,
  divRound,
  formatUnits,
  isqrt,
  mulDiv,
  parseUnits,
  powWad,
  sqrtWad,
  WAD,
} from '../src';
import { forAll } from './support/prop';

describe('divRound', () => {
  // [numerator, divisor, floor, ceil, nearest]
  const table: Array<[bigint, bigint, bigint, bigint, bigint]> = [
    [7n, 2n, 3n, 4n, 4n],
    [-7n, 2n, -4n, -3n, -4n], // nearest: ties away from zero
    [5n, 3n, 1n, 2n, 2n],
    [4n, 3n, 1n, 2n, 1n],
    [-4n, 3n, -2n, -1n, -1n],
    [-5n, 3n, -2n, -1n, -2n],
    [6n, 3n, 2n, 2n, 2n],
    [-6n, 3n, -2n, -2n, -2n],
    [0n, 5n, 0n, 0n, 0n],
    [1n, 1_000_000_000_000n, 0n, 1n, 0n],
    [-1n, 1_000_000_000_000n, -1n, 0n, 0n],
  ];
  for (const [n, d, floor, ceil, nearest] of table) {
    it(`${n} / ${d}`, () => {
      expect(divRound(n, d, 'floor')).toBe(floor);
      expect(divRound(n, d, 'ceil')).toBe(ceil);
      expect(divRound(n, d, 'nearest')).toBe(nearest);
    });
  }

  it('rejects a non-positive divisor', () => {
    expect(() => divRound(1n, 0n, 'floor')).toThrow(RangeError);
    expect(() => divRound(1n, -1n, 'floor')).toThrow(RangeError);
  });

  it('property: floor <= exact <= ceil, they differ by at most 1, nearest is one of them', () => {
    forAll(
      {},
      (g) => ({ n: g.big(-(10n ** 40n), 10n ** 40n), d: g.bigBiased(1n, 10n ** 20n) }),
      ({ n, d }) => {
        const f = divRound(n, d, 'floor');
        const c = divRound(n, d, 'ceil');
        const r = divRound(n, d, 'nearest');
        expect(f * d <= n && n <= c * d).toBe(true);
        expect(c - f === 0n || c - f === 1n).toBe(true);
        expect(r === f || r === c).toBe(true);
        expect(absBig(r * d - n) * 2n <= d).toBe(true); // nearest is within half a unit
        expect((c === f) === (n % d === 0n)).toBe(true);
      },
    );
  });
});

describe('mulDiv', () => {
  it('keeps full precision where a double would not', () => {
    const big = 2n ** 200n + 12345n;
    expect(mulDiv(big, big, big, 'floor')).toBe(big);
    expect(mulDiv(10n ** 30n, 3n, 10n ** 30n)).toBe(3n);
  });
  it('property: floor <= ceil, and (a*b)/d identity when divisible', () => {
    forAll(
      {},
      (g) => ({
        a: g.bigBiased(0n, 10n ** 30n),
        b: g.bigBiased(0n, 10n ** 30n),
        d: g.bigBiased(1n, 10n ** 30n),
      }),
      ({ a, b, d }) => {
        expect(mulDiv(a, b, d, 'floor') <= mulDiv(a, b, d, 'ceil')).toBe(true);
        expect(mulDiv(a * d, b, d)).toBe(a * b);
      },
    );
  });
});

describe('isqrt / sqrtWad', () => {
  it('exact squares and neighbours', () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 18n, 2n ** 128n, 2n ** 200n + 1n]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
    expect(isqrt(10n ** 36n)).toBe(10n ** 18n);
    expect(isqrt(10n ** 36n - 1n)).toBe(10n ** 18n - 1n);
  });
  it('rejects negatives', () => expect(() => isqrt(-1n)).toThrow(RangeError));
  it('property: floor square root definition', () => {
    forAll(
      { runs: 500 },
      (g) => g.bigBiased(0n, 2n ** 300n),
      (n) => {
        const r = isqrt(n);
        expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
      },
    );
  });
  it('sqrtWad known values', () => {
    expect(sqrtWad(4n * WAD)).toBe(2n * WAD);
    expect(sqrtWad(WAD / 4n)).toBe(WAD / 2n);
    expect(sqrtWad(0n)).toBe(0n);
    expect(sqrtWad(2n * WAD)).toBe(1_414_213_562_373_095_048n); // sqrt(2) = 1.41421356237309504880...
  });
});

describe('powWad', () => {
  it('known values', () => {
    expect(powWad(2n * WAD, 10)).toBe(1024n * WAD);
    expect(powWad(WAD, 1000)).toBe(WAD);
    expect(powWad(5n * WAD, 0)).toBe(WAD);
    expect(powWad(WAD / 2n, 3)).toBe(WAD / 8n);
  });
  it('rejects bad exponents', () => {
    expect(() => powWad(WAD, -1)).toThrow(RangeError);
    expect(() => powWad(WAD, 1.5)).toThrow(RangeError);
  });
  it('property: pow(a, m+n) ~= pow(a,m) * pow(a,n) within rounding', () => {
    forAll(
      {},
      (g) => ({ a: g.big(WAD / 2n, 2n * WAD), m: g.int(0, 20), n: g.int(0, 20) }),
      ({ a, m, n }) => {
        const lhs = powWad(a, m + n);
        const rhs = (powWad(a, m) * powWad(a, n)) / WAD;
        // Each step rounds by <= 0.5e-18 relative, so allow a relative 1e-14 plus a few wei.
        expect(absBig(lhs - rhs) <= lhs / 10n ** 14n + 100n).toBe(true);
      },
    );
  });
});

describe('parseUnits / formatUnits', () => {
  it('parses exactly', () => {
    expect(parseUnits('1234.5678', 6)).toBe(1_234_567_800n);
    expect(parseUnits('-0.01', 2)).toBe(-1n);
    expect(parseUnits('0', 18)).toBe(0n);
    expect(parseUnits('100', 0)).toBe(100n);
    expect(parseUnits('0.000000000000000001', 18)).toBe(1n);
  });
  it('never rounds silently and rejects malformed text', () => {
    expect(() => parseUnits('0.0000001', 6)).toThrow('fractional digits');
    for (const bad of ['', '1e5', '1,5', '.5', '5.', '--1', 'abc', '1 2'])
      expect(() => parseUnits(bad, 6)).toThrow(RangeError);
  });
  it('formats exactly and trims zeros', () => {
    expect(formatUnits(1_234_567_800n, 6)).toBe('1234.5678');
    expect(formatUnits(-1n, 2)).toBe('-0.01');
    expect(formatUnits(0n, 18)).toBe('0');
    expect(formatUnits(5n, 0)).toBe('5');
    expect(formatUnits(10n ** 18n, 18)).toBe('1');
  });
  it('property: round trip', () => {
    forAll(
      {},
      (g) => ({ v: g.big(-(10n ** 40n), 10n ** 40n), d: g.int(0, 30) }),
      ({ v, d }) => {
        expect(parseUnits(formatUnits(v, d), d)).toBe(v);
      },
    );
  });
});

describe('clampBig', () => {
  it('clamps and validates', () => {
    expect(clampBig(5n, 0n, 3n)).toBe(3n);
    expect(clampBig(-5n, 0n, 3n)).toBe(0n);
    expect(clampBig(2n, 0n, 3n)).toBe(2n);
    expect(() => clampBig(1n, 3n, 0n)).toThrow(RangeError);
  });
});
