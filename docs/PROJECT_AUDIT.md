# PROJECT_AUDIT

_Phase 0 deliverable. Verified against the repository on 2026-11-08 (branch `fix/audit`, HEAD `5128031`). Every claim below was checked by reading code, running `pnpm verify`, or probing the live demo — not from memory._

## 1. How this audit was produced

- `pnpm verify` run to completion: **15/15 tasks green** (format, lint, boundaries, typecheck, test, build).
- API test suite observed: **261 passed / 38 skipped** (skipped = live/gated integration tests that need `*_LIVE=1` + network).
- Live demo probed over HTTPS (`https://near-autopilot-demo.tailafdf42.ts.net`): real NEAR mainnet prices render (stablecoins ≈ $0.9999).
- Source read for the live wiring, the orchestrator composition, the signer, the DB schema, the config schema and the HTTP routes.

## 2. Stack (verified, not assumed)

| Area           | What is actually there                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Language       | TypeScript, strict. Node `.nvmrc`-pinned (v22), pnpm 9 workspace monorepo (Turborepo).                                                 |
| Backend        | `apps/api` — Node HTTP server (`server.ts`), ~19.6k LOC. Collector, analytics API, gateway, services.                                  |
| Frontend       | `apps/analytics` — **Next.js 15 App Router**, server components, ~4.9k LOC. (`apps/dashboard` is a smaller/older surface, ~0.7k LOC.)  |
| Database       | PostgreSQL 16 + **Drizzle ORM**. 24 tables, 17 migrations (`0000`–`0016`).                                                             |
| Blockchain     | NEAR. Read path via JSON-RPC **view calls** (`near-adapter`). No signer shipped (see §5).                                              |
| DeFi protocols | **Burrow** (lending, `burrow-adapter`), **Rhea** (DEX/AMM + DCL concentrated liquidity, `rhea-adapter`, `rhea-dcl-adapter`).           |
| Prices         | Burrow on-chain oracle + **Pyth** (Hermes); external CEX refs (Binance, Coinbase, Kraken) and DefiLlama for yields.                    |
| AI             | **Heuristic agents only — no LLM is called** (see §4). An `LlmAgent` class + `LlmClient` port exist but are unimplemented and unwired. |
| Auth           | Bearer `API_TOKEN` on operator endpoints (constant-time compare). No user accounts/sessions yet.                                       |
| Wallet         | Browser-side HOT Connector (`@hot-labs/near-connect`) sign-in; no access key is added. Signing lives only on a local branch (see §5).  |
| Deploy         | Docker Compose bundle (`deploy/public`); live demo exposed via **Tailscale Funnel** behind NAT.                                        |
| CI             | GitHub Actions `ci.yml`: `verify` job (format/lint/typecheck/test/build) + `db` job against real Postgres 16.                          |

## 3. Implementation status inventory

Legend: ✅ working & wired · 🟡 implemented but dormant/behind a flag · 🟥 stub/placeholder · ⬜ missing.

