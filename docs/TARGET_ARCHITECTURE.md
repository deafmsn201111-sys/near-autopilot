# TARGET_ARCHITECTURE

_Phase 0 deliverable. Target = the 13-layer system from the master brief (§4), mapped onto what already exists so we **extend, not rewrite**. Guiding philosophy: **INTELLIGENCE FIRST · AUTONOMY SECOND · SECURITY ALWAYS** — the AI does the complex work, the user keeps control._

## 1. The 13 target layers, mapped to today's code

| # | Target layer (brief) | Today | Strategy |
| --- | --- | --- | --- |
| 1 | **Data Intelligence** | `near/burrow/rhea` adapters, `market-data`, `collector`, history tables | **Extend**: unify behind a `DataProvider` abstraction with explicit provenance tiers + freshness status |
| 2 | **Market Intelligence** | `MarketIntelligenceAgent`, `market-data/*`, `*_observations` | **Extend**: formalize trend/volatility/regime over stored history |
| 3 | **Portfolio Intelligence** | `analytics/portfolio-view.ts`, `account-view.ts`, `financial-engine/valuation` | **Extend**: snapshots, change explanations, no double-counting (already handled per `WHERE` groups) |
| 4 | **Yield Intelligence** | `yield/service.ts`, `yield/rhea.ts`, DefiLlama | **Extend**: net-APY + reward composition + sustainability |
| 5 | **Opportunity Discovery** | `analytics/opportunities.ts` | **Extend**: formal, documented, configurable `Opportunity Score`; Recommended/Watchlist/Rejected |
| 6 | **Risk Intelligence** | `financial-engine/risk.ts`, `burrow-adapter/risk.ts`, orchestrator `risk-state.ts` | **Consolidate + extend**: single risk core; protocol/token/strategy/portfolio profiles; independent rejection |
| 7 | **AI Multi-Agent Orchestrator** | `packages/orchestrator` (4 agents, decision-engine, escalation) | **Promote + specialize**: raise to primary; add Portfolio/Yield/Strategy/Execution agents; optional `LlmClient` |
| 8 | **Strategy & Decision Engine** | orchestrator `decision-engine.ts`, `proposals.ts` | **Extend**: candidate strategies, net-yield/cost/impact, typed decision records with expiry |
| 9 | **Autonomous Execution Engine** | `tx-execution` (dry-run), wallet-confirm branch | **Build (gated)**: protocol execution adapters that only run through the Guard |
| 10 | **Guard Smart Contract** | ⬜ none | **Net-new (NEAR/Rust)**: on-chain allowlists, limits, Emergency Stop, replay protection |
| 11 | **Learning & Optimization** | `thesis/`, shadow mode, DCL backtest | **Extend**: backtesting, performance attribution, model/strategy versioning |
| 12 | **Analytics & Monitoring** | `evidence/`, `/v1/analytics/*`, audit checkpoints | **Extend**: agent/data-freshness/exec metrics, operational dashboards |
| 13 | **UX / Dashboard** | `apps/analytics` (Next.js 15) | **Rework flows**: Dashboard, Portfolio, Opportunities, Strategies, Autopilot, Activity, Risk Center, Research, Settings |

**Key insight:** 9 of 13 layers already have a real home. Only the **Guard contract (10)** is fully net-new; **Autonomous Execution (9)** is gated on it; everything else is extension/specialization/consolidation.

## 2. Target module boundaries

```
                         ┌───────────────── UX / Dashboard (Next.js) ─────────────────┐
                         │ Dashboard · Portfolio · Opportunities · Strategies ·       │
                         │ Autopilot · Activity · Risk Center · Research · Settings   │
                         └───────────────▲────────────────────────▲───────────────────┘
                                         │ /v1/* API contracts     │
            ┌────────────────────────────┴─────────────────────────┴───────────────────┐
            │                     AI Multi-Agent Orchestrator (7)                        │
            │  Market · Portfolio · Yield · Risk(independent) · Strategy · Execution     │
            │                    → Strategy & Decision Engine (8)                        │
            └───▲──────────▲──────────▲──────────▲──────────────────────▲────────────────┘
                │          │          │          │                      │
      Data Intelligence  Market    Portfolio   Yield/Opportunity   Risk Intelligence (6)
            (1)           Intel(2)  Intel(3)    Intel (4,5)          (independent rejection)
                │
                ▼
     adapters: near · burrow · rhea · market-data · collector · history (Postgres)
                                         │ approved, typed decision
                                         ▼
                      Autonomous Execution Engine (9)  ──must pass──▶  Guard Contract (10, on-chain)
                                         │                                   │ limits, allowlists,
                                         ▼                                   │ emergency stop, replay
                           user wallet signs / delegated key                 ▼
                                                                        NEAR mainnet
```

## 3. Permission & custody model (non-negotiable, brief §12/§21)

- User's primary assets stay in the user's wallet. The agent never gets FullAccess.
- Two supported execution modes, chosen per protocol after inspecting its real authorization model:
  - **A. Delegated execution** via a restricted FunctionCall access key, *scoped by the Guard*, where the protocol supports it.
  - **B. Guard-controlled working Vault** for protocols that require contract custody.
- Current interim (safe) mode, already built on a branch: **owner signs every transaction in their own wallet** (no key delegation at all). This remains the default until the Guard is deployed and independently reviewed.
- Execution authorization is a **separate security decision** from any model explanation. No agent output authorizes a send.

## 4. Autonomy ladder (honest states)

| Mode | What it does | Status |
| --- | --- | --- |
| **Observe** | Analyze, recommend, never act | available (this is the system today) |
| **Approve** | Prepare typed tx, user approves + signs in wallet | branch `feat/mainnet-wallet-confirm` (to be merged, gated) |
| **Autonomous (within limits)** | Agent submits within Guard-enforced caps | **blocked until Guard contract exists + external review** — shown as locked, never faked |

## 5. Data contracts & provenance (brief §5/§16)

Every financial value carries a provenance tier: `on_chain_verified` · `external_market` · `protocol_reported` · `calculated_estimate` · `ai_prediction`. The UI must visibly distinguish them. Missing data returns an explicit `unavailable|degraded` status — never a fabricated fill.

## 6. Non-goals / explicit constraints

- No LLM is wired today; if genuine model reasoning is added, it is an **additional** `LlmClient` agent with the deterministic heuristics kept as the safe fallback — not a replacement of the safe pipeline.
- No fabricated "AI confidence" numbers.
- No autonomous mainnet execution by default; no Guard deploy to mainnet without independent security review.
