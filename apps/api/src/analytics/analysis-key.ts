import { createHash } from 'node:crypto';
import type { AgentObservation } from '@near-autopilot/orchestrator';
import type { PortfolioRecommendation } from './account-view';

const SIGNIFICANT_DIGITS = 4;

// Interest accrues every block and rates drift: only the leading digits of an amount, price or rate change the advice.
function leading(n: bigint): string {
  const digits = (n < 0n ? -n : n).toString();
  if (digits.length <= SIGNIFICANT_DIGITS) return `${n}n`;
  return `${n < 0n ? '-' : ''}${digits.slice(0, SIGNIFICANT_DIGITS)}e${digits.length - SIGNIFICANT_DIGITS}n`;
}

const byJson = (a: [unknown, unknown], b: [unknown, unknown]) => {
  const [x, y] = [JSON.stringify(a[0]), JSON.stringify(b[0])];
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Plain JSON with maps and object keys sorted and bigints cut to their leading digits. Dates are fetch times: dropped. */
function stable(value: unknown): unknown {
  if (value instanceof Date) return undefined;
  if (typeof value === 'bigint') return leading(value);
  if (value instanceof Map)
    return [...value].map(([k, v]): [unknown, unknown] => [stable(k), stable(v)]).sort(byJson);
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]): [string, unknown] => [k, stable(v)])
        .sort(byJson),
    );
  return value;
}

/** Same wallet state, same rule-based list and same preset give the same key, whenever they were read. */
export function analysisKey(
  obs: AgentObservation,
  heuristics: readonly PortfolioRecommendation[],
  preset: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([preset, stable(obs), stable(heuristics)]))
    .digest('hex');
}
