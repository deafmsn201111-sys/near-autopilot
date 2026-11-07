import { accountId, type AccountId, type Network } from '@near-autopilot/core';

/**
 * SYNTHETIC demo portfolios. Every number here is invented for demonstration; none of it was read from a chain.
 * The asset parameters for testnet mirror what Burrow testnet reported on 2026-11-04 (wrap.testnet volatility ratio
 * 7500, usdt.fakes.testnet 9500 with 12 extra decimals); the PRICES are fixed demo values, because the testnet
 * oracle reported no fresh prices at all.
 */
export type DemoPortfolioId = 'demo-500' | 'demo-5000';

export interface DemoAsset {
  readonly token: AccountId;
  readonly symbol: string;
  readonly decimals: number;
  /** Burrow `extra_decimals`: inner = raw x 10^extra. */
  readonly extraDecimals: number;
  /** Burrow `volatility_ratio` (bps): weights collateral, divides debt. */
  readonly volatilityRatioBps: number;
  /** Oracle price, USD per RAW unit = multiplier / 10^priceDecimals. */
  readonly priceMultiplier: bigint;
  readonly priceDecimals: number;
}

export interface DemoPortfolio {
  readonly id: DemoPortfolioId;
  /** Gross asset value (wallet + supplied + collateral) at the demo prices, USD. */
  readonly grossUsd: number;
  readonly description: string;
  readonly nativeYocto: bigint;
  readonly wallet: { readonly near: bigint; readonly usdt: bigint };
  readonly collateral: { readonly near: bigint };
  /** Deposited on Burrow, not collateral (`near` only ever comes from a simulated deposit). */
  readonly supplied: { readonly usdt: bigint; readonly near?: bigint };
  readonly borrowed: { readonly usdt: bigint };
}

const NEAR = 10n ** 24n;
const USDT = 10n ** 6n;

/** Demo prices: 1 NEAR = $3.00, 1 USDt = $1.00. */
export function demoAssets(network: Network): { near: DemoAsset; usdt: DemoAsset } {
  const ids =
    network === 'testnet'
      ? { near: 'wrap.testnet', usdt: 'usdt.fakes.testnet' }
      : { near: 'wrap.near', usdt: 'usdt.tether-token.near' };
  return {
    near: {
      token: accountId(ids.near),
      symbol: 'wNEAR',
      decimals: 24,
      extraDecimals: 0,
      volatilityRatioBps: 7500,
      priceMultiplier: 30_000n,
      priceDecimals: 28,
    },
    usdt: {
      token: accountId(ids.usdt),
      symbol: 'USDt',
      decimals: 6,
      extraDecimals: 12,
      volatilityRatioBps: 9500,
      priceMultiplier: 10_000n,
      priceDecimals: 10,
    },
  };
}

/**
 * Both portfolios sit BELOW a 1.3 health-factor trigger so the guardian has something to do:
 *  - demo-500:  HF ~1.28; the repay needed to reach 1.6 is ~$40, inside a $100 per-action limit -> approved, dry-run.
 *  - demo-5000: HF ~1.23; the repay needed is ~$464, above the $100 per-action limit -> the policy engine rejects it.
 * Values at demo prices: see each `description`.
 */
export const DEMO_PORTFOLIOS: Readonly<Record<DemoPortfolioId, DemoPortfolio>> = {
  'demo-500': {
    id: 'demo-500',
    grossUsd: 500,
    description:
      'wallet 30 wNEAR ($90) + 50 USDt ($50); Burrow collateral 120 wNEAR ($360); debt 200 USDt. Gross $500, net $300.',
    nativeYocto: 2n * NEAR,
    wallet: { near: 30n * NEAR, usdt: 50n * USDT },
    collateral: { near: 120n * NEAR },
    supplied: { usdt: 0n },
    borrowed: { usdt: 200n * USDT },
  },
  'demo-5000': {
    id: 'demo-5000',
    grossUsd: 5000,
    description:
      'wallet 300 wNEAR ($900) + 600 USDt ($600); Burrow collateral 1150 wNEAR ($3450), supplied 50 USDt ($50); debt 2000 USDt. Gross $5000, net $3000.',
    nativeYocto: 5n * NEAR,
    wallet: { near: 300n * NEAR, usdt: 600n * USDT },
    collateral: { near: 1150n * NEAR },
    supplied: { usdt: 50n * USDT },
    borrowed: { usdt: 2000n * USDT },
  },
};

/**
 * THE SIMULATED LEDGER of a demo portfolio: every action the agent carried out on it as a dry run (from the dashboard's
 * "let the agent do it"), applied in order to the base amounts above. A repayment moves USDt from the wallet to pay
 * down the loan; a deposit moves tokens from the wallet into Burrow. Amounts are clamped to what is there, so the
 * state can never go negative. A `reset` entry starts again from the base. Nothing here touches a chain.
 */
export interface LedgerEntry {
  readonly kind: 'repay' | 'supply' | 'reset';
  readonly asset: 'near' | 'usdt' | null;
  readonly amountRaw: bigint;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function applyLedger(base: DemoPortfolio, entries: readonly LedgerEntry[]): DemoPortfolio {
  let p: DemoPortfolio = base;
  for (const e of entries) {
    if (e.kind === 'reset') {
      p = base;
      continue;
    }
    if (e.kind === 'repay' && e.asset === 'usdt') {
      const x = min(min(e.amountRaw, p.wallet.usdt), p.borrowed.usdt);
      p = {
        ...p,
        wallet: { ...p.wallet, usdt: p.wallet.usdt - x },
        borrowed: { usdt: p.borrowed.usdt - x },
      };
    }
    if (e.kind === 'supply' && e.asset) {
      const held = p.wallet[e.asset];
      const x = min(e.amountRaw, held);
      p = {
        ...p,
        wallet: { ...p.wallet, [e.asset]: held - x },
        supplied: { ...p.supplied, [e.asset]: (p.supplied[e.asset] ?? 0n) + x },
      };
    }
  }
  return p;
}
