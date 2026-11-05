# Audit evidence: the hash chain and replay

Two kinds of evidence are kept in Postgres. Both can be checked by anyone with read access to the database, with one
command each. Nothing is fetched or executed.

| Command             | What it proves                                                                       |
| ------------------- | ------------------------------------------------------------------------------------ |
| `pnpm audit:verify` | No audit entry was changed, removed or inserted out of order since it was written    |
| `pnpm audit:replay` | Every stored policy verdict follows from its stored inputs under the policy it names |

Both print one JSON object per line and a summary line. They exit 1 on a broken chain or a replay mismatch. They read
`DATABASE_URL` from the environment and never print it. In the Docker stack, run them in any API container:

```bash
docker compose exec api-shadow node --import tsx src/evidence/cli.ts verify
docker compose exec api-shadow node --import tsx src/evidence/cli.ts replay --config /etc/autopilot/autopilot.json
```

## The hash chain (`audit_events`, migration 0011)

**One chain per deployment.** The chain id is `<dataSource>:<network>`: `simulation:testnet` (API on 4000),
`chain:testnet` (testnet API), `simulation:mainnet` (shadow API and collector). Every event of the legacy cycle and of
the orchestrator is appended to it, with:

```
hash = sha256( prev_hash || canonicalJson({ seq, at, type, runId, proposalId, payload }) )      prev_hash(1) = 0 x 64
```

- **It lives in the database, not in a process.** The head is read inside the same transaction that appends, under an
  advisory lock on the chain, so the chain continues across restarts. The API and the collector both write to
  `simulation:mainnet`; they queue on the lock. The unique `(chain, seq)` index makes a fork impossible.
- **Append-only, enforced twice:**
  - a trigger refuses `UPDATE` and `DELETE` of chained rows;
  - the chain does not depend on the trigger. A table owner can disable it, but any change then breaks the hash of
    that entry, and a re-hashed change breaks the link from the next entry. `verify` reports the first broken `seq`
    and the kind of break: `hash`, `prev_hash` or `gap`.
- **The head `{ seq, hash }`** commits to the whole history. To make it evidence outside this database, publish it,
  for example in a commit or a post.
- **Not covered:** rows written before migration 0011 have no chain. They are kept unchanged, never rewritten, and are
  counted in the summary as `unchainedRowsBeforeMigration0011`.
- **API:** `GET /v1/audit?limit=50` returns the newest entries with their hashes. `GET /v1/audit/verify` re-verifies
  this deployment's chain.

## Replay (`policy_verdicts`)

**What each verdict stores:**

- its full input: intent, plan, snapshot and history;
- since stage 4, the policy config it ran under.

**What replay checks** (`apps/api/src/evidence/replay.ts`). It rebuilds the typed input from the row and checks, in
order:

1. **config**: the config hashes to the stored `policyVersion`. A config edited after the fact no longer matches.
2. **snapshot_id**: the decoded snapshot hashes to the stored snapshot id. This proves the decoded input is the one
   that was evaluated.
3. **plan_hash**: the decoded plan hashes to the stored plan hash.
4. **verdict**: the policy engine runs again with the clock fixed at the stored evaluation time, so freshness and
   cooldown are judged as then. Verdict, outcome, all 12 checks, every violation and the valuation must be identical.

**Results:**

- `match`;
- `mismatch` with the failing stage and the difference;
- `not_replayable`.

**Rows stored before config recording** (stage 2 and 3) carry only the config hash. They are replayed with a config
supplied by `--config <file>`, and only if its version is exactly the stored one. Otherwise they are reported as
`not_replayable`, never guessed.

A change to the rules code without a new `RULES_VERSION` shows up as a `verdict` mismatch.
