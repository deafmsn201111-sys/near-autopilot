# Policy verdicts

Every action an agent proposes is planned into a transaction and evaluated by the policy engine
(`packages/policy-engine`). The engine runs **all 12 checks every time** (no short-circuit) and returns a decision:

| Verdict | Outcome            | Meaning                                                    |
| ------- | ------------------ | ---------------------------------------------------------- |
| `ALLOW` | `approve`          | every check passed; the plan may be approved and executed  |
| `WARN`  | `require_approval` | only approval-severity checks failed; a human must approve |
| `BLOCK` | `reject`           | at least one check rejected; nothing is executed           |

Each decision carries:

- `checks`: one entry per rule — `kill_switch`, `signer`, `price_freshness`, `native_reserve`, `contract_allowlist`,
  `token_allowlist`, `action_shape`, `intent_match`, `value_limits`, `max_slippage`, `oracle_deviation`, `cooldown` —
  with `PASS` / `WARN` / `BLOCK` and the messages;
- `policyVersion`: `rules-<version>+cfg:<16 hex of sha256(canonical policy config)>`. Two decisions with the same
  version were made under the same rules **and** the same limits; changing any limit changes the version;
- `snapshotId`: `sha256:<hex>` of the canonical snapshot (balances, lending position, prices, risk, tokens): the same
  inputs always give the same id;
- `planHash`: sha256 of the canonical plan; an approval is bound to it.

## Storage: `policy_verdicts`

Both decision paths (the legacy cycle and the orchestrator) store every verdict **before** acting on it: if the
write fails, the cycle stops and nothing is executed. Rows are append-only and keep the full evaluation input
(`intent`, `plan`, `snapshot`, `history` as canonical JSON, and since stage 4 the policy `config`), so a decision can
be re-evaluated with `pnpm audit:replay` ([audit-evidence.md](audit-evidence.md)). The table refuses
a verdict that contradicts its outcome (`policy_verdicts_consistent_check`). Migration `0009` only adds the table.

`GET /v1/policy/verdicts?limit=50&verdict=BLOCK` (bearer token) lists them, newest first, without the input.

Verdicts are written only when an agent actually proposes an action. In the read-only shadow analysis most cycles
propose nothing, so the table is legitimately empty until a proposal (or a labelled demo fixture) is evaluated.
