import { describe, expect, it } from 'vitest';
import { portfolioMode } from '../lib/portfolio-mode';

const base = {
  isAccount: true,
  account: 'alice.near',
  connected: '',
  verified: false,
  signingEnabled: true,
};

describe('portfolioMode', () => {
  it('demo portfolio is simulated', () => {
    const m = portfolioMode({ ...base, isAccount: false, account: '' });
    expect(m.label).toBe('Demo portfolio · simulated');
    expect(m.mine).toBe(false);
  });

  it('a typed account without a wallet is read-only, prepare only', () => {
    const m = portfolioMode(base);
    expect(m.label).toBe('Mainnet account · read-only');
    expect(m.note).toMatch(/prepare/i);
    expect(m.note).not.toMatch(/AI analysis available/);
    expect(m.mine).toBe(false);
  });

  it('a typed account that is not the connected wallet says so and never says "Your wallet"', () => {
    const m = portfolioMode({ ...base, connected: 'bob.near' });
    expect(m.label).toBe('Mainnet account · read-only');
    expect(m.note).toMatch(/not your connected wallet \(bob\.near\)/);
    expect(m.label).not.toMatch(/Your wallet/);
    expect(m.mine).toBe(false);
  });

  it('a verified account viewed without its wallet stays read-only but keeps AI analysis', () => {
    const m = portfolioMode({ ...base, connected: 'bob.near', verified: true });
    expect(m.label).toBe('Mainnet account · read-only');
    expect(m.note).toMatch(/AI analysis available/);
  });

  it('a typed account with signing off on this server does not promise signing', () => {
    const m = portfolioMode({ ...base, signingEnabled: false });
    expect(m.note).toMatch(/signing is off/i);
    expect(m.note).not.toMatch(/signs in their own wallet/);
  });

  it('the connected wallet, not verified', () => {
    const m = portfolioMode({ ...base, connected: 'alice.near' });
    expect(m.label).toBe('Your wallet');
    expect(m.note).toMatch(/prepare and sign/i);
    expect(m.note).toMatch(/verify ownership/i);
    expect(m.mine).toBe(true);
  });

  it('the connected wallet does not point to a verify step when the ownership state is unknown', () => {
    const m = portfolioMode({ ...base, connected: 'alice.near', verified: null });
    expect(m.label).toBe('Your wallet');
    expect(m.note).not.toMatch(/verify ownership/i);
  });

  it('the connected wallet with signing off on this server is prepare only', () => {
    const m = portfolioMode({ ...base, connected: 'alice.near', signingEnabled: false });
    expect(m.label).toBe('Your wallet');
    expect(m.note).not.toMatch(/sign in your wallet/i);
    expect(m.note).toMatch(/signing is off/i);
  });

  it('the connected wallet with ownership verified', () => {
    const m = portfolioMode({ ...base, connected: 'alice.near', verified: true });
    expect(m.label).toBe('Your wallet · ownership verified');
    expect(m.note).toMatch(/AI analysis available/);
    expect(m.mine).toBe(true);
  });
});
