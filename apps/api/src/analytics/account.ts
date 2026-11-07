import type { AccountId, TokenId } from '@near-autopilot/core';

/**
 * A REAL NEAR account, read-only: native NEAR, the fungible tokens Burrow lists, and the Burrow position, valued at the
 * latest confirmed prices. Pure valuation here (tested); the reads are done by the caller with view calls only.
 *
 * Burrow's health factor: sum(collateral_usd x vr) / sum(borrowed_usd / vr), vr = the asset's volatility ratio.
 * Burrow balances are in inner units: raw = inner / 10^extra_decimals.
 */
export interface AccountReads {
  readonly accountId: AccountId;
  readonly nativeYocto: bigint;
  readonly wallet: ReadonlyMap<TokenId, bigint>;
  readonly burrow: {
    readonly supplied: readonly { token: TokenId; inner: bigint }[];
    readonly collateral: readonly { token: TokenId; inner: bigint }[];
    readonly borrowed: readonly { token: TokenId; inner: bigint }[];
  } | null;
}

export interface TokenFacts {
  readonly decimals: number;
  readonly symbol: string;
  /** USD per whole token; null = no confirmed price. */
  readonly usd: number | null;
  /** Burrow: inner = raw x 10^extraDecimals; vr in [0, 1]. */
  readonly extraDecimals?: number;
  readonly vr?: number;
}

export interface Holding {
  readonly where: 'wallet' | 'deposited' | 'collateral' | 'borrowed';
  readonly token: string;
  readonly symbol: string;
  readonly amount: number;
  readonly usd: number | null;
}

const WNEAR = 'wrap.near';
const toAmount = (raw: bigint, decimals: number) => {
  // keep 6 significant decimals without going through a lossy Number(raw) for 24-decimal values
  const scale = 10n ** BigInt(Math.max(0, decimals - 6));
  return Number(raw / scale) / 10 ** Math.min(6, decimals);
};

export function valueAccount(r: AccountReads, facts: ReadonlyMap<string, TokenFacts>) {
  const holdings: Holding[] = [];
  const unpriced: string[] = [];
  const fact = (t: string) => facts.get(t);
  const push = (where: Holding['where'], token: string, raw: bigint) => {
    const f = fact(token);
    if (!f || raw <= 0n) return;
    const amount = toAmount(raw, f.decimals);
    if (f.usd === null) unpriced.push(f.symbol);
    holdings.push({
      where,
      token,
      symbol: f.symbol,
      amount,
      usd: f.usd === null ? null : amount * f.usd,
    });
  };
  // native NEAR counts as NEAR in the wallet (valued at the wNEAR price)
  if (r.nativeYocto > 0n) {
    const f = fact(WNEAR);
    const amount = toAmount(r.nativeYocto, 24);
    holdings.push({
      where: 'wallet',
      token: 'near',
      symbol: 'NEAR',
      amount,
      usd: f?.usd === null || f?.usd === undefined ? null : amount * f.usd,
    });
  }
  for (const [token, raw] of r.wallet) push('wallet', token, raw);
  const fromInner = (token: string, inner: bigint) =>
    inner / 10n ** BigInt(fact(token)?.extraDecimals ?? 0);
  for (const x of r.burrow?.supplied ?? []) push('deposited', x.token, fromInner(x.token, x.inner));
  for (const x of r.burrow?.collateral ?? [])
    push('collateral', x.token, fromInner(x.token, x.inner));
  for (const x of r.burrow?.borrowed ?? []) push('borrowed', x.token, fromInner(x.token, x.inner));

  const sum = (w: Holding['where'][]) =>
    holdings.filter((h) => w.includes(h.where)).reduce((s, h) => s + (h.usd ?? 0), 0);
  const assetsUsd = sum(['wallet', 'deposited', 'collateral']);
  const debtUsd = sum(['borrowed']);
  let adjCollateral = 0;
  let adjDebt = 0;
  let missingRisk = false;
  for (const h of holdings) {
    const vr = fact(h.token)?.vr;
    if (h.where === 'collateral') {
      if (vr === undefined || h.usd === null) missingRisk = true;
      else adjCollateral += h.usd * vr;
    }
    if (h.where === 'borrowed') {
      if (vr === undefined || vr === 0 || h.usd === null) missingRisk = true;
      else adjDebt += h.usd / vr;
    }
  }
  const healthFactor = adjDebt > 0 && !missingRisk ? adjCollateral / adjDebt : null;
  return {
    holdings,
    unpriced: [...new Set(unpriced)],
    totals: {
      assetsUsd,
      debtUsd,
      netWorthUsd: assetsUsd - debtUsd,
      idleUsd: sum(['wallet']),
    },
    loan: {
      hasDebt: debtUsd > 0,
      healthFactor,
      /** Fall of every collateral price (debt unchanged) that brings HF to 1: exact for a uniform collateral move. */
      collateralDropToLiquidation:
        healthFactor !== null && healthFactor > 1 ? 1 - 1 / healthFactor : null,
      riskDataMissing: missingRisk,
    },
  };
}
