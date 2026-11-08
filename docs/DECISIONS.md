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
**Decision:** Use the master brief (§4 thirteen layers) as the authoritative target; `TARGET_ARCHITECTURE.md` maps it to existing code.
**Consequences:** No further blocking on an external doc; proceed through the roadmap.

## D7 — Run the transformation on a dedicated branch `feat/transformation`

**Context:** `fix/audit` is the hackathon submission branch and the source of the live public demo. The transformation touches the core.
**Decision (owner, 2026-11-08):** Branch `feat/transformation` from `fix/audit`; keep the submission/demo stable; merge deliberately once each phase is verified.
**Consequences:** Submission stays shippable; transformation can move without destabilizing the demo 6 days before the deadline.

## D8 — Prioritize core intelligence/agents over the full phase marathon (deadline-aware)

**Context:** 6 days to the hackathon deadline (2026-11-14). The full P1→P8 marathon (incl. Guard contract + autonomous execution) cannot be safely completed, and Guard cannot ship to mainnet without independent review anyway.
**Decision (owner, 2026-11-08):** Focus on P3→P4 — specialize the orchestrator agents (Market/Portfolio/Yield/Risk/Strategy), the decision engine, and explainability; minimal UX. Guard/autonomy stay documented roadmap, not built in mainnet.
**Consequences:** Effort goes where it strengthens the judged product; autonomy honestly shown as locked.

## D9 — Global default engine stays `legacy`; the orchestrator is the demo's engine

**Context:** The multi-agent orchestrator keeps its audit/idempotency state in memory, so config refuses `EXECUTION_MODE=live` with `AUTOPILOT_ENGINE=orchestrator`. Making `orchestrator` the global default therefore breaks every live-capable config (it would have to add `AUTOPILOT_ENGINE=legacy`).
**Decision:** Keep the global default `legacy` (the only engine that can run live). The public demo already selects `orchestrator` in `deploy/public/docker-compose.yml`, so the judged showcase runs the multi-agent engine. Added `apps/api/test/orchestrated-cycle.test.ts` proving the orchestrated path runs end-to-end through `wire()` and upholds the dry-run invariant.
**Consequences:** Live configs stay valid; the demo runs the multi-agent system; no magical engine auto-switching. Surfacing the agent roster in the UI is now safe (the demo runs the engine the roster describes).
