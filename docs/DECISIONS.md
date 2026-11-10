# DECISIONS

_Architecture Decision Record (lightweight). Each entry: context → decision → consequences._

## D1 — Extend the existing architecture; do not rewrite from scratch

**Context:** 9 of the 13 target layers already have a real home (orchestrator with 4 agents, policy engine, adapters, risk, audit, idempotency). The brief forbids rewriting working architecture without evidence (§23).
**Decision:** Treat the transformation as extend/specialize/consolidate on top of the current monorepo; only the Guard contract is fully net-new.
**Consequences:** Lower regression risk, faster delivery, keeps `verify` green. Requires discipline to resist greenfield rewrites.

## D2 — Autonomy stays locked until a Guard contract exists and is independently reviewed

**Context:** Brief wants autonomous execution but also "SECURITY ALWAYS" and "no autonomous mainnet by default"; owner explicitly dropped _fully_ autonomous autopilot as unsafe/off-putting.
**Decision:** Autonomy ladder = Observe (now) → Approve (owner signs in wallet) → Autonomous (Guard-enforced, off by default, post-review). Autonomous mode is shown as locked/roadmap, never faked.
**Consequences:** Honest product; execution work (P6) is hard-gated on Guard (P5) + review.

## D3 — No fabricated intelligence

**Context:** No LLM is wired; heuristics only. UIs could imply model confidence that doesn't exist.
**Decision:** Never display fabricated AI confidence. If an `LlmClient` is added, it is an additional, schema-validated agent with heuristics as the safe fallback; disabled by default.
**Consequences:** Trustworthy UX; aligns with brief §21.

## D4 — System-wide data provenance tiers

**Context:** Brief §5/§16 require distinguishing verified on-chain facts from estimates/predictions.
**Decision:** Introduce a provenance enum in `core` and thread it through DTOs and UI; missing data returns explicit `unavailable|degraded`.
**Consequences:** Small cross-cutting change early (P1) that many later features depend on.

## D5 — Keep the dry-run / `loadSigner()=null` invariant on `main`/`fix/audit`

**Context:** It is the backbone safety property.
**Decision:** No change to this on shared branches; any signing lands behind review on gated branches/flags.
**Consequences:** Shared branches remain safe to deploy (e.g. public demo).

## D6 — Target architecture confirmed from the master brief

**Context:** The planner's Claude Docs document never shipped; the owner supplied the full master prompt directly.
**Decision:** Use the master brief (§4 thirteen layers) as the authoritative target. (Superseded by `REWORK_PLAN.md` and `HACKATHON_PLAN.md`.)
**Consequences:** No further blocking on an external doc; proceed through the roadmap.

## D7 — Mainnet only; DB names kept as history

**Context:** Testnet code paths (`NEAR_NETWORK=testnet`, `MARKET_DATA=mainnet-reference`, `YIELD_DATA=testnet-onchain`,
testnet deployments in the adapters) made the code and the README tell different stories (#12).
**Decision:** The env schema accepts only `NEAR_NETWORK=mainnet`, `MARKET_DATA=none|mainnet-live`,
`YIELD_DATA=none|mainnet-onchain`. The database is not migrated: the `testnet_transactions` table, the `testnet_token`
column and the CHECK constraints that still allow `'testnet'` stay as history; only the TypeScript field is renamed
(`token`). Reads are filtered to the deployment's own provenance, which is mainnet.
**Consequences:** No migration risk on the VPS. `packages/db/src/schema.ts` and the migrations keep the word
"testnet". `EXECUTION_MODE=live` is now always refused; its removal belongs to #13.
