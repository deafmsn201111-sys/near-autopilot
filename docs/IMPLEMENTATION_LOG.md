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

## 2026-11-10 — Security 1: guard `/api/prepare` (#9)

- `apps/analytics/app/api/prepare/route.ts` answers 415 unless `content-type` is `application/json` (also blocks
  cross-site form posts) and 429 with `retry-after` over 30 calls per visitor / 600 overall per 10 minutes.
- The in-memory limiter moved from `lib/public-demo.ts` to `lib/rate-limit.ts` and is always on for prepare. The
  visitor key is the `X-Forwarded-For` that Caddy overwrites. Map bounding stays with #11.

**Tests run:** `pnpm verify` (green), new `apps/analytics/test/prepare-route.test.ts`.
