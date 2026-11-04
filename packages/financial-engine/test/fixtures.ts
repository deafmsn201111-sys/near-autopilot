import {
  accountId,
  type AssetRisk,
  type PriceMap,
  type TokenId,
  type UnitPrice,
} from '@near-autopilot/core';

export const WNEAR = accountId('wrap.near') as TokenId;
export const USDT = accountId('usdt.tether-token.near') as TokenId;

/** $5.00 per NEAR: 24-decimal token, multiplier/10^28 per raw unit. */
export const NEAR_PRICE: UnitPrice = { multiplier: 50_000n, decimals: 28 };
/** $1.00 per USDt: 6-decimal token, multiplier/10^10 per raw unit. */
export const USDT_PRICE: UnitPrice = { multiplier: 10_000n, decimals: 10 };

export const prices: PriceMap = new Map([
  [WNEAR, NEAR_PRICE],
  [USDT, USDT_PRICE],
]);

export const risk: ReadonlyMap<TokenId, AssetRisk> = new Map([
  [
    WNEAR,
    {
      token: WNEAR,
      collateralFactorBps: 7000,
      borrowFactorBps: 7000,
      canBeCollateral: true,
      canBorrow: true,
    },
  ],
  [
    USDT,
    {
      token: USDT,
      collateralFactorBps: 9000,
      borrowFactorBps: 9000,
      canBeCollateral: true,
      canBorrow: true,
    },
  ],
]);

export const near = (n: number): bigint => BigInt(n) * 10n ** 24n;
export const usdt = (n: number): bigint => BigInt(n) * 10n ** 6n;
