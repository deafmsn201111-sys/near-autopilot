# IMPLEMENTATION_LOG

_Append-only log of what was actually inspected/changed each session (brief §23)._

## 2026-11-08 — Phase 0 Discovery

**Inspected:**

- Ran `pnpm verify` → 15/15 green. API tests 261 passed / 38 skipped.
- Read live wiring (`apps/api/src/wiring.ts`): two engines, orchestrator behind `AUTOPILOT_ENGINE`, 4 heuristic agents wired, `LlmAgent` unwired.
- Read `signer.ts` → `loadSigner()` returns null (dry-run invariant confirmed).
- DB schema: 24 tables; migrations 0000–0016.
- Config: zod env schema (DATA_SOURCE, EXECUTION_MODE, AUTOPILOT_ENGINE, market/yield, RPC keys, CEX/DefiLlama/Pyth).
- HTTP surface: ~40 routes (read-only analytics + operator + health + gateway).
- No smart contract in repo (Guard = net-new). CI = verify job + Postgres db job.
- Probed live demo: real mainnet prices render.

**Changed files:**

- `docs/PROJECT_AUDIT.md`, `docs/CURRENT_ARCHITECTURE.md`, `docs/TARGET_ARCHITECTURE.md`, `docs/DEPENDENCY_MAP.md`, `docs/TECHNICAL_RISKS.md`, `docs/SECURITY_THREAT_MODEL.md`, `docs/IMPLEMENTATION_ROADMAP.md`, `docs/PROJECT_STATUS.md`, `docs/IMPLEMENTATION_LOG.md`, `docs/KNOWN_ISSUES.md`, `docs/DECISIONS.md` (all new).
- Earlier same day (pre-transformation): redeploy of public demo to `fix/audit` (no app code change in this step).

**Tests run:** `pnpm verify` (green). No code changed in P0 → no regression risk.

**Remaining issues / blockers:** target architecture confirmed from the master brief (planner doc never shipped). Autonomous execution blocked on Guard + review.

**Next:** P1 `T1.1` provenance enum.

## 2026-11-08 — Decisions + P4 agent core (slice 1)

**Decisions (owner):** D7 run on branch `feat/transformation`; D8 prioritize core intelligence/agents (P3→P4), not the full marathon (6 days to deadline). Recorded in `DECISIONS.md`.

**Implemented (slice 1 of agent core, brief §10 "each agent must have ... version information, defined responsibilities"):**

- `packages/orchestrator/src/proposals.ts`: added `AgentDescriptor`, `AGENT_DESCRIPTORS` (single source of truth for agent identity: id, title, responsibility, version, permitted proposal kinds, `advisoryOnly`), `ADVISORY_KINDS`, and `describeAgent()`. `proposalKinds` mirrors `AGENT_CAPABILITIES` so permissions and their description can't drift.
- `packages/orchestrator/test/unit/agent-descriptors.test.ts`: 5 tests asserting one descriptor per agent, permissions match the capability map, `advisoryOnly` correctness, semver versions, `describeAgent`.
- Formatted all `docs/*` with Prettier (P0 docs were committed unformatted).

**Changed files:** `packages/orchestrator/src/proposals.ts`, `packages/orchestrator/test/unit/agent-descriptors.test.ts`, `docs/*` (format + status/decisions/log updates).

**Tests run:** `pnpm --filter @near-autopilot/orchestrator test` → 233 passed (incl. 5 new). `pnpm verify` → green.

**Remaining / honest note:** the roster is not yet shown in the UI — that follows `T3.1` (promoting the orchestrator to the primary engine), so the dashboard never describes agents that aren't the ones actually running.

**Next:** `T3.1` orchestrator-as-primary with legacy parity test.
