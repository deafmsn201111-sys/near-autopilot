import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import PortfolioPage from '../app/page';

const keyFor = async (sp: Record<string, string>) =>
  (await PortfolioPage({ searchParams: Promise.resolve(sp) })).key;

describe('PortfolioPage', () => {
  it('gives every set of search params its own loading boundary (#263)', async () => {
    const balanced = await keyFor({ p: 'account', account: 'a.near', strategy: 'balanced' });
    expect(balanced).toBeTruthy();
    expect(await keyFor({ p: 'account', account: 'a.near', strategy: 'aggressive' })).not.toBe(
      balanced,
    );
    expect(await keyFor({ p: 'demo-5000' })).not.toBe(balanced);
  });
});
