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

## 2026-11-08 — T3.1 orchestrator-as-primary (de-risked)

**Inspected:** both cycle engines (`services/cycle.ts` legacy, `services/orchestrated-cycle.ts`), the `wire()` composition root and its test harness, config cross-field rules, and the demo compose (already sets `AUTOPILOT_ENGINE=orchestrator`).

**Implemented:**

- `apps/api/test/orchestrated-cycle.test.ts` (3 tests): runs a full cycle through the real `wire()` on both engines over the deterministic simulated portfolio (no network) and asserts safety equivalence — both complete, the orchestrated path is exercised (engine tag), and neither produces a tx hash (dry-run invariant).
- Documented the engine/live coupling in `packages/config/src/index.ts` (default stays `legacy`; orchestrator is the demo engine).

**Finding:** flipping the global default to `orchestrator` breaks live-capable configs (orchestrator is dry-run-only), so the default stays `legacy`; the demo already runs the orchestrator. Recorded as D9.

**Changed files:** `apps/api/test/orchestrated-cycle.test.ts` (new), `packages/config/src/index.ts` (comment), `docs/*` (status/log/decisions).

**Tests run:** `pnpm --filter api test -- orchestrated-cycle` (3 passed); `pnpm verify` → 15/15 green.

**Remaining / next:** `T3.2` first new specialized agent (Portfolio Intelligence); `T3.3` decision records; `T3.5` surface the roster + per-decision explainability in the UI.

## 2026-11-08 — T3.2 Portfolio Intelligence agent

**Implemented (first new specialized agent, brief §7/§10):**

- New advisory proposal kind `portfolio.signal` (signal `concentration`, `exposureBps`) in `proposals.ts`, with a new `portfolio-intelligence` `AgentId`, capability (`no_action` + `portfolio.signal`), descriptor, and `ADVISORY_KINDS` membership.
- `PortfolioIntelligenceAgent`: computes each token's share of gross assets (wallet + Burrow supplied + collateral; debt excluded) and raises a `concentration` signal (severity 2–5) when one asset dominates. Reads plain snapshot data; never proposes a trade.
- Decision engine ingests `portfolio.signal` as a caution on the over-exposed token (same mechanism as `market.signal`), so a severity≥4 concentration defers a discretionary action on that token. `Caution.signal` widened to include portfolio signal types.
- Wired `PortfolioIntelligenceAgent` into the orchestrator (`wiring.ts`).

**Changed files:** `packages/orchestrator/src/proposals.ts`, `src/types.ts`, `src/decision-engine.ts`, `src/agents/portfolio-intelligence.ts` (new), `src/index.ts`, `apps/api/src/wiring.ts`; tests `packages/orchestrator/test/unit/portfolio-intelligence.test.ts` (new, 5), `decision-engine.test.ts` (+3), `proposals.test.ts` (sample); `apps/api/test/simulation.test.ts` (roster now 5 agents); regenerated `docs/evidence/demo-attack.log.jsonl` (the discriminator error now lists the new kind).

**Tests run:** `pnpm --filter orchestrator test` → 241 passed; `pnpm verify` → 15/15 green. demo:attack → 8/8 attacks stopped (defences intact).

**Remaining / next:** `T3.3` decision records; `T3.5` surface roster + per-decision explainability in the dashboard.

## 2026-11-08 — T3.5 Agent roster in the UI (first visible transparency)

**Implemented:**

- `/v1/analytics/agents` endpoint (`apps/api/src/analytics/server.ts`) exposes the static agent roster from `AGENT_DESCRIPTORS` (bearer-authed like every `/v1/*`).
- New dashboard page `apps/analytics/app/agents/page.tsx` ("The agents"): one card per agent — title, responsibility, version, the proposal kinds it may emit (plain labels), and an advisory/can-act tag. Explains that agents only propose, the policy checks everything, and nothing is signed or sent. Added to the reviewers tabs (`Nav.tsx`) and styled (`globals.css` `.agent-grid`/`.agent-card`).

