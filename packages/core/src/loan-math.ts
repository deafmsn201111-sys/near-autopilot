/**
 * Burrow's health factor for display and sizing, in USD floats: HF = sum(collateral_usd x vr) / sum(debt_usd / vr).
 * One token is moved at a time (the loan's largest debt), so the rest of the position stays in the adjusted sums.
 * Shared by the API (sizing a card) and the UI (the amount slider). On-chain amounts are still built in base units.
 */
export interface LoanModel {
  /** sum(collateral_usd x vr) over the whole position. */
  readonly collateralAdjUsd: number;
  /** sum(debt_usd / vr) over the whole position. */
  readonly debtAdjUsd: number;
  /** Volatility ratio of the token being repaid or withdrawn, in (0, 1]. */
  readonly vr: number;
  readonly usdPerToken: number;
}

export type RepaySource = 'wallet' | 'collateral';

/** What a repay card hands the amount picker: the loan model plus the default (safe) and largest amounts. */
export interface RepaySizing extends LoanModel {
  readonly symbol: string;
  readonly decimals: number;
  readonly hfNow: number;
  readonly targetHf: number;
  /** Tokens that bring the HF to `targetHf`, never above `maxTokens`. */
  readonly safeTokens: number;
  /** The smaller of the debt and the source (wallet or collateral). */
  readonly maxTokens: number;
  /** `maxTokens` is the whole debt, not a cap from the source. */
  readonly wholeDebt: boolean;
}

const EPS = 1e-9;

/** HF after repaying `tokens` of the token; null when no debt is left. */
export function hfAfterRepay(m: LoanModel, tokens: number, from: RepaySource): number | null {
  const usd = tokens * m.usdPerToken;
  const debt = m.debtAdjUsd - usd / m.vr;
  if (debt <= EPS) return null;
  const collateral = from === 'collateral' ? m.collateralAdjUsd - usd * m.vr : m.collateralAdjUsd;
  return Math.max(0, collateral) / debt;
}

/** Tokens to repay so the HF reaches `target` (0 when it already does). */
export function repayToReach(m: LoanModel, target: number, from: RepaySource): number {
  const usd =
    from === 'collateral'
      ? (target * m.debtAdjUsd - m.collateralAdjUsd) / (target / m.vr - m.vr)
      : m.vr * (m.debtAdjUsd - m.collateralAdjUsd / target);
  return usd > 0 ? usd / m.usdPerToken : 0;
}

/** Collateral tokens that can leave while the HF stays at `target` or above; Infinity with no debt. */
export function withdrawableToKeep(m: LoanModel, target: number): number {
  if (m.debtAdjUsd <= EPS) return Infinity;
  const usd = (m.collateralAdjUsd - target * m.debtAdjUsd) / m.vr;
  return usd > 0 ? usd / m.usdPerToken : 0;
}

/** The loan-safety zones the account view uses: "low" risk at 1.5 and above, "high" below 1.1. */
export function healthZone(hf: number | null): 'low' | 'medium' | 'high' {
  if (hf === null || hf >= 1.5) return 'low';
  return hf >= 1.1 ? 'medium' : 'high';
}

/** A typed decimal ("17.30") in exact base units; extra decimals are cut, not rounded. Null when not a number. */
export function toRawAmount(text: string, decimals: number): bigint | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m || (m[1] === '' && !m[2])) return null;
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt((m[1] || '0') + frac);
}
