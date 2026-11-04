import type { TokenId } from '@near-autopilot/core';
import { usdToMicro } from '@near-autopilot/core';
import {
  allocateConstrained,
  limitTurnover,
  rawForValueUsd,
  tokenValueUsd,
  type AllocationAsset,
} from '@near-autopilot/financial-engine';
import type { ProposalAgent } from '../ports';
import type { AgentObservation } from '../types';
import { envelope, noAction } from './envelope';

/**
 * Deterministic Capital Allocator. Solves a constrained allocation over the configured assets using ESTIMATED yields
 * from the market feed (bounds and group caps are the risk limits), limits turnover, and proposes at most one swap
 * from the most over-weight to the most under-weight asset. The decision engine decides whether the trade is worth
 * its cost; this agent only says where the portfolio would like to be.
 */
export class CapitalAllocatorAgent implements ProposalAgent {
  readonly id = 'capital-allocator' as const;

  async propose(obs: AgentObservation): Promise<unknown> {
    const { snapshot, market, config } = obs;
    const assets = config.allocation.assets;
    if (assets.length < 2)
      return envelope(this.id, obs, [
        noAction('insufficient_data', 'fewer than two allocation assets configured'),
      ]);
    if (!market) return envelope(this.id, obs, [noAction('insufficient_data', 'no market data')]);

    const held = new Map<TokenId, bigint>();
    for (const b of snapshot.walletBalances) held.set(b.token, (held.get(b.token) ?? 0n) + b.raw);
    const values = new Map<TokenId, bigint>();
    for (const a of assets) {
      if (!snapshot.prices.has(a.token))
        return envelope(this.id, obs, [noAction('insufficient_data', `no price for ${a.token}`)]);
      values.set(a.token, tokenValueUsd(snapshot.prices, a.token, held.get(a.token) ?? 0n));
    }
    const total = [...values.values()].reduce((s, v) => s + v, 0n);
    if (total === 0n)
      return envelope(this.id, obs, [
        noAction('insufficient_data', 'allocation assets hold no value'),
      ]);

    const yields = assets.map((a) => market.estimatedYieldWad.get(a.token));
    if (yields.some((y) => y === undefined))
      return envelope(this.id, obs, [noAction('insufficient_data', 'missing yield estimate')]);

    let target: ReadonlyMap<string, number>;
    try {
      const input: AllocationAsset[] = assets.map((a, i) => ({
        id: a.token,
        minBps: a.minBps,
        maxBps: a.maxBps,
        estimatedYieldWad: yields[i] as bigint,
        ...(a.group ? { group: a.group } : {}),
      }));
      target = allocateConstrained({
        assets: input,
        groupCaps: config.allocation.groupCaps,
      }).weightsBps;
    } catch (error) {
      return envelope(this.id, obs, [
        noAction(
          'other',
          `allocation infeasible: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ]);
    }

    // Current weights, floored, remainder to the largest holding so they sum to exactly 10,000.
    const current = new Map<string, number>();
    let assigned = 0;
    for (const a of assets) {
      const w = Number(((values.get(a.token) ?? 0n) * 10_000n) / total);
      current.set(a.token, w);
      assigned += w;
    }
    const largest = [...assets].sort((x, y) =>
      (values.get(y.token) ?? 0n) > (values.get(x.token) ?? 0n) ? 1 : -1,
    )[0];
    if (largest)
      current.set(largest.token, (current.get(largest.token) ?? 0) + (10_000 - assigned));

    const limited = limitTurnover({
      current,
      target,
      maxTurnoverBps: config.allocation.maxTurnoverBps,
    });
    const delta = (t: string): number => (limited.get(t) ?? 0) - (current.get(t) ?? 0);
    const ordered = [...assets.map((a) => a.token)].sort(
      (a, b) => delta(a) - delta(b) || (a < b ? -1 : 1),
    );
    const sell = ordered[0];
    const buy = ordered[ordered.length - 1];
    if (!sell || !buy || sell === buy)
      return envelope(this.id, obs, [noAction('within_threshold', 'no rebalance needed')]);
    const yieldOf = (t: string): bigint => market.estimatedYieldWad.get(t as TokenId) ?? 0n;
    if (yieldOf(buy) <= yieldOf(sell))
      return envelope(this.id, obs, [
        noAction(
          'no_edge',
          'the asset to buy is not estimated to yield more than the asset to sell',
        ),
      ]);
    // The threshold is about how far the portfolio is from its target, so measure the RAW drift; the turnover cap
    // only limits how much of it one trade corrects (a cap below the threshold must not disable rebalancing).
    const drift = Math.max(
      ...assets.map((a) => Math.abs((target.get(a.token) ?? 0) - (current.get(a.token) ?? 0))),
    );
    if (drift < config.allocation.driftThresholdBps)
      return envelope(this.id, obs, [
        noAction(
          'within_threshold',
          `largest drift ${drift} bps is under ${config.allocation.driftThresholdBps}`,
        ),
      ]);

    const wantUsd = (total * BigInt(Math.min(-delta(sell), delta(buy)))) / 10_000n;
    const capUsd = usdToMicro(config.swap.maxSwapUsd);
    const sellUsd = [wantUsd, capUsd, values.get(sell) ?? 0n].reduce((a, b) => (b < a ? b : a));
    const price = snapshot.prices.get(sell);
    if (!price || sellUsd <= 0n)
      return envelope(this.id, obs, [noAction('other', 'nothing to sell')]);
    let amount = rawForValueUsd(sellUsd, price);
    const have = held.get(sell) ?? 0n;
    if (amount > have) amount = have;
    if (amount <= 0n) return envelope(this.id, obs, [noAction('other', 'nothing to sell')]);

    return envelope(this.id, obs, [
      {
        kind: 'allocation.swap',
        tokenIn: sell,
        tokenOut: buy,
        amountIn: amount.toString(),
        maxSlippageBps: config.swap.maxSlippageBps,
        rationale: `${sell} is ${-delta(sell)} bps over its constrained-optimal weight, ${buy} is ${delta(buy)} bps under (estimated yields)`,
      },
    ]);
  }
}
