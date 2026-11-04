import type { AccountId, ProtocolId, TokenId } from './ids';

export interface TokenInfo {
  readonly id: TokenId;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * USD price of ONE RAW UNIT of a token, expressed as `multiplier / 10^decimals`.
 * This is the format Burrow's price oracle publishes, and it avoids needing token decimals
 * (or floating point) anywhere in valuation code.
 */
export interface UnitPrice {
  readonly multiplier: bigint;
  readonly decimals: number;
}

export type PriceMap = ReadonlyMap<TokenId, UnitPrice>;

export interface AssetBalance {
  readonly token: TokenId;
  readonly raw: bigint;
}

/** Risk parameters in basis points (10_000 = 100%). */
export interface AssetRisk {
  readonly token: TokenId;
  readonly collateralFactorBps: number;
  readonly borrowFactorBps: number;
  readonly canBeCollateral: boolean;
  readonly canBorrow: boolean;
}

export interface LendingPosition {
  readonly protocol: ProtocolId;
  readonly accountId: AccountId;
  /** Deposited but not counted as collateral. */
  readonly supplied: readonly AssetBalance[];
  readonly collateral: readonly AssetBalance[];
  readonly borrowed: readonly AssetBalance[];
}

export interface PortfolioSnapshot {
  readonly accountId: AccountId;
  readonly takenAt: Date;
  readonly pricesAsOf: Date;
  /** Native NEAR balance in yoctoNEAR (used for gas reserve checks). */
  readonly nativeBalance: bigint;
  readonly walletBalances: readonly AssetBalance[];
  readonly lending: LendingPosition | null;
  readonly prices: PriceMap;
  readonly risk: ReadonlyMap<TokenId, AssetRisk>;
  readonly tokens: ReadonlyMap<TokenId, TokenInfo>;
}

export interface SwapQuoteRequest {
  readonly tokenIn: TokenId;
  readonly tokenOut: TokenId;
  readonly amountIn: bigint;
}

export interface SwapQuote {
  readonly protocol: 'rhea';
  readonly poolId: number;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}
