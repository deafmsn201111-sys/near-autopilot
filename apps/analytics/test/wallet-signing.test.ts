import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Map() }));
import { walletSigningEnabled } from '../lib/wallet-signing';

describe('walletSigningEnabled', () => {
  it('is on only when MAINNET_WALLET_SIGNING=1', () => {
    expect(walletSigningEnabled({ MAINNET_WALLET_SIGNING: '1' })).toBe(true);
    expect(walletSigningEnabled({ MAINNET_WALLET_SIGNING: '0' })).toBe(false);
    expect(walletSigningEnabled({})).toBe(false);
  });

  it('ignores the removed PUBLIC_DEMO flag', () => {
    expect(walletSigningEnabled({ MAINNET_WALLET_SIGNING: '1', PUBLIC_DEMO: '1' })).toBe(true);
  });
});
