import { describe, expect, it } from 'vitest';
import { signedMoney } from '../lib/format';

describe('signedMoney', () => {
  it('shows a value that rounds to $0.00 neutral, without a sign', () => {
    expect(signedMoney(-0.003)).toEqual({ text: '$0.00', tone: '' });
    expect(signedMoney(0.004)).toEqual({ text: '$0.00', tone: '' });
  });

  it('colours a cent or more by its sign', () => {
    expect(signedMoney(-0.01)).toEqual({ text: '−$0.01', tone: 'neg' });
    expect(signedMoney(-0.005)).toEqual({ text: '−$0.01', tone: 'neg' });
    expect(signedMoney(1.5)).toEqual({ text: '+$1.50', tone: 'pos' });
  });

  it('shows a dash for no value', () => {
    expect(signedMoney(null)).toEqual({ text: '—', tone: '' });
  });
});
