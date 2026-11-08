# DEPENDENCY_MAP

_Phase 0 deliverable. Package-level dependencies (enforced by `scripts/check-boundaries.mjs` + ESLint) and cross-layer build order._

## 1. Package dependency graph (current, acyclic)

```
core  ◄── everyone (domain types, ids, ports, api-contracts, chain-id guard)
config ◄── apps/*, collector
db    ◄── apps/api
near-adapter ──► core
burrow-adapter ──► core, near-adapter
rhea-adapter ──► core, near-adapter
rhea-dcl-adapter ──► core, near-adapter
financial-engine ──► core
agents ──► core, financial-engine
policy-engine ──► core
tx-execution ──► core            (does NOT import policy-engine; verifies via a core port)
orchestrator ──► core            (agents injected; ports decouple it from concrete adapters)
apps/api ──► all of the above (allowed edge api→orchestrator already in boundaries config)
apps/analytics ──► core (types), talks to apps/api over HTTP only
```

Rules of note:
- `tx-execution` must never import `policy-engine` directly — approval is verified through a `core` port (prevents a forged approval path).
- `orchestrator` depends only on `core` + injected ports; concrete adapters are wired in `apps/api/src/wiring.ts`.
- `apps/analytics` never imports backend packages except shared `core` types; all data flows over `/v1/*`.

## 2. Target new modules and where they attach

| New/extended module | Depends on | Consumed by | Build phase |
| --- | --- | --- | --- |
| `DataProvider` abstraction + provenance tiers | core, existing adapters | all intelligence layers | P2 |
| Risk core (consolidated) | core, financial-engine | orchestrator Risk Agent, Risk Center UI | P3 |
| `Opportunity Score` module | core, financial-engine, yield | Opportunities UI, Strategy Agent | P3 |
| Specialized agents (Portfolio/Yield/Strategy/Execution) | core, orchestrator ports | orchestrator | P4 |
| `LlmClient` (optional, Claude API) | core | `LlmAgent` | P4 (optional) |
| **Guard contract** (`contracts/guard`, Rust) | NEAR SDK | execution engine, Risk Center UI | P5 |
| Execution adapters (per protocol) | core, Guard client, adapters | Autonomous Execution Engine | P6 |
| Learning/backtest engine | core, history tables | Analytics, Strategy Engine | P7 |

## 3. Critical path (what blocks what)

```
Data contracts + provenance (P1/P2)
        │
        ├──► Intelligence core: Market/Portfolio/Yield/Opportunity/Risk (P3)
        │            │
        │            └──► Specialized agents + decision records (P4)
        │                          │
        │                          └──► Autopilot UI (Observe/Approve) + Risk Center (P4/P8)
        │
        └──► Guard contract (P5) ──► Autonomous Execution adapters (P6) ──► Autonomous mode (gated)
                                              │
                                              └──► Learning/optimization (P7)
```

- **Independent (can proceed in parallel):** UX flow rework for Observe/Approve (no Guard needed), data-provenance tagging, risk consolidation, opportunity scoring.
- **Hard-blocked:** anything "autonomous mainnet" is blocked on Guard (P5) + independent review. Do not simulate it as done.

## 4. External dependencies / integration risks

| Dependency | Used for | Risk |
| --- | --- | --- |
| NEAR RPC (FastNEAR / public) | all reads + any send | rate limits; key custody; outage → degrade, don't fabricate |
| Pyth Hermes | prices | staleness/confidence band (already checked ≤1%) |
| Binance/Coinbase/Kraken | price cross-checks | CEX API drift; treat as `external_market` provenance |
| DefiLlama | yields | `protocol_reported` provenance; can be stale |
| Burrow / Rhea contracts | positions, swaps, LP | schema drift (already a tracked risk); verify against testnet |
| NEAR SDK (Rust) | Guard contract | new toolchain in repo (adds Rust build to CI) |
| Claude API (optional) | LLM agent | cost, latency, output validation; must be fallback-safe |
