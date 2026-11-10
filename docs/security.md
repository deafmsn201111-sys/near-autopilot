# Security model

## Threat model (what the design defends against)

| Threat                                             | Control                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Buggy/compromised agent proposes a harmful action  | Policy re-values the action itself, checks allowlists, limits, slippage, oracle deviation       |
| Planner bug sends funds somewhere unexpected       | `intentMatchesPlan`, recipient allowlist for `ft_transfer_call`, one action per tx, deposit cap |
| Manipulated or illiquid pool                       | Operator-curated pools only; quote must be within `maxOracleDeviationBps` of oracle price       |
| Stale data                                         | Snapshot and prices must be younger than `maxPriceAgeSeconds`                                   |
| Plan altered after approval / approval replay      | Approval binds SHA-256 of canonical plan + TTL; executor re-verifies; approvals are single-use  |
| Forged decision or approval (cast / copied object) | `PolicyEngine` records decisions and approvals it minted; executors check `ApprovalAuthority`   |
| Smuggled Burrow action (e.g. Withdraw in `msg`)    | `intent_match` requires exactly the one Repay / IncreaseCollateral action for the intent token  |
| Config says testnet, RPC serves mainnet            | `wire()` asserts the RPC `chain_id` equals `NEAR_NETWORK` before anything else, fail-closed     |
| Runaway loop                                       | Per-action cap, rolling 24h cap, swap cooldown, one in-flight cycle, one tx per live cycle      |
| Leveraging up                                      | No borrow/withdraw intents exist; v1 can only de-risk or rebalance spot                         |
| Tx built against a wrong chain / contract / oracle | Burrow builders accept only `BurrowVerifier` proofs (chain id, deployed code, oracle, token)    |
| Mainnet signing                                    | `loadApiEnv` and `wire()` reject `EXECUTION_MODE=live` on mainnet; no override exists           |
| Stranded swap output                               | Planner requires storage registration on the output token before building the swap              |
| Unauthorised API use                               | Bearer token (≥32 chars, constant-time compare); dashboard calls server-side only               |
| Secret leakage                                     | Env validation errors name variables, never values; API errors are generic                      |

## Key custody (deliberately not included)

`TransactionSigner` is a port. The repo ships no implementation, and `EXECUTION_MODE=live` fails at startup
until `loadSigner()` in `apps/api/src/signer.ts` returns one.

**Mainnet is dry-run only.** Configuration with `EXECUTION_MODE=live` and `NEAR_NETWORK=mainnet` is rejected at
load time, and the composition root checks it again, so a mainnet signing key cannot be put to use through this
code. Live signing is possible on testnet only, with a testnet key. Nothing in the adapters or tests reads key
material. If you fork this project to change that, it is a deliberate security decision to review, not a flag.
Recommended setups for a testnet signer (and for anything you build yourself), strongest first:

1. KMS/HSM- or MPC-backed signing behind the `TransactionSigner` interface.
2. A **function-call access key** restricted to one contract and its methods, with a gas allowance.
3. Never place a full-access private key in an environment variable or config file.

Use a dedicated account holding only what the autopilot should be allowed to move.

### Full-access keys are refused (enforced, not advice)

The live executor never signs with a full-access key (`packages/tx-execution/src/key-guard.ts`). It checks twice:

- **At start-up:** with `EXECUTION_MODE=live`, the composition root reads the signing key's permission
  (`view_access_key`). A full-access key stops the process before any cycle runs.
- **Before every signature:** the permission arrives in the same chain query as the nonce.

**What is refused:**

- `full_access`: always.
- `function_call`: refused unless the key's receiver is the transaction's receiver, the key allows the method, and no
  action attaches a deposit. The NEAR runtime rejects a function-call key on a call with a deposit anyway; refusing
  first gives a clear reason instead of a failed receipt.

**Consequence: no current plan can be signed autonomously.** Every plan the planners build is an `ft_transfer_call`,
which NEP-141 requires to carry exactly 1 yoctoNEAR, so none passes this guard. This is intended: an autopilot holding
a full-access key has no ceiling. Live autonomous execution needs a custody design that does not hand it one, such as
an MPC or delegated signer with its own limits. Until then every deployment runs dry-run.

The manual testnet tool (`testnet-tx`) is separate. It signs one previewed transaction at a time, only after a human
confirms that exact transaction, and it needs a full-access key because it attaches deposits.

## Attack demo: `pnpm demo:attack`

