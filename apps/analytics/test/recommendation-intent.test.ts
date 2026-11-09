import { describe, expect, it } from 'vitest';
import {
  SWAP_STABLE,
  WRAP_NEAR,
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

  it('normalises native "near" to wrapped NEAR and targets the pool stablecoin', () => {
    const swap: RecommendationIntent = { action: 'swap', fromToken: 'near', approxUsd: 1160 };
    expect(recommendationToPrepare(swap, ACC)).toEqual({
      account: ACC,
      intent: { action: 'swap', token: WRAP_NEAR, tokenOut: SWAP_STABLE, approxUsd: 1160 },
    });
  });

  it('swaps the stablecoin back to wNEAR (the pool is two-sided)', () => {
    const swap: RecommendationIntent = { action: 'swap', fromToken: SWAP_STABLE, approxUsd: 100 };
    expect(recommendationToPrepare(swap, ACC)?.intent).toMatchObject({
      action: 'swap',
      token: SWAP_STABLE,
      tokenOut: WRAP_NEAR,
    });
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
