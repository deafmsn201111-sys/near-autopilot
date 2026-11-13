import {
  healthZone,
  hfAfterRepay,
  toRawAmount,
  type RepaySizing,
  type RepaySource,
} from '@near-autopilot/core/loan-math';

/** Above the whole debt by this much, so interest accrued since the read is covered; Burrow repays at most the debt. */
const WHOLE_DEBT_MARGIN = 1.001;

/** A token amount for the input: rounded up at up to 6 decimals (never below the target), no trailing zeros. */
export function amountText(tokens: number, decimals: number): string {
  const places = Math.min(decimals, 6);
  const scaled = Math.ceil(tokens * 10 ** places - 1e-6);
  return String(scaled / 10 ** places);
}

/** What a typed repay amount does: base units to prepare, whole tokens, USD and the health factor after. */
export function pickRepay(s: RepaySizing, from: RepaySource, text: string) {
  const typed = Number(text);
  if (!(typed > 0) || toRawAmount(text, s.decimals) === null) return null;
  const tokens = Math.min(typed, s.maxTokens);
  const whole = s.wholeDebt && tokens >= s.maxTokens;
  const raw = toRawAmount(
    amountText(whole ? tokens * WHOLE_DEBT_MARGIN : tokens, s.decimals),
    s.decimals,
  );
  if (!raw) return null;
  const hf = whole ? null : hfAfterRepay(s, tokens, from);
  return { raw: raw.toString(), tokens, usd: tokens * s.usdPerToken, hf, zone: healthZone(hf) };
}
