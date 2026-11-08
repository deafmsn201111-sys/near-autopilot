# TECHNICAL_RISKS

_Phase 0 deliverable. Engineering risks with likelihood/impact and mitigation. Security-specific threats live in `SECURITY_THREAT_MODEL.md`._

Scoring: Likelihood (L) and Impact (I) each Low/Med/High.

| ID | Risk | L | I | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | **Scope vs. honesty**: brief asks for autonomous execution; the only safe path (Guard contract) is large and unbuilt. Pressure to fake autonomy. | H | H | Keep Autonomous mode locked until Guard exists + external review. Never present simulation as live (brief §20). Autonomy ladder documented in TARGET_ARCHITECTURE §4. |
| R2 | **Guard contract complexity**: async callbacks, reserve-before-execute, replay/concurrency, Emergency Stop are hard to get right on NEAR. | H | H | Testnet-first, adversarial tests (brief §18), no mainnet deploy without independent review. Reserve limits before external calls; verify callbacks; reconcile results. |
| R3 | **Rewrite temptation**: treating existing working modules as disposable → regressions + wasted effort. | M | H | Policy: extend, don't rewrite (TARGET_ARCHITECTURE). `pnpm verify` green gate every change. Regression guardrails in PROJECT_AUDIT §7. |
| R4 | **Duplicated risk logic** (3 HF implementations, 2 guardians/rebalancers) diverge and give conflicting answers. | M | H | Consolidate into one risk core (B/P3) with exact bigint math; keep float only for display. |
| R5 | **Protocol schema drift** (Burrow/Rhea change return shapes) breaks snapshots silently. | M | H | Accept both shapes defensively; live testnet fixtures; freshness/validation in data-guard; fail to `degraded`, not to fabricated data. |
| R6 | **Data provenance leakage**: estimates/predictions shown as on-chain facts. | M | H | System-wide provenance tiers (TARGET §5); UI must render the tier; tests assert tagging. |
| R7 | **LLM illusion**: UI implies model reasoning/confidence that doesn't exist. | M | M | No fabricated confidence. If `LlmClient` is added, validate+schema-check outputs; heuristics remain the safe default. |
| R8 | **Single-vCPU / 1GB demo server** can't run heavier intelligence or a Rust build. | M | M | Keep heavy build on dev/CI; demo stays read-only shadow. Guard/contract build in CI, not on the demo box. |
| R9 | **Secret handling** (RPC keys, API token, DB password) across environments. | L | H | Never log secrets; `.dockerignore` + image scan; env-only; separate per-env values. |
| R10 | **No user/session model yet** but target implies per-user policies/sessions. | M | M | Introduce User/Policy/Session data model in P1/P2 before multi-user features; keep single-operator path working. |
| R11 | **CI lacks Rust + contract tests** once Guard lands. | M | M | Add contract build/test job to `ci.yml` when `contracts/` is introduced. |
| R12 | **Migration safety** (24 tables, live demo has data) — a bad migration could drop history. | L | H | Additive migrations; never `down -v` on the demo; test migrations in CI `db` job against real Postgres. |
| R13 | **Mainnet wallet-confirm branch drift**: it holds real signing logic and has never been pushed/merged; risk of bit-rot or accidental loss. | M | M | Fold its logic into the gated Approve-mode work (P4/P6) under review; keep the dry-run invariant until then. |
| R14 | **Marathon scope / context loss** across many sessions. | H | M | Maintain `PROJECT_STATUS.md` / `IMPLEMENTATION_LOG.md` / `DECISIONS.md`; per-phase factual reports; dependency-ordered backlog. |

## Top-3 to watch continuously
1. **R1/R2 — do not ship or imply unreviewed autonomous mainnet execution.**
2. **R3 — extend, don't rewrite; keep `verify` green.**
3. **R6/R7 — never present estimates, predictions, or absent LLM reasoning as fact.**