**Changed files:** `apps/api/src/analytics/server.ts`, `apps/analytics/app/agents/page.tsx` (new), `apps/analytics/components/Nav.tsx`, `apps/analytics/app/globals.css`; test `apps/api/test/agents-endpoint.test.ts` (new, 2).

**Tests run:** endpoint test 2/2; `pnpm verify` → 15/15 green; `pnpm --filter analytics build` → ok (`/agents` route built).

**Honest note:** this is the static roster (who the agents are). Per-decision attribution (who proposed what in a given run) is `T3.5b`. Visual confirmation needs a local view or a demo redeploy — the live demo still runs the pre-T3.5 bundle until redeployed.

**Next:** `T3.5b` per-decision explainability in Activity; `T3.3` decision records.

## 2026-11-08 — T3.5 follow-up + T3.5b scoping

**Implemented:** added an honest "How a decision is made" flow to the `/agents` page (agents propose → safety policy checks → you approve → your wallet signs; nothing signed/sent on the demo). Pure UI; analytics build ok.

**T3.5b (per-decision attribution) — scoping/decision:** the full per-agent conclusions (including advisory `no_action`/signals) live in the orchestrator run snapshot (`runs.snapshot.agents` jsonb); actionable proposals also live in the `proposals` table (`agentId`/`kind`/`summary`/`reason`/`status`). A clean "latest activity per agent" needs a SELECT-only endpoint over those, plus db-backed test data. Deferred to its own focused slice rather than rushed.

**Decision:** did NOT add a Yield Intelligence agent now — it would duplicate the capital allocator's net-benefit logic, which the brief (§10) warns against ("do not use multiple agents merely for architectural appearance").

