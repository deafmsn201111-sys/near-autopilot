# IMPLEMENTATION_ROADMAP

_Phase 0 deliverable. Dependency-aware phases (brief §19) + a decomposed, prioritized backlog. Priorities: P0 infra/security/data-integrity · P1 essential product · P2 important · P3 optional. Each task has an id, dependency, and acceptance criteria. Status is tracked in `PROJECT_STATUS.md`; nothing here is "done" until acceptance criteria + tests pass (brief §22)._

## Phase overview & deliverables

| Phase | Theme | Deliverable | Gate |
| --- | --- | --- | --- |
| P0 | Discovery | Verified audit docs (this set) | ✅ produced |
| P1 | Architecture foundation | Data contracts, provenance tiers, User/Policy/Session model, threat model | `verify` green + contracts reviewed |
| P2 | Data Intelligence | `DataProvider` abstraction, normalization, validation, freshness | reliable data foundation + tests |
| P3 | Intelligence core | Market/Portfolio/Yield/Opportunity/Risk, consolidated risk, Opportunity Score | integrated analytics + tests |
| P4 | AI & decision | Orchestrator primary, specialized agents, decision records, Observe/Approve UI, explainability | parity w/ legacy + tests |
| P5 | Security & Guard | Guard contract, limits, Emergency Stop, testnet, adversarial tests | testnet verified + external review |
| P6 | Autonomous execution | Protocol adapters, delegated auth / Vault, tx lifecycle | controlled execution (gated) |
| P7 | Learning/optimization | Backtesting, attribution, model/strategy versioning | reproducible eval |
| P8 | Product finalization | UX/responsive/a11y/perf/monitoring/docs | release candidate |

## Backlog (decomposed)

### Initiative I1 — Foundation & data integrity (P1/P2)
- **I1-E1 Data contracts & provenance**
  - `T1.1` Define provenance enum (`on_chain_verified|external_market|protocol_reported|calculated_estimate|ai_prediction`) in `core`. _Dep: —. AC: type + tests; one producer tagged end-to-end._
  - `T1.2` Thread provenance through `portfolio-view`/`prices`/`opportunities` DTOs. _Dep: T1.1. AC: API returns tier per value; snapshot tests._
  - `T1.3` Explicit `unavailable|degraded` status instead of fabricated fills. _Dep: T1.1. AC: data-guard test forces degraded; UI shows it._
- **I1-E2 Domain data model (brief §16)**
  - `T1.4` Add User, Wallet, UserPolicy, AgentSession, Operation, ExecutionResult, ModelVersion entities (schema + migrations, additive). _Dep: —. AC: migration runs in CI `db` job; single-operator path unaffected._

### Initiative I2 — Intelligence core (P3)
- **I2-E1 Risk consolidation**
  - `T2.1` One risk core; exact bigint HF; float only for display; delete duplicate decision paths. _Dep: T1.1. AC: one HF source; existing risk tests pass; conflicting-impl test removed._
  - `T2.2` Protocol/token/strategy/portfolio risk profiles + independent rejection rule. _Dep: T2.1. AC: a critical-risk case blocks a high-yield opportunity in a test._
- **I2-E2 Opportunity Score**
  - `T2.3` Documented, configurable score (gross/net APY, fees, slippage, liquidity, TVL, maturity, contract risk, IL, sustainability). _Dep: T2.1. AC: methodology doc + unit tests; score is comparative, not a profit guarantee._
  - `T2.4` Recommended/Watchlist/Rejected buckets with reasons. _Dep: T2.3. AC: API returns buckets; rejected carries reason._

### Initiative I3 — Multi-agent AI & decisions (P4)
- **I3-E1 Promote orchestrator**
  - `T3.1` Make `orchestrator` the primary engine; keep `legacy` behind the flag until parity proven. _Dep: I2. AC: parity test vs legacy on fixtures; `verify` green._
  - `T3.2` Specialized agents: Portfolio, Yield, Strategy, Execution (typed I/O, limited permissions, logging, version). _Dep: T3.1. AC: each agent schema-validated; Risk agent independent of Strategy._
  - `T3.3` Decision records (id, inputs+timestamps, assumptions, expected result, risk, fees, permissions, expiry, rejection conditions). _Dep: T3.2. AC: persisted + surfaced; expiry enforced._
  - `T3.4` (Optional) `LlmClient` against Claude API as an additional agent; heuristics remain fallback. _Dep: T3.2. AC: output schema-validated; disabled by default; no fabricated confidence._
- **I3-E2 Explainability** — `T3.5` per-decision "who proposed / why" in Activity + Dashboard. _Dep: T3.3._

### Initiative I4 — UX (parallel where unblocked) (P1/P2)
- `T4.1` Flow audit + fix the reported "not usable" blockers (wallet connect, demo↔account, what the agent can actually do). _Dep: T1.2 (for honest labels). AC: usability pass documented; flows verified in the running app._
- `T4.2` New IA: Dashboard, Portfolio, Opportunities, Strategies, Autopilot, Activity, Risk Center, Research, Settings. _Dep: T4.1._
- `T4.3` Autopilot center with honest Observe/Approve/(Autonomous=locked) + limits/session/agent health/Emergency Stop. _Dep: T3.3, T5.*._
- `T4.4` Risk Center page. _Dep: T2.2._
- `T4.5` Activity with explicit states (Proposed→Validated→Awaiting Approval→Submitted→Confirmed→Failed→Rejected→Cancelled). _Dep: T3.3._
- `T4.6` Responsive/a11y/perf pass. _Dep: T4.2._

### Initiative I5 — Guard & execution (P5/P6) — **hard-gated**
- `T5.1` Guard contract (`contracts/guard`, Rust/NEAR SDK): ownership, agent auth, allowlists, per-op/daily/loss/slippage limits, session expiry, replay protection, pending-op tracking, Emergency Stop, auditable events. _Dep: I1-E2. AC: unit + adversarial tests (brief §18 list) on testnet._
- `T5.2` Guard client + CI Rust job. _Dep: T5.1._
- `T5.3` Execution adapters per protocol (only via Guard); min-output, state tracking, reconciliation. _Dep: T5.2. AC: never reports success pre-confirmation; no fabricated hashes._
- `T5.4` Merge wallet-confirm (Approve mode) logic under review. _Dep: T5.1 or standalone (owner-signs path needs no Guard). AC: dry-run invariant until reviewed._

### Initiative I6 — Learning & ops (P3/P7)
- `T6.1` Backtesting + performance attribution over history. `T6.2` Model/strategy versioning. `T6.3` Ops metrics/alerting (data freshness, agent latency, exec success, Guard rejections).

## Sequencing rule
Work the critical path (DEPENDENCY_MAP §3). UX (I4) and risk/opportunity (I2) can proceed in parallel with foundation (I1). Anything "autonomous mainnet" waits on I5 + independent review. Report factually at each phase end (brief §23).

## Immediate next tasks (after P0)
1. `T1.1` provenance enum in `core` (+ tests).
2. `T2.1` risk consolidation scoping (identify the 3 HF impls, pick the authoritative one).
3. `T4.1` usability flow audit of the running app (addresses the owner's main complaint).
