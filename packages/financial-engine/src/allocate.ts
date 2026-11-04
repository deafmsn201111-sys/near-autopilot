import { assertBps, BPS, divRound } from './fixed';

/**
 * Constrained portfolio allocation in integer basis points (weights always sum to exactly 10,000).
 *
 * Problem solved EXACTLY (not heuristically):
 *     maximise   Σ w_i * y_i
 *     subject to min_i <= w_i <= max_i            per-asset bounds
 *                Σ_{i in G} w_i <= cap_G           disjoint group caps (e.g. "at most 40% on one protocol")
 *                Σ w_i = 10000
 * where y_i is an ESTIMATED expected yield supplied by the caller (inputs are named `estimatedYieldWad` so they cannot
 * be mistaken for realized figures). With a linear objective and nested (laminar) capacity constraints the greedy
 * "fill minimums, then fill the best yield first" rule is provably optimal; tests also cross-check it against brute
 * force on small grids. Ties break by asset id (ascending), so the result is fully deterministic.
 *
 * What this is not: it is not mean-variance optimisation (no risk model, no correlations) and it does not choose
 * yields. Risk limits are expressed through the bounds and caps.
 */

export interface AllocationAsset {
  readonly id: string;
  readonly minBps: number;
  readonly maxBps: number;
  /** ESTIMATED annual yield, WAD (0.05 = 5%). May be negative. */
  readonly estimatedYieldWad: bigint;
  readonly group?: string;
}

export interface GroupCap {
  readonly group: string;
  readonly maxBps: number;
}

export class InfeasibleAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfeasibleAllocationError';
  }
}

export interface AllocationResult {
  readonly weightsBps: ReadonlyMap<string, number>;
  /** Σ w_i * y_i / 10000, WAD. ESTIMATED: inherits the inputs' assumptions. */
  readonly estimatedPortfolioYield: { readonly basis: 'estimated'; readonly wad: bigint };
}

function validate(
  assets: readonly AllocationAsset[],
  caps: readonly GroupCap[],
): Map<string, number> {
  if (assets.length === 0) throw new RangeError('at least one asset is required');
  const ids = new Set<string>();
  for (const a of assets) {
    if (ids.has(a.id)) throw new RangeError(`duplicate asset id ${a.id}`);
    ids.add(a.id);
    assertBps(a.minBps, `minBps(${a.id})`);
    assertBps(a.maxBps, `maxBps(${a.id})`);
    if (a.minBps > a.maxBps) throw new RangeError(`minBps > maxBps for ${a.id}`);
  }
  const capOf = new Map<string, number>();
  for (const c of caps) {
    if (capOf.has(c.group)) throw new RangeError(`duplicate cap for group ${c.group}`);
    assertBps(c.maxBps, `cap(${c.group})`);
    capOf.set(c.group, c.maxBps);
  }
  for (const a of assets)
    if (a.group !== undefined && !capOf.has(a.group))
      throw new RangeError(`asset ${a.id} refers to group ${a.group} without a cap`);
  return capOf;
}

export function allocateConstrained(args: {
  assets: readonly AllocationAsset[];
  groupCaps?: readonly GroupCap[];
}): AllocationResult {
  const caps = args.groupCaps ?? [];
  const capOf = validate(args.assets, caps);

  const weights = new Map<string, number>(args.assets.map((a) => [a.id, a.minBps]));
  const groupUsed = new Map<string, number>();
  let remaining = 10_000 - args.assets.reduce((s, a) => s + a.minBps, 0);
  if (remaining < 0) throw new InfeasibleAllocationError('minimum weights exceed 100%');
  for (const a of args.assets)
    if (a.group !== undefined) groupUsed.set(a.group, (groupUsed.get(a.group) ?? 0) + a.minBps);
  for (const [g, used] of groupUsed)
    if (used > (capOf.get(g) ?? 0))
      throw new InfeasibleAllocationError(`minimum weights in group ${g} exceed its cap`);

  const order = [...args.assets].sort((a, b) =>
    a.estimatedYieldWad === b.estimatedYieldWad
      ? a.id < b.id
        ? -1
        : 1
      : a.estimatedYieldWad > b.estimatedYieldWad
        ? -1
        : 1,
  );
  for (const a of order) {
    if (remaining === 0) break;
    const groupRoom =
      a.group === undefined ? Infinity : (capOf.get(a.group) ?? 0) - (groupUsed.get(a.group) ?? 0);
    const add = Math.min(a.maxBps - (weights.get(a.id) ?? 0), remaining, groupRoom);
    if (add <= 0) continue;
    weights.set(a.id, (weights.get(a.id) ?? 0) + add);
    if (a.group !== undefined) groupUsed.set(a.group, (groupUsed.get(a.group) ?? 0) + add);
    remaining -= add;
  }
  if (remaining !== 0)
    throw new InfeasibleAllocationError(
      `bounds and caps cannot reach 100% (short by ${remaining} bps)`,
    );

  let yieldWad = 0n;
  for (const a of args.assets) yieldWad += BigInt(weights.get(a.id)!) * a.estimatedYieldWad;
  return {
    weightsBps: weights,
    estimatedPortfolioYield: { basis: 'estimated', wad: divRound(yieldWad, BPS, 'floor') },
  };
}

