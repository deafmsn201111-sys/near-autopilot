import { AutopilotError, type ApprovedPlan } from '@near-autopilot/core';
import { planHash } from '@near-autopilot/core/hash';

export class ApprovalError extends AutopilotError {
  constructor(message: string) {
    super('APPROVAL_INVALID', message);
  }
}

/** Re-verifies, at execution time, everything the policy engine promised at approval time. */
export function verifyApproval(approved: ApprovedPlan, now: Date): void {
  if (now.getTime() >= approved.expiresAt.getTime()) {
    throw new ApprovalError(
      `Approval ${approved.decisionId} expired at ${approved.expiresAt.toISOString()}`,
    );
  }
  if (planHash(approved.plan) !== approved.planHash) {
    throw new ApprovalError(
      'Plan content does not match the approved hash (modified after approval)',
    );
  }
}
