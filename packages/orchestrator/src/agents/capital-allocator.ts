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
    const swap = (await this.proposeSwap(obs)) as { proposals: Record<string, unknown>[] };
    const supplies = obs.config.allocation.supplyIdle ? this.proposeSupplies(obs) : [];
    if (supplies.length === 0) return swap;
    // A real proposal makes the swap path's "no action" redundant; the engine ranks the rest by net benefit.
    const rest = swap.proposals.filter((p) => p['kind'] !== 'no_action');
    return envelope(this.id, obs, [...supplies, ...rest]);
  }

  /**
   * Idle wallet tokens earn nothing; Burrow pays its supply rate on them. Proposes depositing each held allocation
   * asset, the whole held balance, the most dollars a year first (rate x deposit value): the swap size limit does not
   * apply to a deposit the user can withdraw (D23). The decision engine applies the same hurdle as for a swap (gas in
   * and out against the yield over the horizon); the policy engine decides the rest.
   */
  private proposeSupplies(obs: AgentObservation): Record<string, unknown>[] {
    const { snapshot, market, config } = obs;
    if (!market) return [];
    const idle: { token: TokenId; amount: bigint; yieldWad: bigint; earns: bigint }[] = [];
    for (const a of config.allocation.assets) {
      const held = snapshot.walletBalances
        .filter((b) => b.token === a.token)
        .reduce((s, b) => s + b.raw, 0n);
      const y = market.estimatedYieldWad.get(a.token);
      if (held <= 0n || y === undefined || y <= 0n || !snapshot.prices.has(a.token)) continue;
      // Dollars a year, not the rate: a higher rate on dust must not beat a large idle balance.
      const earns = tokenValueUsd(snapshot.prices, a.token, held) * y;
      idle.push({ token: a.token, amount: held, yieldWad: y, earns });
    }
    return idle
      .sort((x, y) => (y.earns > x.earns ? 1 : y.earns < x.earns ? -1 : 0))
      .map((i) => ({
        kind: 'lending.supply',
        token: i.token,
        amount: i.amount.toString(),
        rationale: `${i.token} sits idle in the wallet; Burrow pays an estimated ${(Number(i.yieldWad / 10n ** 12n) / 1e4).toFixed(2)}% a year on it`,
      }));
  }

  private async proposeSwap(obs: AgentObservation): Promise<unknown> {
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
    const missing = assets.filter((_, i) => yields[i] === undefined);
    if (missing.length > 0)
      return envelope(this.id, obs, [
        noAction(
          'insufficient_data',
          `missing yield estimate: ${missing
            .map((a) => {
              const note = market.notes?.yield?.get(a.token);
              return note ? `${a.token} (${note})` : a.token;
            })
            .join('; ')}`,
        ),
      ]);

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

    // An asset no allowlisted pool connects to any other configured asset cannot be bought or sold here: it keeps
    // its current weight, and the optimisation spreads the rest over the assets that can actually be traded.
    const pairs = obs.swapPairs;
    const routable = (a: string, b: string) =>
      !pairs || pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    const tradable = (t: string) => assets.some((o) => o.token !== t && routable(t, o.token));
    if (pairs && !assets.some((a) => tradable(a.token)))
      return envelope(this.id, obs, [
        noAction(
          'no_edge',
          'no allowlisted pool connects any two of the allocation assets: nothing can be traded',
        ),
      ]);
    let target: ReadonlyMap<string, number>;
    try {
      const input: AllocationAsset[] = assets.map((a, i) => ({
        id: a.token,
        minBps: tradable(a.token) ? a.minBps : (current.get(a.token) ?? 0),
        maxBps: tradable(a.token) ? a.maxBps : (current.get(a.token) ?? 0),
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

    const limited = limitTurnover({
      current,
      target,
      maxTurnoverBps: config.allocation.maxTurnoverBps,
    });
    const delta = (t: string): number => (limited.get(t) ?? 0) - (current.get(t) ?? 0);
    const ordered = [...assets.map((a) => a.token)].sort(
      (a, b) => delta(a) - delta(b) || (a < b ? -1 : 1),
    );
    const yieldOf = (t: string): bigint => market.estimatedYieldWad.get(t as TokenId) ?? 0n;
    // Only pairs an allowlisted pool connects can be traded. Pick the most over-weight asset to sell and the most
    // under-weight asset reachable from it that yields more: a proposal along a pair with no route would only be
    // rejected for having no quote.
    let sell: TokenId | undefined = ordered[0];
    let buy: TokenId | undefined = ordered[ordered.length - 1];
    if (pairs) {
      const sells = ordered.filter((t) => delta(t) < 0);
      const buys = [...ordered].reverse().filter((t) => delta(t) > 0);
      const choice = sells
        .flatMap((x) =>
          buys.filter((y) => routable(x, y) && yieldOf(y) > yieldOf(x)).map((y) => [x, y] as const),
        )
        .at(0);
      if (!choice && sells.length > 0 && buys.length > 0)
        return envelope(this.id, obs, [
          noAction(
            'no_edge',
            `no allowlisted pool connects an over-weight asset (${sells.join(', ')}) to a better-yielding under-weight one (${buys.join(', ')})`,
          ),
        ]);
      [sell, buy] = choice ?? [sell, buy];
    }
    if (!sell || !buy || sell === buy)
      return envelope(this.id, obs, [noAction('within_threshold', 'no rebalance needed')]);
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
