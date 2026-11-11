import { describe, expect, it } from 'vitest';
import { BoundedMap } from '../src/bounded-map';

describe('BoundedMap', () => {
  it('never holds more than its limit, dropping the least recently set key', () => {
    const m = new BoundedMap<string, number>(3);
    m.set('a', 1).set('b', 2).set('c', 3);
    m.set('a', 10);
    m.set('d', 4);
    expect(m.size).toBe(3);
    expect([...m.keys()]).toEqual(['c', 'a', 'd']);
    expect(m.get('a')).toBe(10);
  });

  it('rejects a limit below one', () => {
    expect(() => new BoundedMap(0)).toThrow(RangeError);
  });
});
