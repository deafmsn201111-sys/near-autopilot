# near-autopilot

A policy-gated autopilot for NEAR DeFi positions. Agents watch a wallet and its
[Burrow](https://burrow.finance) lending position, propose actions (repay debt, add collateral,
rebalance through [Rhea](https://rhea.finance) pools), and a deterministic **policy engine** decides
whether each action may run. Nothing is signed unless policy approved that exact transaction.

> **Safe by default.** The system starts in `dry-run`: it reads the chain, plans transactions,
> evaluates policy and records everything, but never signs or broadcasts. Live execution requires
> you to supply a key-custody implementation (see [docs/security.md](docs/security.md)).

## What it does

| Agent             | Job                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `health-guardian` | When the Burrow health factor drops below a trigger, repays debt (or adds collateral) to reach a target. Never borrows. |
| `rebalancer`      | Optional. Keeps wallet holdings near target weights with one capped Rhea swap per cycle.                                |

Every proposal, policy decision and execution result is stored in Postgres and visible in the dashboard.

## Repository layout

```
apps/
  api/            Fastify HTTP API + pipeline orchestration (composition root)
  dashboard/      Next.js dashboard (talks to the API over HTTP only)
packages/
  core/             Shared types, ports (interfaces), Zod schemas, wire contracts, errors
  config/           Environment validation (Zod)
  financial-engine/ Pure bigint maths: CLMM valuation, fee APR, IL, net yield (realized/marked/estimated), rebalance cost, slippage, liquidation risk, stress tests, constrained allocation (docs/financial-engine.md)
  near-adapter/     NEAR JSON-RPC client; implements core read/broadcast ports
  rhea-adapter/     Rhea (Ref v1 AMM) swap quoter + swap transaction planner
  rhea-dcl-adapter/ Rhea/Ref v2 concentrated-liquidity (DCL): typed views, exact tick math, tx builders, ABI check (not used by the API yet)
  burrow-adapter/   Burrow markets/accounts/oracle readers, exact health-factor/LTV/stress maths, verified repay and collateral builders
  agents/           Health guardian and rebalancer (pure decision logic)
  orchestrator/     Multi-agent portfolio orchestrator: schema-validated proposals, pure decision engine, stale-data guard, idempotency, audit hash chain, escalation, emergency read-only mode (docs/orchestrator.md; AUTOPILOT_ENGINE=orchestrator, dry-run only)
  policy-engine/    Rules + the only code that can mint an ApprovedPlan
  tx-execution/     Planner registry, live executor, explicit dry-run executor
  db/               Drizzle schema, client, SQL migrations
config/             autopilot.example.json (mainnet ids), autopilot.testnet.example.json (testnet ids)
docs/               architecture.md, security.md, financial-engine.md, orchestrator.md, rhea-dcl-capability-matrix.md, burrow-capability-matrix.md
```

Dependency direction is enforced mechanically (ESLint + `scripts/check-boundaries.mjs`, both driven by
`boundaries.config.mjs`). See [docs/architecture.md](docs/architecture.md).

## Quick start

Requirements: Node 22+, pnpm 9.15+, Docker (for Postgres).

```bash
pnpm install                      # generates pnpm-lock.yaml on first run: commit it
pnpm format                       # one-time: normalise formatting with Prettier before the first CI run
cp .env.example .env              # testnet + dry-run by default; edit API_TOKEN, AUTOPILOT_ACCOUNT_ID, ...
cp config/autopilot.testnet.example.json config/autopilot.json   # then edit (see below)

docker compose up -d postgres
pnpm dev                          # API on :4000, dashboard on :3000 (migrations run on API start)
```

Or run everything in containers: `docker compose up --build`.

Trigger a cycle manually:

```bash
curl -X POST -H "Authorization: Bearer $API_TOKEN" http://localhost:4000/v1/runs
```

Set `CYCLE_INTERVAL_SECONDS` to run on a schedule (0 = off).

### Demo without a wallet: simulation mode

`DATA_SOURCE=simulation` runs the full production pipeline (adapters, Burrow verifier, planners, policy engine,
dry-run executor) against an in-process **mock** NEAR RPC serving a synthetic portfolio. Nothing is read from or sent
to any network, every row and API response is labelled `simulation`, and the dashboard shows a SIMULATION banner.

| `SIMULATION_PORTFOLIO` | Synthetic position (demo prices: NEAR $3, USDt $1)            | What happens                                                  |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| `demo-500`             | gross $500: 120 wNEAR collateral, 200 USDt debt, HF ~1.28     | guardian repays ~$40 USDt; policy approves; dry-run, not sent |
| `demo-5000`            | gross $5,000: 1150 wNEAR collateral, 2000 USDt debt, HF ~1.23 | needed repay ~$464 exceeds the $100 per-action cap; rejected  |

Use it with `config/autopilot.testnet.example.json` and `NEAR_NETWORK=testnet` (the demo tokens must be allowlisted).
`AUTOPILOT_ENGINE=orchestrator` runs the multi-agent orchestrator instead of the legacy guardian; both are covered by
`apps/api/test/simulation.test.ts`.

### Configuring the autopilot

`config/autopilot.json` (validated at startup, unknown keys rejected) holds:

- `policy` — signer account, contract/token/recipient allowlists, per-action and daily USD limits,
  approval threshold, slippage and oracle-deviation caps, cooldown. Every limit is enforced before signing.
- `guardian` — health factor trigger and target.
- `rebalancer` — target weights, drift threshold, max trade size (disabled by default).
- `rhea.pools` — the exact pools swaps may use. **Empty by default, which means no swap can be quoted.**
  You must review pools yourself and list them (`poolId`, `tokenA`, `tokenB`).

`policy.signerAccountId` must equal `AUTOPILOT_ACCOUNT_ID`.

### Environment

All environment variables are validated at startup by `packages/config` (errors name the variable and
reason, never the value). See `.env.example` for the full list. On testnet you must set
`RHEA_CONTRACT_ID`, `BURROW_CONTRACT_ID` and `BURROW_ORACLE_ID` explicitly; mainnet defaults are built in.

## Scripts

| Command                 | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `pnpm dev`              | API + dashboard in watch mode                              |
| `pnpm verify`           | format check, lint, typecheck, tests (what CI runs)        |
| `pnpm test`             | Vitest across all packages (via Turborepo)                 |
| `pnpm typecheck`        | `tsc` in strict mode across all packages                   |
| `pnpm lint`             | ESLint + dependency boundary check                         |
| `pnpm check:boundaries` | Standalone layer check                                     |
| `pnpm db:generate`      | Generate a new Drizzle migration after editing `schema.ts` |
| `pnpm db:migrate`       | Apply migrations manually                                  |

## HTTP API

All `/v1/*` routes require `Authorization: Bearer <API_TOKEN>`.

| Route               | Description                               |
| ------------------- | ----------------------------------------- |
| `GET /health`       | Liveness                                  |
| `GET /ready`        | Readiness (database reachable)            |
| `GET /v1/portfolio` | Live valuation, health factor, holdings   |
| `GET /v1/runs`      | Recent pipeline runs                      |
| `GET /v1/proposals` | Proposals with policy outcome and tx hash |
| `GET /v1/policy`    | Active limits (read-only)                 |
| `POST /v1/runs`     | Run one cycle now (409 if one is running) |

Response shapes live in `packages/core/src/api-contracts.ts` and are shared with the dashboard.

## Honest limitations

- **No signer is shipped, and mainnet never signs.** `EXECUTION_MODE=live` refuses to start until you implement
  `loadSigner()` (`apps/api/src/signer.ts`), and `loadApiEnv`/`wire()` reject live execution on mainnet outright
  (there is no override). Mainnet runs are dry-run. See [docs/security.md](docs/security.md).
- **Protocol payload shapes need live verification.** Rhea v1 (`get_return`, `ft_transfer_call` swap message)
  was written against documented interfaces. Burrow was checked against the contract and frontend source and is
  gated at runtime by on-chain verification (chain id, deployed-code exports, oracle identity, token listing), but
  Burrow testnet support has **never been exercised from this repository's build environment** (no RPC access).
  Responses are strictly Zod-validated so a mismatch fails closed. Evidence and gaps:
  [docs/burrow-capability-matrix.md](docs/burrow-capability-matrix.md), and run the checklist in
  [docs/security.md](docs/security.md#pre-mainnet-checklist) on testnet first.
- Testnet: Burrow, its oracle and both Rhea contracts were confirmed with read-only calls (docs/security.md), but the
  testnet oracle currently reports **no prices**, so chain-mode testnet runs cannot price a decision. Use simulation
  to demonstrate behaviour.
- The orchestrator engine is dry-run only (in-memory audit/idempotency stores) and has no market-data source, so its
  LP Optimizer and Capital Allocator report `insufficient_data` outside tests.
- Rhea quoting is single-hop through operator-listed pools only.
- Proposals that exceed the approval threshold are recorded as `requires_approval` and held; there is no
  approval UI yet.
- `requires_approval` and `approved` rows are never auto-resumed. An `approved` row that never resolves
  (crash mid-send) must be reconciled by hand using its transaction hash/plan hash.
