# CURRENT_ARCHITECTURE

_Phase 0 deliverable. Describes the system as it actually runs today (branch `fix/audit`, HEAD `5128031`)._

## 1. Monorepo layout

```
apps/
  api/        Node HTTP backend: collector, analytics API, services, gateway, simulation, evidence  (~19.6k LOC)
  analytics/  Next.js 15 dashboard (App Router, server components)                                   (~4.9k LOC)
  dashboard/  Older/secondary UI surface                                                             (~0.7k LOC)
packages/
  core/             domain types, ids, api-contracts, ports, chain-id guard                 (1.1k)
  config/           zod env schema + autopilot config loader                                (0.3k)
  db/               Drizzle schema (24 tables), migrations (0000–0016), client              (0.7k)
  near-adapter/     NEAR JSON-RPC view-call client + snapshot building                      (0.7k)
  burrow-adapter/   Burrow client/reader/verify/builders/planner + Pyth oracle              (1.5k)
  rhea-adapter/     Rhea AMM quotes                                                          (0.3k)
  rhea-dcl-adapter/ Rhea concentrated-liquidity (DCL)                                        (1.2k)
  financial-engine/ valuation, lending, allocation, swap, risk, IL/yield                    (2.3k)
  agents/           legacy HealthGuardian + Rebalancer                                       (0.2k)
  policy-engine/    allowlists + 12 rules + approval minting                                 (0.6k)
  tx-execution/     dry-run + (would-be) live executor; approval verification                (0.3k)
  orchestrator/     multi-agent engine: 4 agents, decision-engine, escalation, stores        (4.3k)
```

Boundary rules are enforced by ESLint + `scripts/check-boundaries.mjs` (CI-gated). No dependency cycles.

## 2. Runtime cycle (the heart of the system)

```
        ┌─────────────────────────── snapshot ───────────────────────────┐
        │ near-adapter (view_account, ft_balance_of)                      │
        │ burrow-adapter (get_account, get_asset, get_price_data via Pyth)│
        │ rhea-adapter (pool quotes)      market-data (oracle+CEX+Pyth)    │
        └─────────────────────────────────┬───────────────────────────────┘
                                          │
            AUTOPILOT_ENGINE ────────────┤
                                          │
     ┌──────────── legacy (default) ──────┴───────── orchestrator (flag) ───────────┐
     │ agents: HealthGuardian, Rebalancer │ agents: MarketIntelligence, LpOptimizer, │
     │ → PlannerRegistry (Rhea/Burrow)    │   LiquidationGuardian, CapitalAllocator  │
     │ → PolicyEngine (12 rules)          │ → ProposalEnvelope → decision-engine     │
     │ → DryRunExecutor                   │ → PolicyGate → (same) executor           │
     │                                    │ + escalation, data-guard, idempotency    │
     └────────────────────┬───────────────┴───────────────┬──────────────────────────┘
                          │        one execution pipeline  │
                          ▼                                ▼
              DryRunExecutor (loadSigner()=null → never signs)
                          │
                          ▼
              PostgreSQL  (runs, proposals, policy_verdicts, audit_events, orchestrator_*, …)
                          │  write-through, fail-closed; audit_checkpoints chain
                          ▼
              apps/analytics (Next.js) ── reads /v1/analytics/* ──> browser
```

Both engines share the **same snapshot source, planners, policy engine and executor** — the orchestrator is not a parallel universe, it is an alternative coordination layer over the same safe pipeline.

## 3. Orchestrator internals (`packages/orchestrator`)

- **Agents** implement a common `ProposalAgent` port and emit proposals into a `ProposalEnvelope`.
  - `MarketIntelligenceAgent`, `LpOptimizerAgent`, `LiquidationGuardianAgent`, `CapitalAllocatorAgent` (wired).
  - `LlmAgent` (present, unwired, no `LlmClient` impl).
- **decision-engine.ts** ranks/merges proposals into a final structured decision.
- **escalation.ts** raises `info|warn|page` severities via a `Notifier`.
- **mode.ts / risk-state.ts** hold operating mode and data quarantine.
- **data-guard.ts** validates market data freshness/consistency before agents see it.
- **stores.ts / infra/orchestrator-stores.ts** — in-memory by default, durable Postgres `ControlStore` + `IdempotencyStore` when the API/collector inject them.
- Ports (`ports.ts`): `SnapshotProvider`, `MarketProvider`, `QuoteProvider`, `IntentPlanner`, `PolicyGate`, `ExecutionHistory`, `VerdictSink`, `Notifier`, `AuditLog`, `ControlStore`, `IdempotencyStore`.

## 4. Data model (PostgreSQL, 24 tables)

- **Decision/exec:** `runs`, `proposals`, `policy_verdicts`, `execution_routes`, `orchestrator_cycles`, `orchestrator_actions`, `orchestrator_control`, `orchestrator_control_history`.
- **Market/history:** `market_prices`, `price_observations`, `market_snapshots`, `yield_observations`, `rhea_pools`, `rhea_pool_observations`, `burrow_markets`, `burrow_market_observations`, `token_metadata`.
- **Portfolio/demo:** `portfolio_analyses`, `demo_ledger`.
- **Audit/integrity:** `audit_events`, `audit_checkpoints`.
- **Ops:** `collector_cycles`, `collector_control`.
- **Testnet:** `testnet_transactions`.

## 5. HTTP surface (`apps/api`)

- **Read-only analytics** (`/v1/analytics/*`): overview, portfolio, account, opportunities, prices, rhea/burrow markets, risk, routes, series, policy verdicts/attacks, audit, freshness, system, thesis, tokens, agent-activity, activity.
- **Operator** (bearer-auth): `/v1/control`, `/v1/runs`, `/v1/proposals`, `/v1/policy`, `/v1/audit(/verify)`, `/v1/market-data`, `/v1/testnet-transactions`, `/v1/portfolio`, `/v1/routes`.
- **Health:** `/health`, `/ready`.
- **Gateway** (`apps/api/src/gateway`): `best-execution`, `one-click`, `swap-plan`, `venues`, `probe`, `shadow-gateway`.

## 6. Configuration (zod-validated, `packages/config`)

Key switches: `DATA_SOURCE` (`chain|simulation`), `NEAR_NETWORK`, `EXECUTION_MODE` (`dry-run|live`), `AUTOPILOT_ENGINE` (`legacy|orchestrator`), `MARKET_DATA`, `YIELD_DATA`, `SIMULATION_PORTFOLIO`. RPC/keys: `NEAR_RPC_URL`, `MAINNET_READ_RPC_URL`, `*_RPC_API_KEY`, `PYTH_HERMES_URL`. External price refs: Binance/Coinbase/Kraken/DefiLlama URLs. Cross-field refusals enforce the safe combinations (e.g. `MARKET_DATA=mainnet-live` ⇒ simulation + dry-run + mainnet read RPC).

## 7. Deployment

- `deploy/public` Docker Compose bundle: `postgres`, `api-shadow`, `analytics-api`, `shadow-collector`, `analytics`, optional `caddy`.
- Live demo served through **Tailscale Funnel** (NAT, no inbound 80/443); Let's Encrypt cert via Funnel.
- Images built cross-platform (`linux/amd64`) on a dev Mac; `.dockerignore` + a post-build scan keep secrets out of images.
