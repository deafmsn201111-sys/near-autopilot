import { describe, expect, it } from 'vitest';
import { accountId } from '@near-autopilot/core';
import { amountsForLiquidity } from '@near-autopilot/financial-engine';
import {
  dclPositionAmounts,
  type DclMarketDepth,
  type DclPool,
  type DclPosition,
} from '@near-autopilot/rhea-dcl-adapter';
import {
  RecentreRefused,
  depthSegments,
  lpObservation,
  recentreSteps,
} from '../src/analytics/lp-recentre';
import { assembleCascade } from '../src/wallet/cascade';
import { validateCascade } from '../src/wallet/validate-cascade';

const DCL = accountId('dclv2.ref-labs.near');
const USDC = accountId('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
const WNEAR = accountId('wrap.near');
const POOL_ID = `${USDC}|${WNEAR}|100`;
const ALICE = accountId('alice.near');
const CUR = 405_300; // ~2.5 USDC per NEAR at 6 / 24 decimals

const pool: DclPool = {
  pool_id: POOL_ID,
  token_x: USDC,
  token_y: WNEAR,
  fee: 100,
  point_delta: 1,
  current_point: CUR,
  state: 'Running',
  liquidity: 50_000_000_000_000_000n,
};
/** Out of range below the price: all wNEAR. */
const position: DclPosition = {
  lpt_id: `${POOL_ID}#7`,
  pool_id: POOL_ID,
  left_point: 399_000,
  right_point: 404_000,
  amount: 1_000_000_000_000n,
};
const depth: DclMarketDepth = {
  liquidities: {
    a: { left_point: 395_000, right_point: 405_000, amount_l: 40_000_000_000_000_000n },
    b: { left_point: 405_100, right_point: 410_000, amount_l: 50_000_000_000_000_000n },
  },
  orders: {},
};

const observe = (overrides: Partial<Parameters<typeof lpObservation>[0]> = {}) =>
  lpObservation({
    positions: [position],
    pools: new Map([[POOL_ID, pool]]),
    depths: new Map([[POOL_ID, depth]]),
    allowedPools: new Set([POOL_ID]),
    volumesUsd: new Map([[POOL_ID, 1_000_000]]),
    priceUsd: (t) => ({ [USDC]: 1, [WNEAR]: 2.5 })[t],
    decimals: (t) => ({ [USDC]: 6, [WNEAR]: 24 })[t],
    label: (t) => (t === WNEAR ? 'wNEAR' : 'USDC'),
    ...overrides,
  });

describe('lpObservation', () => {
  it('builds a view whose CLMM amounts match the contract math', () => {
    const { views, meta } = observe();
    const [view] = views;
    expect(view?.id).toBe(position.lpt_id);
    const clmm = amountsForLiquidity(view!.sqrtPrice, view!.range, 'floor');
    const dcl = dclPositionAmounts(position, CUR);
    expect(dcl.x).toBe(0n);
    expect(Number(clmm.amount1) / Number(dcl.y)).toBeCloseTo(1, 3);
    // 1 000 000 USD at 2.5 USD per wNEAR
    expect(Number(view!.volume24hQuote) / 1e24).toBeCloseTo(400_000, 6);
    expect(view!.feePpm).toBe(100);
    expect(meta.get(position.lpt_id)).toMatchObject({
      inRange: false,
      pointDelta: 1,
      pair: 'USDC/wNEAR',
    });
  });

  it('leaves a position out when its pool has no 24 h volume', () => {
    const { views, notes } = observe({ volumesUsd: null });
    expect(views).toEqual([]);
    expect(notes.join()).toMatch(/no 24 h volume/);
  });

  it('leaves a position out when a price makes its amounts meaningless', () => {
    const { views, notes } = observe({ priceUsd: (t) => (t === WNEAR ? 1e-300 : 1) });
    expect(views).toEqual([]);
    expect(notes.join()).toMatch(/no price/);
  });

  it('leaves out positions in pools that are not allowlisted, and farm-staked positions', () => {
    expect(observe({ allowedPools: new Set() }).views).toEqual([]);
    expect(observe({ positions: [{ ...position, v_liquidity: 1n }] }).views).toEqual([]);
  });

  it('fills the gaps in the market depth with empty segments', () => {
    const s = depthSegments(depth);
    expect(s).toHaveLength(3);
    expect(s[1]?.liquidity).toBe(0n);
    expect(s[0]?.sqrtUpper).toBe(s[1]?.sqrtLower);
  });
});

describe('recentreSteps', () => {
  const base = {
    dcl: DCL,
    position,
    pool,
    leftPoint: CUR - 600,
    rightPoint: CUR + 600,
    maxSlippageBps: 50,
    tokenX: USDC,
    tokenY: WNEAR,
    symbolX: 'USDC',
    symbolY: 'wNEAR',
  };
  const freed = dclPositionAmounts(position, CUR);
  const atSpot = (amountIn: bigint, impact = 0) =>
    BigInt(Math.floor((Number(amountIn) / 1.0001 ** CUR) * (1 - impact)));
  const minY = (freed.y * 9_950n) / 10_000n;

  it('removes, withdraws, swaps the surplus wNEAR, deposits both and adds at the new range', async () => {
    const quotes: bigint[] = [];
    const r = await recentreSteps({
      ...base,
      quote: async (tokenIn, tokenOut, amountIn) => {
        expect([tokenIn, tokenOut]).toEqual([WNEAR, USDC]);
        quotes.push(amountIn);
        return atSpot(amountIn);
      },
    });
    expect(r.steps.map((s) => s.intentId)).toEqual([
      'remove-liquidity',
      'withdraw',
      'swap',
      'deposit-USDC',
      'deposit-wNEAR',
      'add-liquidity',
    ]);
    const [sold] = quotes;
    // about half the freed wNEAR is sold; the deposits follow the min-out, not the quote
    expect(Number(sold) / Number(minY)).toBeCloseTo(0.5, 1);
    const minOut = (atSpot(sold!) * 9_950n) / 10_000n;
    expect(r.amountX).toBe(minOut);
    expect(r.amountY).toBe(minY - sold!);
    const swapMsg = JSON.parse(String(r.steps[2]!.tx.actions[0]!.args['msg'])) as {
      Swap: { min_output_amount: string };
    };
    expect(swapMsg.Swap.min_output_amount).toBe(minOut.toString());
    const add = r.steps[5]!.tx.actions[0]!.args;
    expect(add).toMatchObject({
      pool_id: POOL_ID,
      left_point: CUR - 600,
      right_point: CUR + 600,
      amount_x: minOut.toString(),
    });
    expect(BigInt(String(add['min_amount_x']))).toBeLessThanOrEqual(minOut);

    const cascade = assembleCascade(ALICE, r.steps);
    expect(
      validateCascade(cascade.transactions, {
        signerId: ALICE,
        allowedReceivers: new Set<string>([DCL, USDC, WNEAR]),
        dcl: { contract: DCL, pools: new Set([POOL_ID]) },
      }),
    ).toEqual({ ok: true });
  });

  it("loosens the add's minimums by the price move its own swap causes", async () => {
    const minY = async (impact: number) => {
      const r = await recentreSteps({
        ...base,
        quote: async (_in, _out, amountIn) => atSpot(amountIn, impact),
      });
      return BigInt(String(r.steps.at(-1)!.tx.actions[0]!.args['min_amount_y']));
    };
    expect(await minY(0.002)).toBeLessThan(await minY(0));
  });

  it('refuses when its own swap would move the price by more than the slippage', async () => {
    await expect(
      recentreSteps({ ...base, quote: async (_in, _out, amountIn) => atSpot(amountIn, 0.02) }),
    ).rejects.toThrow(/more than the slippage/);
  });

  it('refuses a position back in range, a paused pool and a range at the top bound', async () => {
    const quote = async (_in: unknown, _out: unknown, amountIn: bigint) => atSpot(amountIn);
    await expect(
      recentreSteps({ ...base, position: { ...position, right_point: CUR + 1 }, quote }),
    ).rejects.toThrow(/back in range/);
    await expect(
      recentreSteps({ ...base, pool: { ...pool, state: 'Paused' }, quote }),
    ).rejects.toThrow(/not running/);
    await expect(recentreSteps({ ...base, rightPoint: 800_000, quote })).rejects.toBeInstanceOf(
      RecentreRefused,
    );
  });

  it('refuses when the price is outside the new range', async () => {
    await expect(
      recentreSteps({ ...base, leftPoint: CUR + 1, rightPoint: CUR + 600, quote: async () => 1n }),
    ).rejects.toBeInstanceOf(RecentreRefused);
  });

  it('refuses a range that is not aligned to the point delta', async () => {
    await expect(
      recentreSteps({
        ...base,
        pool: { ...pool, point_delta: 40 },
        leftPoint: CUR - 601,
        quote: async () => 1n,
      }),
    ).rejects.toBeInstanceOf(RecentreRefused);
  });
});