| Capability                                                                        | Status | Evidence                                                                                                                                      |
| --------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| NEAR view-call snapshots (balances, Burrow positions)                             | ✅     | `near-adapter`, `burrow-adapter`; live demo renders real data                                                                                 |
| Rhea swap quotes / pools                                                          | ✅     | `rhea-adapter`, `/v1/analytics/rhea/pools`                                                                                                    |
| Price intelligence (oracle + Pyth + CEX refs)                                     | ✅     | `market-data/sources.ts`, `/v1/analytics/prices` live                                                                                         |
| Yield observations (DefiLlama + Rhea)                                             | ✅     | `yield/service.ts`, `yield_observations` table                                                                                                |
| Policy engine (allowlists, limits, 12 rules)                                      | ✅     | `policy-engine`; adversarial tests `demo-attack.ts`                                                                                           |
| Dry-run executor (plan + policy-check, never sends)                               | ✅     | `tx-execution`; `loadSigner()` returns `null`                                                                                                 |
| Audit trail (write-through Postgres + checkpoints)                                | ✅     | `evidence/`, `audit_checkpoints`, `/v1/audit/verify`                                                                                          |
| Simulation / demo portfolios ($500 / $5,000)                                      | ✅     | `simulation/`, `demo_ledger`; banner-labelled                                                                                                 |
| Legacy cycle engine (HealthGuardian + Rebalancer)                                 | ✅     | default `AUTOPILOT_ENGINE=legacy`                                                                                                             |
| **Multi-agent orchestrator** (4 agents, decision engine, escalation, idempotency) | 🟡     | `packages/orchestrator` (4.3k LOC) wired behind `AUTOPILOT_ENGINE=orchestrator`, **off by default**                                           |
| Analytics dashboard (Portfolio, Opportunities, Activity, Research)                | ✅     | `apps/analytics`; live                                                                                                                        |
| Opportunity scoring / comparison                                                  | 🟡     | `analytics/opportunities.ts` (net-cost comparison); no formal documented `Opportunity Score` yet                                              |
| Risk intelligence (HF, stress, risk profiles)                                     | 🟡     | `financial-engine/risk.ts`, `burrow-adapter/risk.ts`, orchestrator `risk-state.ts` — present but duplicated and not surfaced as a Risk Center |
| LLM-backed agent                                                                  | 🟥     | `LlmAgent` class present, **no `LlmClient` impl, not wired**                                                                                  |
| Mainnet wallet-confirm hand-off (owner signs)                                     | 🟡     | **local branch `feat/mainnet-wallet-confirm` only**, never pushed                                                                             |
| **Guard smart contract (on-chain limits / Emergency Stop)**                       | ⬜     | **no contract exists** — no `contracts/`, no `Cargo.toml`                                                                                     |
| Autonomous execution engine (real sends within limits)                            | ⬜     | blocked by design: no signer, no Guard                                                                                                        |
| Learning / backtesting engine                                                     | 🟡     | partial: `thesis/`, DCL backtest, shadow mode; no model-eval/optimization loop                                                                |
| User accounts / per-user policy / sessions                                        | ⬜     | single-operator model today                                                                                                                   |

## 4. The "AI" reality (critical, honest finding)

The system's intelligence today is **deterministic heuristics**, not machine learning or LLM reasoning:

- Wired agents: `MarketIntelligenceAgent`, `LpOptimizerAgent`, `LiquidationGuardianAgent`, `CapitalAllocatorAgent` — all rule-based.
- `LlmAgent` exists but takes an `LlmClient` that has **no implementation anywhere**, and it is **not** in the wired agent list.
- Therefore no model "confidence" exists to display. Any UI that shows an AI confidence score today would be fabricated.

Implication for the transformation: §10 of the brief ("Multi-Agent AI") is partly real (orchestration scaffold) and partly new work (if genuine LLM reasoning is wanted, `LlmClient` must be implemented against the Claude API, with the heuristic agents kept as the safe default/fallback).

## 5. Security posture (verified)

- `loadSigner()` returns `null` by design → `EXECUTION_MODE=live` **refuses to start**; the system is permanently `dry-run` on `main`/`fix/audit`.
- Mainnet live execution is additionally gated by a chain-id check and config refusals.
- The only signing path is the **owner-signs-in-their-own-wallet** hand-off, and it exists **only on the un-pushed local branch** `feat/mainnet-wallet-confirm`.
- Public demo hardening: operator controls refused on the server, visitor actions rate-limited and dry-run, `PUBLIC_DEMO=1` fixed in compose.
- No seed phrases, no private keys, no FullAccess anywhere. This matches brief §21.

## 6. Headline gaps vs. the target (brief §4)

1. **Guard smart contract (§12)** — does not exist. This is the single largest piece of net-new engineering and the precondition for any autonomous execution.
2. **Genuine multi-agent intelligence (§10)** — scaffold exists; specialization into Market/Portfolio/Yield/Risk/Strategy/Execution agents and (optionally) LLM reasoning is partial.
3. **Risk Center + Autopilot + Settings UI (§15)** — not built; dashboard is portfolio/opportunity-centric.
4. **Formal data contracts & provenance tiers (§5, §16)** — provenance exists in places; a system-wide `on-chain / external / protocol-reported / estimated / predicted` tag is not uniform.
5. **UX usability** — explicitly flagged by the product owner as the current blocker; needs a flow-level pass, not cosmetics.

## 7. What must not be broken (regression guardrails)

- The dry-run / `loadSigner()=null` safety invariant.
- The policy engine + audit write-through.
- Real integrations — never replace live adapters with mock data (brief §20).
- `pnpm verify` must stay green; every change ships with tests.
