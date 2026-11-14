import type { StepResult } from './events-client';

export type StepState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'signing' }
  | { readonly kind: 'checking'; readonly hash: string }
  | { readonly kind: 'stopped'; readonly reason: string }
  | { readonly kind: 'sent'; readonly hash: string }
  | {
      readonly kind: 'done' | 'failed' | 'unknown';
      readonly hash: string;
      readonly result: StepResult;
    };

export const stepAfterCheck = (hash: string, result: StepResult): StepState =>
  result.status === 'unchecked'
    ? { kind: 'sent', hash }
    : {
        kind:
          result.status === 'confirmed'
            ? 'done'
            : result.status === 'failed'
              ? 'failed'
              : 'unknown',
        hash,
        result,
      };

/** A step the server could not check still went through the wallet: the cascade goes on. */
export const mayContinue = (s: StepState) => s.kind === 'done' || s.kind === 'sent';

/** The one line under the steps: where the cascade stands. */
export function progressFooter(steps: readonly StepState[], busy: boolean): string {
  if (busy) return 'Keep this window open until every step is checked on NEAR.';
  if (steps.some((s) => s.kind === 'failed'))
    return 'Stopped: a step failed on NEAR, so the next one was not offered.';
  if (steps.some((s) => s.kind === 'unknown'))
    return 'Stopped: a step is not confirmed yet, so the next one was not offered.';
  if (steps.some((s) => s.kind === 'stopped'))
    return 'Not signed in your wallet. Nothing after that step was sent.';
  if (steps.length > 0 && steps.every((s) => s.kind === 'done'))
    return 'Done. Every step is confirmed on NEAR.';
  if (steps.length > 0 && steps.every(mayContinue))
    return 'Sent. Some steps could not be checked here: verify them on NearBlocks.';
  return '';
}

export interface ProgressResult {
  readonly tone: 'ok' | 'watch' | 'liq';
  readonly title: string;
  readonly detail: string;
}

/** The result shown in the sheet's footer once signing stops; null while it runs or before it starts. */
export function progressResult(steps: readonly StepState[], busy: boolean): ProgressResult | null {
  if (busy || steps.length === 0) return null;
  const failed = steps.find((s) => s.kind === 'failed');
  if (failed && 'result' in failed && failed.result.status === 'failed') {
    const { failure, funds } = failed.result;
    const next = steps.indexOf(failed) < steps.length - 1 ? ' The next step was not offered.' : '';
    return {
      tone: 'liq',
      title: 'The transaction failed on NEAR.',
      detail: `${failure.contract}: ${failure.error}. ${funds}${next}`,
    };
  }
  const stopped = steps.findIndex((s) => s.kind === 'stopped');
  if (stopped >= 0)
    return {
      tone: 'watch',
      title: 'Not signed in your wallet.',
      detail:
        stopped === 0
          ? 'Your wallet reported nothing sent. Check its activity before you try again.'
          : `${stopped === 1 ? 'Step 1' : `Steps 1–${stopped}`} went through; nothing after it was sent.`,
    };
  if (steps.every((s) => s.kind === 'done'))
    return {
      tone: 'ok',
      title: 'Done. Every step is confirmed on NEAR.',
      detail: 'Your portfolio updates when you close this window.',
    };
  return {
    tone: 'watch',
    title: 'Not confirmed yet.',
    detail:
      progressFooter(steps, false) ||
      'Check your wallet activity on NearBlocks before signing anything else.',
  };
}