/**
 * Converts bps weights to token/USD amounts that sum EXACTLY to `total` (largest-remainder method; ties break by
 * id ascending). No unit is created or lost.
 */
export function weightsToAmounts(
  total: bigint,
  weightsBps: ReadonlyMap<string, number>,
): Map<string, bigint> {
  if (total < 0n) throw new RangeError('total must be non-negative');
  const entries = [...weightsBps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const sum = entries.reduce((s, [, w]) => s + w, 0);
  if (sum !== 10_000) throw new RangeError(`weights must sum to 10000 bps, got ${sum}`);
  const parts = entries.map(([id, w]) => ({
    id,
    floor: (total * BigInt(w)) / BPS,
    rem: (total * BigInt(w)) % BPS,
  }));
  let leftover = total - parts.reduce((s, p) => s + p.floor, 0n);
  const byRemainder = [...parts].sort((a, b) =>
    a.rem === b.rem ? (a.id < b.id ? -1 : 1) : a.rem > b.rem ? -1 : 1,
  );
  for (const p of byRemainder) {
    if (leftover === 0n) break;
    p.floor += 1n;
    leftover -= 1n;
  }
  return new Map(parts.map((p) => [p.id, p.floor]));
}

/** One-way turnover in bps: half the sum of absolute weight changes. */
export function turnoverBps(
  from: ReadonlyMap<string, number>,
  to: ReadonlyMap<string, number>,
): number {
  let sum = 0;
  for (const id of new Set([...from.keys(), ...to.keys()]))
    sum += Math.abs((to.get(id) ?? 0) - (from.get(id) ?? 0));
  return sum / 2;
}

/**
 * Moves from `current` toward `target` but by at most `maxTurnoverBps` of one-way turnover. Every weight stays between
 * its current and target value (so bounds that both satisfy still hold) and the result sums to exactly 10,000.
 * Rounds toward the current weights, so the limit is never exceeded.
 */
export function limitTurnover(args: {
  current: ReadonlyMap<string, number>;
  target: ReadonlyMap<string, number>;
  maxTurnoverBps: number;
}): Map<string, number> {
  const { current, target, maxTurnoverBps } = args;
  assertBps(maxTurnoverBps, 'maxTurnoverBps');
  const ids = [...new Set([...current.keys(), ...target.keys()])].sort();
  const sumOf = (m: ReadonlyMap<string, number>) => ids.reduce((s, id) => s + (m.get(id) ?? 0), 0);
  if (sumOf(current) !== 10_000 || sumOf(target) !== 10_000)
    throw new RangeError('current and target must each sum to 10000 bps');
  const full = turnoverBps(current, target);
  if (full <= maxTurnoverBps) return new Map(ids.map((id) => [id, target.get(id) ?? 0]));

  // Scale every move by max/full = 2*max / Σ|delta|. Moves round toward zero; the larger side is then trimmed so buys == sells.
  const totalAbs = BigInt(
    ids.reduce((t, id) => t + Math.abs((target.get(id) ?? 0) - (current.get(id) ?? 0)), 0),
  );
  const moves = ids.map((id) => {
    const delta = (target.get(id) ?? 0) - (current.get(id) ?? 0);
    const num = BigInt(Math.abs(delta)) * 2n * BigInt(maxTurnoverBps);
    return { id, sign: Math.sign(delta), units: Number(num / totalAbs), rem: num % totalAbs };
  });
  const sumSide = (s: number) => moves.filter((m) => m.sign === s).reduce((t, m) => t + m.units, 0);
  const buys = sumSide(1);
  const sells = sumSide(-1);
  const keep = Math.min(buys, sells);
  const trim = (side: number, excess: number) => {
    // Remove units from the moves that lost the least to rounding (smallest remainder first), then by id.
    const candidates = moves
      .filter((m) => m.sign === side && m.units > 0)
      .sort((a, b) => (a.rem === b.rem ? (a.id < b.id ? -1 : 1) : a.rem < b.rem ? -1 : 1));
    let left = excess;
    while (left > 0 && candidates.length > 0) {
      for (const m of candidates) {
        if (left === 0) break;
        if (m.units > 0) {
          m.units -= 1;
          left -= 1;
        }
      }
    }
  };
  if (buys > keep) trim(1, buys - keep);
  if (sells > keep) trim(-1, sells - keep);
  return new Map(
    ids.map((id) => [
      id,
      (current.get(id) ?? 0) +
        moves.find((m) => m.id === id)!.sign * moves.find((m) => m.id === id)!.units,
    ]),
  );
}
