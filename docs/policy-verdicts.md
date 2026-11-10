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

Verdicts are produced by the collector's cycle (`apps/api/src/collector/main.ts`): on each market snapshot the
orchestrator runs on the two simulated demo portfolios, and every plan it proposes is evaluated here. The cycle stores
each verdict **before** acting on it: if the write fails, the cycle stops and nothing is executed (and execution is a
dry run through the [Shadow Gateway](shadow-gateway.md) anyway). Rows are append-only and keep the full evaluation
input (`intent`, `plan`, `snapshot`, `history` as canonical JSON, and since stage 4 the policy `config`), so a decision
can be re-evaluated with `pnpm audit:replay` ([audit-evidence.md](audit-evidence.md)). The table refuses a verdict that
contradicts its outcome (`policy_verdicts_consistent_check`). Migration `0009` only adds the table.

Read them on the site's `/policy` page, or from the analytics API (bearer token), newest first, without the full input:

```bash
curl -s -H "authorization: Bearer $API_TOKEN" 'http://127.0.0.1:4003/v1/analytics/policy/verdicts?limit=50&verdict=BLOCK'
```

Verdicts are written only when an agent actually proposes an action. Most cycles propose nothing, so the table is
legitimately empty until a proposal (or a labelled demo fixture) is evaluated.
