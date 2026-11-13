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

/**
 * The health factor a swap-repay cascade never goes below after its first step (withdraw), even if the user stops
 * there: the agents' danger line (1.10) plus 0.05 for prices moving between the steps (#69).
 */
export const SWAP_REPAY_FLOOR_HF = 1.15;

/**
 * A loan whose debt token is not in the wallet or the collateral: swap another collateral token (wallet first, then
 * Burrow) into the debt token and repay. Whole tokens and USD floats, like the rest of this file.
 */
export interface SwapRepayInput {
  readonly model: Pick<LoanModel, 'collateralAdjUsd' | 'debtAdjUsd'>;
  /** The token sold: `deposited` is plain Burrow supply (no HF effect), `collateral` counts in the HF. */
  readonly collateral: {
    readonly usdPerToken: number;
    readonly vr: number;
    readonly deposited: number;
    readonly collateral: number;
    readonly wallet: number;
  };
  /** The token repaid; `amount` is the debt, `wallet` what the wallet already holds of it. */
  readonly debt: {
    readonly usdPerToken: number;
    readonly vr: number;
    readonly amount: number;
    readonly wallet: number;
  };
  /** Debt tokens per collateral token at the swap's minimum output (slippage already taken off). */
  readonly outPerIn: number;
  readonly target: number;
  readonly floor: number;
}

export type SwapRepayPlan =
  | {
      readonly ok: true;
      /** Collateral tokens taken from the wallet, withdrawn from Burrow, and swapped in total. */
      readonly fromWallet: number;
      readonly withdraw: number;
      readonly swapIn: number;
      readonly minOut: number;
      /** Debt tokens repaid: the swap's minimum output plus what the wallet held, capped at the debt. */
      readonly repay: number;
      /** HF after the withdraw (and after the swap, which does not touch Burrow); null = no debt. */
      readonly hfAfterWithdraw: number | null;
      readonly hfAfterRepay: number | null;
    }
  | {
      readonly ok: false;
      /** floor: any withdrawal breaks the floor; no_gain: repaying this way does not raise the HF; nothing: no tokens. */
      readonly reason: 'floor' | 'no_gain' | 'nothing';
    };

/**
 * Smallest swap that brings the HF to `target`, never withdrawing collateral past `floor`. If the floor or the debt
 * stops it short, the largest allowed swap (a partial improvement). The HF after each step is returned for the card.
 */
export function swapRepayPlan(i: SwapRepayInput): SwapRepayPlan {
  const { model, collateral: c, debt: d } = i;
  const free = c.wallet + c.deposited;
  const perCollateralToken = c.usdPerToken * c.vr;
  const room =
    perCollateralToken > 0
      ? Math.max(0, (model.collateralAdjUsd - i.floor * model.debtAdjUsd) / perCollateralToken)
      : 0;
  const fromCollateralMax = Math.min(c.collateral, room);
  const toRepayDebt = i.outPerIn > 0 ? Math.max(0, d.amount - d.wallet) / i.outPerIn : 0;
  const sMax = Math.min(free + fromCollateralMax, toRepayDebt);
  if (sMax <= EPS) {
    if (free + c.collateral <= EPS) return { ok: false, reason: 'nothing' };
    return { ok: false, reason: free <= EPS && room <= EPS ? 'floor' : 'nothing' };
  }
  const collateralAfter = (s: number) =>
    model.collateralAdjUsd - Math.max(0, s - free) * perCollateralToken;
  const repayOf = (s: number) => Math.min(s * i.outPerIn + d.wallet, d.amount);
  const hfAfter = (s: number): number | null => {
    const debt = model.debtAdjUsd - (repayOf(s) * d.usdPerToken) / d.vr;
    return debt <= EPS ? null : Math.max(0, collateralAfter(s)) / debt;
  };
  const inf = (h: number | null) => (h === null ? Infinity : h);
  const hfNow = model.debtAdjUsd > EPS ? model.collateralAdjUsd / model.debtAdjUsd : Infinity;
  // The HF rises over the wallet and plain supply part; over the collateral part it is monotone one way or the other
  // (a ratio of two linear functions), and falls when the HF is under about vr_collateral x vr_debt: stop before it.
  let sTop = sMax;
  if (sMax > free && free > EPS && inf(hfAfter(sMax)) < inf(hfAfter(free))) sTop = free;
  if (inf(hfAfter(sTop)) <= hfNow) return { ok: false, reason: 'no_gain' };
  let s = sTop;
  if (inf(hfAfter(sTop)) > i.target && inf(hfAfter(0)) < i.target) {
    let lo = 0;
    let hi = sTop;
    for (let n = 0; n < 100 && hi - lo > EPS * Math.max(1, hi); n++) {
      const mid = (lo + hi) / 2;
      if (inf(hfAfter(mid)) >= i.target) hi = mid;
      else lo = mid;
    }
    s = hi;
  }
  const fromWallet = Math.min(s, c.wallet);
  return {
    ok: true,
    fromWallet,
    withdraw: s - fromWallet,
    swapIn: s,
    minOut: s * i.outPerIn,
    repay: repayOf(s),
    hfAfterWithdraw:
      model.debtAdjUsd <= EPS ? null : Math.max(0, collateralAfter(s)) / model.debtAdjUsd,
    hfAfterRepay: hfAfter(s),
  };
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
