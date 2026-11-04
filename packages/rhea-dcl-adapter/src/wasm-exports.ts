import { checkExportedMethods, type AccountId, type JsonRpcCaller } from '@near-autopilot/core';
import { DCL_VERIFIED_CALL_METHODS, DCL_VERIFIED_VIEW_METHODS } from './constants';

// The WASM export parser is shared infrastructure and lives in core.
export { fetchDeployedAbi, parseWasmExports } from '@near-autopilot/core';
export type { DeployedAbi, JsonRpcCaller, WasmExport } from '@near-autopilot/core';

export interface AbiVerification {
  readonly contractId: AccountId;
  readonly codeHash: string;
  readonly missingViewMethods: readonly string[];
  readonly missingCallMethods: readonly string[];
  readonly ok: boolean;
}

/** Checks every source-verified DCL method name against what the deployment actually exports. */
export async function verifyDeployedAbi(
  rpc: JsonRpcCaller,
  contractId: AccountId,
  expected: { readonly views?: readonly string[]; readonly calls?: readonly string[] } = {},
): Promise<AbiVerification> {
  const views = expected.views ?? DCL_VERIFIED_VIEW_METHODS;
  const calls = expected.calls ?? DCL_VERIFIED_CALL_METHODS;
  const check = await checkExportedMethods(rpc, contractId, [...views, ...calls]);
  const missing = new Set(check.missing);
  const missingViewMethods = views.filter((m) => missing.has(m));
  const missingCallMethods = calls.filter((m) => missing.has(m));
  return {
    contractId,
    codeHash: check.codeHash,
    missingViewMethods,
    missingCallMethods,
    ok: check.ok,
  };
}