**Next:** `T3.5b` db-backed `/v1/analytics/agents/latest` (latest run's per-agent conclusions) → show on `/agents`; `T3.3` decision records.

## 2026-11-08 — T3.5b Per-decision agent activity (live, verified on real data)

**Implemented:**

- Pure mapper `apps/api/src/analytics/agent-activity-latest.ts` (`mapAgentActivity`) that turns a stored orchestrator run snapshot (`runs.snapshot.agents`) into a plain per-agent view: each agent's conclusions, using the agent's OWN recorded rationale (never fabricated).
- Endpoint `/v1/analytics/agents/latest` (SELECT-only: latest completed orchestrator run) in `analytics/server.ts`.
- `/agents` page now shows, per agent, its "Latest cycle" conclusion(s) and a "Last cycle <ago>" note — fetched alongside the roster.

**Changed files:** `apps/api/src/analytics/agent-activity-latest.ts` (new), `apps/api/src/analytics/server.ts`, `apps/analytics/app/agents/page.tsx`, `apps/analytics/app/globals.css`; test `apps/api/test/agent-activity-latest.test.ts` (new, 3).

**Verification:** mapper unit test 3/3; `pnpm verify` 15/15; analytics build ok. Ran a LOCAL current-code analytics API against the live dev Postgres and confirmed the endpoint returns the latest run's real per-agent rationale, and the `/agents` page renders the "Latest cycle" blocks (e.g. "position risk is healthy").

**Local run for the owner to poke:** dashboard (current code) at http://127.0.0.1:3007, agents page at /agents. Backed by a local analytics API (tsx) on :4013 over the existing dev Postgres.

**Note:** the running dev collector is still the pre-transformation 4-agent bundle, so the latest stored run shows 4 agents; portfolio-intelligence appears once the collector runs current code (or on a fresh cycle).

**Next:** `T3.3` decision records (id, inputs, expiry, rejection conditions); consider a Strategy agent.

## 2026-11-08 — T3.3 Decision expiry (traceability, brief §11)

**Context:** the orchestrator `Decision` was already a rich, traceable record (decisionId, inputsHash, timestamp, risk, ranked candidates with economics, rejected with codes, cautions, dataQuality). The one genuine §11 gap was an explicit **expiry**.

**Implemented:**

- `Decision.expiresAt` (`packages/orchestrator/src/types.ts` + `decision-engine.ts`): the earliest point the decision's data would go stale — `min(snapshot.takenAt + maxSnapshotAgeSeconds, pricesAsOf + maxPriceAgeSeconds)`. After it, the data guard blocks action anyway. Honest validity window; no fabricated confidence.
- Persisted `decisionId` + `expiresAt` into the orchestrator run snapshot (`orchestrated-cycle.ts`), so the decision's identity and validity are traceable in the record.

**Changed files:** `packages/orchestrator/src/types.ts`, `src/decision-engine.ts`, `apps/api/src/services/orchestrated-cycle.ts`; tests `decision-engine.test.ts` (+2).

**Tests:** orchestrator 243 pass (+2); api 270 pass; `pnpm verify` 15/15 green.

**Note:** we deliberately did NOT add a fabricated model "confidence" (brief §21); `dataQuality` is the honest uncertainty signal. Surfacing `expiresAt` in the UI follows a current-code cycle (the running dev collector is still the old bundle).

**Next:** consider a Strategy agent (compare candidate strategies) or begin consolidating the duplicate risk logic (T2.1).

## 2026-11-08 — UX + T2.1 + Risk Center (owner: "1 then 2 then 3")

**1. UX usability (home orientation):** added a short intro on a demo portfolio (simulated portfolio on live prices; the agent only proposes; use "Your account" / connect wallet for your own, read-only) and dimmed the two locked mainnet modes so they no longer read as active tabs. `apps/analytics/app/page.tsx`, `components/ModeSwitch.tsx`, `globals.css`. Verified live.

**2. T2.1 health-factor consolidation:** investigated the "3 duplicate HF" concern. Finding: in the production orchestrator path `risk.ts` healthFactorWad (authoritative) and `lending.ts` healthFactorBps (legacy) use the same risk parameter — one quantity at two scales; the float form is display-only. Added `financial-engine/test/hf-consistency.test.ts` pinning that they never diverge; documented the authoritative one; updated KNOWN_ISSUES. Did NOT force a risky single-function merge pre-deadline (burrow-adapter's separate USD18 HF noted as lower-priority).

**3. Risk Center (brief §15):** new `/risk` page over `/v1/analytics/risk` — per-portfolio risk level, health factor, buffer-to-liquidation, LTV, borrowed/collateral, stress scenarios, plus an honest "controls that keep you in charge" section (policy-checked; nothing signed/sent; on-chain Guard = roadmap). Added to reviewers tabs. Verified live.

**Also this turn:** ran a current-code collector cycle (`--once`) so the live demo data shows all 5 agents incl. portfolio-intelligence ("89.2% …") and a decision with expiry; paused the old dev collector to keep that view. Fixed a dev-server layout break caused by multiple stale `next dev` servers sharing one `.next`.

**Tests:** `pnpm verify` 15/15 green after each slice. Commits: a4c597a (UX), 58b4de2 (T2.1), 4f7a8e8 (Risk Center).

## 2026-11-08 — Opportunities grouping + Data provenance + UX (owner: "all 3 without stopping")

**1. Opportunities (brief §8):** grouped the list into Recommended / Watchlist / Not-enough-data by status, each with a count; watch items show their blocker; ranking method + excluded reasons stay in the explainer. `opportunities/page.tsx`.

**2. Data provenance (brief §5):** new `core` vocabulary `PROVENANCE_TIERS` + `PROVENANCE_TIER_INFO` (on-chain fact / external market / protocol-reported / calculated estimate / model prediction) with trust levels (3 core tests). New `ProvenanceNote` legend shown on Opportunities, Risk and Agents — makes explicit that scores/APYs/risk are estimates, prices external, on-chain is fact, nothing is a prediction, and no model is used.

**3. UX deepening:** honest capability banners on the home page — a demo intro (already) and now a real-account banner ("read-only; the agent holds no key and cannot sign or send; only your wallet can, gated"). Also fixed the reviewers portfolios table to list all 5 agents, and added the autonomy-mode ladder (Observe/Approve/Autonomous) to the Autopilot page.

**Tests:** `pnpm verify` 15/15 green after each slice. Commits: 15409d9 (opportunities), 72c6825 (provenance), a5e1fa0 (account banner), plus 1335b43 (autonomy ladder), 2faf899 (portfolios agent list).
