import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SWAP_TARGET,
  actionLabel,
  recommendationToPrepare,
  type RecommendationIntent,
} from '../lib/recommendation-intent';

const ACC = 'alice.near';

describe('recommendationToPrepare', () => {
  it('maps repay / supply straight through', () => {
    const repay: RecommendationIntent = { action: 'repay', token: 'wrap.near', approxUsd: 50 };
    expect(recommendationToPrepare(repay, ACC)).toEqual({
      account: ACC,
      intent: { action: 'repay', token: 'wrap.near', approxUsd: 50 },
    });
    const supply: RecommendationIntent = {
      action: 'supply',
      token: 'usdt.tether-token.near',
      approxUsd: 20,
    };
    expect(recommendationToPrepare(supply, ACC)?.intent).toMatchObject({
      action: 'supply',
      approxUsd: 20,
    });
  });

  it('maps a concentration swap to a stablecoin target', () => {
    const swap: RecommendationIntent = { action: 'swap', fromToken: 'wrap.near', approxUsd: 100 };
    expect(recommendationToPrepare(swap, ACC)).toEqual({
      account: ACC,
      intent: { action: 'swap', token: 'wrap.near', tokenOut: DEFAULT_SWAP_TARGET, approxUsd: 100 },
    });
  });

  it('returns null when the swap source is already the target (nothing to do)', () => {
    const swap: RecommendationIntent = {
      action: 'swap',
      fromToken: DEFAULT_SWAP_TARGET,
      approxUsd: 100,
    };
    expect(recommendationToPrepare(swap, ACC)).toBeNull();
  });

  it('maps reposition_dcl to the lpt id', () => {
    const r: RecommendationIntent = {
      action: 'reposition_dcl',
      lptId: 'a|b|10000#1',
      poolId: 'a|b|10000',
    };
    expect(recommendationToPrepare(r, ACC)).toEqual({
      account: ACC,
      intent: { action: 'reposition_dcl', lptId: 'a|b|10000#1' },
    });
  });

  it('gives each action a button label', () => {
    expect(actionLabel({ action: 'repay', token: 'x', approxUsd: 1 })).toMatch(/repay/i);
    expect(actionLabel({ action: 'reposition_dcl', lptId: 'x', poolId: 'y' })).toMatch(
      /reposition/i,
    );
  });
});
