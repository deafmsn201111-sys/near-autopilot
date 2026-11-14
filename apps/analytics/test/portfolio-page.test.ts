import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { Suspense } from 'react';
import PortfolioPage from '../app/page';

const keyFor = async (sp: Record<string, string>) => {
  const page = await PortfolioPage({ searchParams: Promise.resolve(sp) });
  expect(page.type).toBe(Suspense);
  return page.key;
};

describe('PortfolioPage', () => {
  it('gives every view its own loading boundary (#263)', async () => {
    const mine = await keyFor({ p: 'account', account: 'a.near' });
    expect(mine).toBeTruthy();
    expect(await keyFor({ p: 'account', account: 'b.near' })).not.toBe(mine);
    expect(await keyFor({ p: 'demo-5000' })).not.toBe(mine);
  });

  it('keeps the boundary across a strategy switch, so focus and scroll hold (#288)', async () => {
    const balanced = await keyFor({ p: 'account', account: 'a.near', strategy: 'balanced' });
    expect(await keyFor({ p: 'account', account: 'a.near', strategy: 'aggressive' })).toBe(
      balanced,
    );
  });
});
