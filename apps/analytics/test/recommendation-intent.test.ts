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

  it('forwards the exact base-unit amount for repay / supply only when present', () => {
    const repay: RecommendationIntent = {
      action: 'repay',
      token: 'wrap.near',
      approxUsd: 50,
      amount: '1000000000000000000000000',
    };
    expect(recommendationToPrepare(repay, ACC)?.intent).toEqual({
      action: 'repay',
      token: 'wrap.near',
      approxUsd: 50,
      amount: '1000000000000000000000000',
    });
    const supply: RecommendationIntent = { action: 'supply', token: 'x', approxUsd: 5 };
    expect(recommendationToPrepare(supply, ACC)?.intent).not.toHaveProperty('amount');
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

  it('maps repay from collateral and withdraw with their exact amount, never the sizing', () => {
    const sizing = {
      collateralAdjUsd: 51,
      debtAdjUsd: 40,
      vr: 0.95,
      usdPerToken: 1,
      symbol: 'USDC',
      decimals: 6,
      hfNow: 1.28,
      targetHf: 1.6,
      safeTokens: 17.17,
      maxTokens: 37.87,
      wholeDebt: true,
    };
    const repay: RecommendationIntent = {
      action: 'repay_from_collateral',
      token: 'usdc',
      approxUsd: 17.17,
      amount: '17170000',
      sizing,
    };
    expect(recommendationToPrepare(repay, ACC)?.intent).toEqual({
      action: 'repay_from_collateral',
      token: 'usdc',
      approxUsd: 17.17,
      amount: '17170000',
    });
    const withdraw: RecommendationIntent = {
      action: 'withdraw',
      token: 'usdc',
      approxUsd: 16.7,
      amount: '16716700',
    };
    expect(recommendationToPrepare(withdraw, ACC)?.intent).toEqual({
      action: 'withdraw',
      token: 'usdc',
      approxUsd: 16.7,
      amount: '16716700',
    });
  });

  it('uses the amount the user picked instead of the suggested one', () => {
    const repay: RecommendationIntent = {
      action: 'repay',
      token: 'usdc',
      approxUsd: 17,
      amount: '17000000',
    };
    expect(recommendationToPrepare(repay, ACC, '5000000')?.intent).toMatchObject({
      amount: '5000000',
    });
  });

  it('has no request for advice-only cards', () => {
    expect(recommendationToPrepare(null, ACC)).toBeNull();
  });

  it('gives each action a button label', () => {
    expect(actionLabel({ action: 'repay', token: 'x', approxUsd: 1 })).toMatch(/repay/i);
    expect(actionLabel({ action: 'repay_from_collateral', token: 'x', approxUsd: 1 })).toMatch(
      /collateral/i,
    );
    expect(actionLabel({ action: 'withdraw', token: 'x', approxUsd: 1 })).toMatch(/withdraw/i);
    expect(actionLabel({ action: 'reposition_dcl', lptId: 'x', poolId: 'y' })).toMatch(
      /reposition/i,
    );
  });
});