The demo runs hand-written attack **fixtures** through the real defences: the policy engine, the agent-output parser,
the Shadow Gateway and the live executor's key guard. Every fixture is labelled `FIXTURE: synthetic attack input, not
market or chain data`. Nothing touches a network. The one live executor involved has a fake signer that counts calls.

| Attack                          | Stopped by                                  | Result                                     |
| ------------------------------- | ------------------------------------------- | ------------------------------------------ |
| Prompt injection: a transfer    | agent-output parser                         | discarded: `FORBIDDEN_FIELD`, `SCHEMA`     |
| Prompt injection: impersonation | agent-output parser                         | discarded: `WRONG_AGENT`, agent suspicious |
| Foreign recipient               | policy `action_shape` (recipient allowlist) | BLOCK                                      |
| Extra Withdraw in Burrow msg    | policy `intent_match`                       | BLOCK                                      |
| Stale oracle price (10 min)     | policy `price_freshness`                    | BLOCK                                      |
| Thin pool (40% below oracle)    | policy `oracle_deviation`                   | BLOCK                                      |
| Forged approval                 | Shadow Gateway (approval authenticity)      | refused                                    |
| Full-access signing key         | live executor key guard                     | refused, 0 signed, 0 sent                  |

**Controls:** two legitimate actions (a $40 repayment and a fair $30 swap) pass the same defences with ALLOW. So the
attacks are blocked for their specific defect, not by a policy that blocks everything. Each policy attack fails
exactly one check: the one it targets.

**The log** is `docs/evidence/demo-attack.log.jsonl`. It is deterministic: a test fails if the committed log differs
from what a run produces. The attack verdicts also replay (`audit:replay`) to the same verdict.

`--persist` additionally stores the verdicts and one audit event per attack in Postgres. They are stored as
`simulation:testnet` rows with run id `demo-attack:<time>`, and the audit chain makes them permanent.

## Testnet evidence (read-only, 2026-11-04)

Checked from this repository with view calls only (`status`, `view_code`, `call_function`) against
`https://rpc.testnet.near.org`; no keys, no transactions:

| Component                                                         | Result                                                                                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Burrow `contract.1638481328.burrow.testnet`                       | Passes `BurrowVerifier` (chain id, exports, oracle identity); 9 assets parse; a registered account with debt parses with the current `get_account` schema |
| Oracle `priceoracle.testnet`                                      | Named by Burrow `get_config`; exports verified; **returned no fresh price for any listed asset**, so no testnet decision can currently be priced          |
| Rhea v1 `ref-finance-101.testnet`                                 | Has code; `get_pool` and `get_return` answer (2894 pools)                                                                                                 |
| Rhea DCL `dclv2.ref-dev.testnet`                                  | Exports every source-verified method; `list_pools` needs paging (unpaged it exceeds view gas); quotes and market depth parse                              |
| Tokens `wrap.testnet`, `usdt.fakes.testnet`, `usdc.fakes.testnet` | Code deployed; `ft_metadata`: wNEAR/24, USDT.e/6, USDC.e/6; export the methods the planners call                                                          |
| Rhea v1 pool prices                                               | Pools pairing wNEAR with the fake stables exist (e.g. #34, #54) but are not price-meaningful (1 wNEAR quotes ~2.2e22 raw USDT.e): keep `rhea.pools` empty |
| Pipeline, `DATA_SOURCE=chain`, dry-run                            | With an unregistered account the legacy cycle fails closed (`UNKNOWN_ACCOUNT`) and the orchestrator records `SNAPSHOT_UNAVAILABLE` and does nothing       |

Not verified: any transaction (the autopilot ships no signer; the separate testnet-only `testnet-tx` tool had not sent one when this was written), the mainnet Burrow `get_account` shape, the mainnet oracle
id. The public RPC rate-limits (HTTP 429) under the live suites; rerun or use a dedicated endpoint.

## Pre-mainnet checklist

The adapters validate responses strictly, so a wrong assumption fails closed, but verify on **testnet**
(or against mainnet in `dry-run`, which only reads) before relying on any planner:

- [ ] Run the read-only Burrow live test against your target network (`BURROW_LIVE=1 pnpm --filter
@near-autopilot/burrow-adapter test:live`): it verifies the chain id, the deployed Burrow and oracle code, and
      that assets and the oracle parse. Treat a testnet failure as "testnet deployment unusable", not as flakiness.
- [ ] `BURROW_ORACLE_ID` equals the oracle your deployment reports in `get_config` (verification refuses otherwise);
      the built-in mainnet default `priceoracle.near` has not been confirmed against the chain.
- [ ] Consider pinning `allowedCodeHashes` in the `BurrowVerifier` options once you have audited a deployed version.
- [ ] Balances from Burrow are INNER units (`raw × 10^extra_decimals`); the adapter converts, but spot-check one position by hand.
- [ ] The Burrow `Execute` repay/increase-collateral messages are accepted by a real `ft_transfer_call` on testnet
      (the argument shapes rest on contract and frontend source; they have not been executed by this project).
- [ ] `get_return` and the Rhea instant-swap message (`force`, `actions[]`) match the exchange contract you point at,
      and swap output reaches the wallet (check whether your account needs a storage deposit on the exchange).
- [ ] Gas defaults (180 Tgas swap; Burrow `ft_transfer_call` 100 Tgas, `execute` 50 Tgas, copied from the Burrow frontend) suffice; unused gas is refunded.
- [ ] Run several `dry-run` cycles and review the `proposals` and `audit_events` tables.
- [ ] Reconcile a deliberately interrupted run (kill the API between `approved` and execution) to practise recovery.

## Operational notes

- Keep `maxActionUsd`, `dailyLimitUsd` and `approvalThresholdUsd` small until you trust the system.
- `policy.enabled: false` is the kill switch; restart the API after editing the config file.
- Run Postgres with backups; `audit_events` is the forensic record.
- Put the API behind a private network; compose binds ports to `127.0.0.1` by default.
