import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({}));

const { autoRefreshes } = await import('../components/AutoRefresh');

describe('page auto-refresh', () => {
  it('refreshes the demo views on a timer', () => {
    expect(autoRefreshes(null)).toBe(true);
    expect(autoRefreshes('500')).toBe(true);
  });

  it('never refreshes the account view on a timer, so an idle tab does not use up its rate limit', () => {
    expect(autoRefreshes('account')).toBe(false);
  });
});
