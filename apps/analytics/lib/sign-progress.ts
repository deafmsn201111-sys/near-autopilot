import type { StepResult } from './events-client';

export type StepState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'signing' }
  | { readonly kind: 'checking'; readonly hash: string }
  | { readonly kind: 'stopped'; readonly reason: string }
  | {
      readonly kind: 'done' | 'failed' | 'unknown';
      readonly hash: string;
      readonly result: StepResult;
    };

export const stepAfterCheck = (hash: string, result: StepResult): StepState => ({
  kind: result.status === 'confirmed' ? 'done' : result.status === 'failed' ? 'failed' : 'unknown',
  hash,
  result,
});

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
  return '';
}
