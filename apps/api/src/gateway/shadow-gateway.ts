import {
  errorMessage,
  toJsonSafe,
  type ApprovedPlan,
  type Clock,
  type ExecutionResult,
  type IdGenerator,
  type Logger,
  type PlanExecutor,
  type PriceOracle,
  type TokenId,
} from '@near-autopilot/core';
import type { AutopilotRepository, ExecutionRouteRecord } from '../repository';
import { chooseRoute, type RouteDecision, type RouteLimits } from './best-execution';
import { plannedSwap } from './swap-plan';
import type { Venue } from './venues';

/**
 * SHADOW GATEWAY: the one execution boundary in dry-run. It holds no signer and has no way to obtain one; its only
 * effect is a row in `execution_routes`.
 *
 *   BLOCK -> never reaches it (the cycle stops at the verdict; no approval exists to pass in).
 *   WARN  -> never reaches it either: the proposal waits for a human; no approval is minted for it.
 *   ALLOW -> the gateway re-checks, in this order, and refuses on the first failure:
 *              1. the verdict STORED in policy_verdicts for this decision is ALLOW and names this plan hash
 *                 (a decision that was never persisted, or a different plan, does not pass);
 *              2. the approval itself (minted by the policy engine, unexpired, plan unchanged, not replayed),
 *                 by the wrapped dry-run executor;
 *            then quotes every venue for the plan's swap and records the best execution. It always returns dry_run.
 */
export interface ShadowGatewayDeps {
  /** The dry-run executor (approval verification + replay guard). Never a live executor. */
  readonly inner: PlanExecutor;
  readonly repo: Pick<AutopilotRepository, 'findPolicyVerdict' | 'insertExecutionRoute'>;
  readonly venues: readonly Venue[];
  readonly prices: PriceOracle;
  readonly gasPrice: () => Promise<bigint>;
  /** wNEAR token id on the quoted network: gas is valued at its price. */
  readonly nearToken: TokenId;
  readonly exchange: string;
  /** The account the quotes are for (recipient / refund address of a real trade; nothing is sent to it). */
  readonly account: string;
  readonly limits: RouteLimits & { readonly slippageBps: number };
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /**
   * The version of the policy in force in this process. A stored ALLOW issued under a different policy (changed
   * limits, rules) is refused: the approval must come from the policy that is in force when it is used.
   */
  readonly policyVersion?: string;
}

export class ShadowGateway implements PlanExecutor {
  constructor(private readonly d: ShadowGatewayDeps) {}

  async execute(approved: ApprovedPlan): Promise<ExecutionResult> {
    const base = {
      origin: 'gateway' as const,
      decisionId: approved.decisionId,
      intentId: approved.plan.intentId,
      planHash: approved.planHash,
    };
    const refuse = async (reason: string): Promise<ExecutionResult> => {
      await this.record({ ...base, outcome: 'refused', reason });
      this.d.logger.warn('gateway refused', { decisionId: approved.decisionId, reason });
      return { status: 'rejected', mode: 'dry-run', txHash: null, error: reason };
    };

    const stored = await this.d.repo.findPolicyVerdict(approved.decisionId);
    if (!stored) return refuse('no stored policy verdict for this decision');
    // ALLOW, or WARN (the policy required a human confirmation) with an approval that names who confirmed it. The
    // approval's authenticity is verified by the inner executor: a structural copy with approvedBy is still refused.
    const confirmed =
      stored.verdict === 'WARN' &&
      typeof approved.approvedBy === 'string' &&
      approved.approvedBy !== '';
    if (stored.verdict !== 'ALLOW' && !confirmed)
      return refuse(
        `stored verdict is ${stored.verdict}, not ALLOW${stored.verdict === 'WARN' ? ' and nobody confirmed it' : ''}`,
      );
    if (stored.planHash !== approved.planHash)
      return refuse('the stored ALLOW verdict is for a different plan');
    if (this.d.policyVersion !== undefined && stored.policyVersion !== this.d.policyVersion)
      return refuse(
        `the stored ALLOW was issued under policy ${stored.policyVersion}, not the one in force (${this.d.policyVersion})`,
      );

    const result = await this.d.inner.execute(approved);
    if (result.status !== 'dry_run') return refuse(result.error ?? `executor: ${result.status}`);

    const swap = plannedSwap(approved.plan, this.d.exchange);
    if (!swap) {
      await this.record({
        ...base,
        outcome: 'not_a_swap',
        reason: `single-venue plan: ${approved.plan.receiverId}#${approved.plan.actions.map((a) => a.methodName).join(',')}; nothing to route`,
      });
      return result;
    }
    const route = await routeSwap(this.d, {
      tokenIn: swap.tokenIn,
      tokenOut: swap.tokenOut,
      amountIn: swap.amountIn,
      poolId: swap.poolId,
      attachedGas: swap.attachedGas,
    });
    await this.record({ ...base, ...route });
    this.d.logger.info('gateway routed (dry-run, nothing sent)', {
      decisionId: approved.decisionId,
      chosen: route.chosenVenue,
      reason: route.reason,
    });
    return result;
  }

