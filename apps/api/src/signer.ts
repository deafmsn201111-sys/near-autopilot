import type { TransactionSigner } from '@near-autopilot/core';
import type { ApiEnv } from '@near-autopilot/config';

/**
 * Key-custody extension point.
 *
 * This repository deliberately ships NO signer: how the autopilot's key is held (KMS/HSM,
 * a function-call access key limited to the allowlisted contracts, an MPC service, ...) is a
 * deployment decision with real security consequences. Return a `TransactionSigner` backed by
 * your custody solution here. Until you do, `EXECUTION_MODE=live` refuses to start and the
 * system runs in `dry-run`, which plans and policy-checks everything but never signs.
 */
export function loadSigner(_env: ApiEnv): TransactionSigner | null {
  return null;
}
