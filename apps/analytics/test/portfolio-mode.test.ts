import { describe, expect, it } from 'vitest';
import { isAccountView, portfolioMode } from '../lib/portfolio-mode';

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
    expect(m.kind).not.toBe('mine');
  });

  it('a typed account without a wallet is read-only, prepare only', () => {
    const m = portfolioMode(base);
    expect(m.label).toBe('Mainnet account · read-only');
    expect(m.note).toMatch(/prepare/i);
    expect(m.note).not.toMatch(/AI analysis available/);
    expect(m.kind).not.toBe('mine');
  });

  it('a typed account that is not the connected wallet is read-only and never says "Your wallet"', () => {
    const m = portfolioMode({ ...base, connected: 'bob.near' });
    expect(m.label).toBe('Mainnet account · read-only');
    expect(m.kind).toBe('readonly');
    expect(m.label).not.toMatch(/Your wallet/);
    expect(m.kind).not.toBe('mine');
  });

  it('names the context the strip shows: demo, read-only or your wallet', () => {
    expect(portfolioMode({ ...base, isAccount: false, account: '' }).kind).toBe('demo');
    expect(portfolioMode(base).kind).toBe('readonly');
    expect(portfolioMode({ ...base, connected: 'alice.near' }).kind).toBe('mine');
  });

  it('points back to the connected wallet only while viewing another account (#195)', () => {
    expect(portfolioMode({ ...base, connected: 'bob.near' }).backTo).toBe('bob.near');
    expect(portfolioMode(base).backTo).toBeNull();
    expect(portfolioMode({ ...base, connected: 'alice.near' }).backTo).toBeNull();
    expect(portfolioMode({ ...base, isAccount: false, connected: 'bob.near' }).backTo).toBeNull();
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
    expect(m.kind).toBe('mine');
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
    expect(m.kind).toBe('mine');
  });
});

describe('portfolioMode on an older read', () => {
  it('says the read is old instead of promising signing', async () => {
    const { portfolioMode } = await import('../lib/portfolio-mode');
    const m = portfolioMode({
      isAccount: true,
      account: 'alice.near',
      connected: 'alice.near',
      verified: false,
      signingEnabled: true,
      stale: true,
    });
    expect(m.note).toMatch(/^Showing an older read/);
  });
});

describe('isAccountView', () => {
  it('opens the connected wallet, not a demo, on the bare portfolio page', () => {
    expect(isAccountView(undefined, '', 'alice.near')).toBe(true);
    expect(isAccountView(undefined, '', '')).toBe(false);
  });

  it('opens an account named in the link without p=account', () => {
    expect(isAccountView(undefined, 'autopilot-test.near', '')).toBe(true);
  });

  it('keeps an explicitly chosen demo and an explicit account view', () => {
    expect(isAccountView('demo-5000', '', 'alice.near')).toBe(false);
    expect(isAccountView('account', '', '')).toBe(true);
  });
});
