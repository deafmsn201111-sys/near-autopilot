import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY,
  STRATEGIES,
  STRATEGY_IDS,
  rememberStrategy,
  savedStrategy,
  strategyOf,
  strategySchema,
} from '../src/strategy';

describe('strategy presets', () => {
  it('Balanced keeps the thresholds the product used before presets', () => {
    expect(DEFAULT_STRATEGY).toBe('balanced');
    expect(STRATEGIES.balanced).toMatchObject({
      healthyAt: 1.5,
      targetHealthFactor: 1.6,
      warningBelow: 1.3,
      concentrationInfoPct: 60,
      concentrationWarningPct: 85,
      concentrationTargetPct: 50,
    });
  });

  it.each(STRATEGY_IDS)('%s orders its lines so a repay never re-triggers the card', (id) => {
    const s = STRATEGIES[id];
    expect(s.targetHealthFactor).toBeGreaterThan(s.healthyAt);
    expect(s.healthyAt).toBeGreaterThan(s.warningBelow);
    expect(s.warningBelow).toBeGreaterThan(1.1);
    expect(s.concentrationTargetPct).toBeLessThan(s.concentrationInfoPct);
    expect(s.concentrationInfoPct).toBeLessThan(s.concentrationWarningPct);
  });

  it('Conservative is stricter than Aggressive on every line', () => {
    const [c, a] = [STRATEGIES.conservative, STRATEGIES.aggressive];
    expect(c.healthyAt).toBeGreaterThan(a.healthyAt);
    expect(c.concentrationInfoPct).toBeLessThan(a.concentrationInfoPct);
  });

  it('the request schema defaults to Balanced and rejects unknown names', () => {
    expect(strategySchema.parse(undefined)).toBe('balanced');
    expect(strategySchema.safeParse('yolo').success).toBe(false);
  });

  it('strategyOf reads a URL or cookie value leniently', () => {
    expect(strategyOf('aggressive')).toBe('aggressive');
    expect(strategyOf(['conservative'])).toBe('balanced');
    expect(strategyOf('nope')).toBe('balanced');
    expect(strategyOf(undefined)).toBe('balanced');
  });

  it('remembers one choice per account in a single bounded cookie value', () => {
    let v = rememberStrategy(undefined, 'alice.near', 'aggressive');
    v = rememberStrategy(v, 'bob.near', 'conservative');
    expect(savedStrategy(v, 'alice.near')).toBe('aggressive');
    expect(savedStrategy(v, 'bob.near')).toBe('conservative');
    expect(savedStrategy(v, 'carol.near')).toBeUndefined();
    for (let i = 0; i < 50; i++) v = rememberStrategy(v, `a${i}.near`, 'aggressive');
    expect(savedStrategy(v, 'alice.near')).toBeUndefined();
    expect(savedStrategy(v, 'a49.near')).toBe('aggressive');
    expect(v.length).toBeLessThan(1_500);
  });

  it('reads a tampered cookie as nothing saved', () => {
    expect(savedStrategy('not json', 'alice.near')).toBeUndefined();
    expect(savedStrategy('{"alice.near":"yolo"}', 'alice.near')).toBeUndefined();
    expect(savedStrategy('{"__proto__":"aggressive"}', '__proto__')).toBeUndefined();
  });
});