  private async record(
    r: Pick<ExecutionRouteRecord, 'origin' | 'outcome' | 'reason'> &
      Partial<Omit<ExecutionRouteRecord, 'id' | 'createdAt'>>,
  ): Promise<void> {
    await this.d.repo.insertExecutionRoute({
      id: this.d.ids.next(),
      createdAt: this.d.clock.now(),
      decisionId: null,
      intentId: null,
      planHash: null,
      tokenIn: null,
      tokenOut: null,
      amountIn: null,
      chosenVenue: null,
      advantageBps: null,
      quotes: [],
      ...r,
    });
  }
}

export type RouteDeps = Pick<
  ShadowGatewayDeps,
  'venues' | 'prices' | 'gasPrice' | 'nearToken' | 'account' | 'limits' | 'clock' | 'logger'
>;

/** Quote every venue for one swap (in parallel) and choose; shared by the gateway and the reference probe. */
export async function routeSwap(
  d: RouteDeps,
  swap: {
    tokenIn: TokenId;
    tokenOut: TokenId;
    amountIn: bigint;
    poolId?: number;
    attachedGas?: bigint;
  },
): Promise<
  Pick<
    ExecutionRouteRecord,
    | 'outcome'
    | 'tokenIn'
    | 'tokenOut'
    | 'amountIn'
    | 'chosenVenue'
    | 'advantageBps'
    | 'reason'
    | 'quotes'
  >
> {
  let gasPriceYocto: bigint | null = null;
  try {
    gasPriceYocto = await d.gasPrice();
  } catch (e) {
    d.logger.warn('gas price unavailable', { error: errorMessage(e) });
  }
  const now = () => d.clock.now();
  const quotes = await Promise.all(
    d.venues.map((v) =>
      v.quote({
        ...swap,
        account: d.account,
        slippageBps: d.limits.slippageBps,
        gasPriceYocto: gasPriceYocto ?? 0n,
        now,
      }),
    ),
  );
  const tokens = [...new Set([swap.tokenIn, swap.tokenOut, d.nearToken])];
  let prices: Awaited<ReturnType<PriceOracle['getPrices']>>['prices'] = new Map();
  try {
    prices = (await d.prices.getPrices(tokens)).prices;
  } catch (e) {
    d.logger.warn('route prices unavailable', { error: errorMessage(e) });
  }
  const decision: RouteDecision = chooseRoute(
    swap,
    quotes,
    {
      in: prices.get(swap.tokenIn) ?? null,
      out: prices.get(swap.tokenOut) ?? null,
      // Unknown gas price: gas cannot be valued, so no route is chosen (never treated as free).
      near: gasPriceYocto === null ? null : (prices.get(d.nearToken) ?? null),
    },
    d.limits,
    d.clock.now(),
  );
  return {
    outcome: decision.chosen ? 'routed' : 'no_route',
    tokenIn: swap.tokenIn,
    tokenOut: swap.tokenOut,
    amountIn: swap.amountIn,
    chosenVenue: decision.chosen,
    advantageBps: decision.advantageBps,
    reason:
      gasPriceYocto === null && !decision.chosen
        ? `gas price unavailable; ${decision.reason}`
        : decision.reason,
    quotes: toJsonSafe({ gasPriceYocto, scored: decision.scored }),
  };
}
