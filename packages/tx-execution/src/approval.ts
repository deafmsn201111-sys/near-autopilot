import { AutopilotError, type ApprovalAuthority, type ApprovedPlan } from '@near-autopilot/core';
import { planHash } from '@near-autopilot/core/hash';

export class ApprovalError extends AutopilotError {
  constructor(message: string) {
    super('APPROVAL_INVALID', message);
  }
}

/** Re-verifies, at execution time, everything the policy engine promised at approval time. */
export function verifyApproval(
  approved: ApprovedPlan,
  now: Date,
  authority: ApprovalAuthority,
): void {
  if (!authority.isAuthentic(approved)) {
    throw new ApprovalError('Approval was not issued by the policy engine');
  }
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
