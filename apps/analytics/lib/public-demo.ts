import 'server-only';
import { withinLimit as withinRateLimit } from './rate-limit';

/**
 * PUBLIC DEMO MODE (`PUBLIC_DEMO=1`): the dashboard served to anyone on the internet.
 *
 *  - The operator controls (start an analysis, pause the collector, read-only mode) are REFUSED on the server: a
 *    hidden button is not enough, a server action can be called directly.
 *  - "Let the agent do it", its confirmation and "Reset demo" stay, so a visitor can try them on the simulated demo
 *    portfolios (dry run, nothing is signed), but rate-limited per visitor and overall.
 *  - "Your account" reads a mainnet account through the RPC: rate-limited the same way.
 *
 * Limits live in memory: they reset on a restart, which is acceptable for a demo; they never weaken a policy limit.
 */
export const PUBLIC_DEMO = process.env['PUBLIC_DEMO'] === '1';

export const PUBLIC_REFUSAL =
  'Disabled on the public demo. Run the project locally to use it (README, Quick start).';

/** Per visitor and overall, per kind of call. */
const LIMITS = {
  action: { perVisitor: 20, overall: 300, windowMs: 10 * 60_000 },
  account: { perVisitor: 30, overall: 600, windowMs: 10 * 60_000 },
} as const;

/**
 * In public mode, whether this call is within the limits (and counts it); always true otherwise.
 */
export async function withinLimit(kind: keyof typeof LIMITS, now = Date.now()): Promise<boolean> {
  if (!PUBLIC_DEMO) return true;
  return withinRateLimit(kind, LIMITS[kind], now);
}

export const RATE_LIMITED =
  'Too many requests from the public demo right now. Wait a few minutes and try again.';
