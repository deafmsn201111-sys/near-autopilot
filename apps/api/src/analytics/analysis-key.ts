import { createHash } from 'node:crypto';
import type { AgentObservation } from '@near-autopilot/orchestrator';
import type { PortfolioRecommendation } from './account-view';

const byJson = (a: [unknown, unknown], b: [unknown, unknown]) => {
  const [x, y] = [JSON.stringify(a[0]), JSON.stringify(b[0])];
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Plain JSON with maps and object keys sorted and bigints as strings. Dates are dropped: they are fetch times. */
function stable(value: unknown): unknown {
  if (value instanceof Date) return undefined;
  if (typeof value === 'bigint') return `${value}n`;
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
