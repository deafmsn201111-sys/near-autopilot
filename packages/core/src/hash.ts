// Node-only entry point (uses node:crypto). Never import this from browser/dashboard code.
import { createHash } from 'node:crypto';
import type { PlannedTransaction } from './plan';
import { canonicalJson } from './serialize';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Content hash binding an approval to the exact transaction that was evaluated. */
export function planHash(plan: PlannedTransaction): string {
  return sha256Hex(canonicalJson(plan));
}
