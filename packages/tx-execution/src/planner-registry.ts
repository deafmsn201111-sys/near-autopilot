import {
  UnsupportedIntentError,
  type AccountId,
  type ActionIntent,
  type PlannedTransaction,
  type ProtocolPlanner,
} from '@near-autopilot/core';

/** Routes an intent to the protocol planner that supports it. */
export class PlannerRegistry {
  private readonly planners: ProtocolPlanner[] = [];

  register(planner: ProtocolPlanner): this {
    this.planners.push(planner);
    return this;
  }

  plan(intent: ActionIntent, signerId: AccountId): Promise<PlannedTransaction> {
    const planner = this.planners.find((p) => p.protocol === intent.protocol && p.supports(intent));
    if (!planner) return Promise.reject(new UnsupportedIntentError(intent.kind));
    return planner.plan(intent, signerId);
  }
}
