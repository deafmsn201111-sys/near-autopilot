# near-autopilot

A policy-gated autopilot for NEAR DeFi positions. Agents watch a wallet and its
[Burrow](https://burrow.finance) lending position, propose actions (repay debt, add collateral,
rebalance through [Rhea](https://rhea.finance) pools), and a deterministic **policy engine** decides
whether each action may run. Nothing is signed unless policy approved that exact transaction.

> **Safe by default.** The system starts in `dry-run`: it reads the chain, plans transactions,
> evaluates policy and records everything, but never signs or broadcasts. Live execution requires
> you to supply a key-custody implementation (see [docs/security.md](docs/security.md)).
>
> **Status:** a working local demo (simulation + dry-run) and read-only testnet integration. **Mainnet execution is
> not a finished or verified feature**, and no seed phrase, private key or wallet is needed to run anything below.

## What it does

Two interchangeable decision engines feed the same pipeline
(snapshot → agents → planner → **policy engine** → executor → Postgres → dashboard), selected by `AUTOPILOT_ENGINE`:

**`legacy`** (default)

| Agent             | Job                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `health-guardian` | When the Burrow health factor drops below a trigger, repays debt (or adds collateral) to reach a target. Never borrows. |
| `rebalancer`      | Optional. Keeps wallet holdings near target weights with one capped Rhea swap per cycle.                                |

**`orchestrator`** (dry-run only; [docs/orchestrator.md](docs/orchestrator.md))

| Agent                  | Job                                                                                  | In the current API wiring                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `liquidation-guardian` | Ranked de-risk candidates (repay, add collateral) from the position and stress tests | Active                                                                                                                 |
| `market-intelligence`  | Volatility, oracle-divergence, depeg and liquidity signals that tighten decisions    | Testnet profile: mainnet reference prices (source divergence, 24h range); else `insufficient_data`                     |
| `lp-optimizer`         | Rhea DCL range re-centring, advisory only, with payback estimate                     | `insufficient_data`: no LP positions are read; testnet profile reports the pools observed and why rejected             |
| `capital-allocator`    | Target-weight allocation swaps using yield estimates                                 | Testnet profile: valid Burrow supply APRs ([docs/yield-data.md](docs/yield-data.md)); missing ones named with a reason |

Agent output is strictly schema-validated, then a pure decision engine ranks candidates; each one still has to pass
the same policy engine and executor as the legacy path. Every proposal, policy decision and execution result is stored
in Postgres and visible in the dashboard.

## Repository layout

```
apps/
  api/            Fastify HTTP API + pipeline orchestration (composition root); also the MAINNET read-only
                  shadow collector (src/collector) and the read-only analytics API (src/analytics)
  dashboard/      Next.js dashboard for the autopilot APIs (talks to the API over HTTP only)
  analytics/      Next.js analytics dashboard for the collector's data (read-only, talks to the analytics API only)
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
  policy-engine/    12 checks -> ALLOW / WARN / BLOCK verdict with policy version and snapshot id (stored in policy_verdicts, docs/policy-verdicts.md); the only code that can mint an ApprovedPlan
  tx-execution/     Planner registry, live executor, explicit dry-run executor
  db/               Drizzle schema, client, SQL migrations
config/             autopilot.example.json (mainnet ids), autopilot.testnet.example.json (testnet ids),
                    autopilot.shadow.example.json (mainnet read-only shadow profile)
docs/               architecture.md, security.md, financial-engine.md, orchestrator.md, market-data.md, yield-data.md,
                    mainnet-shadow.md, testnet-transactions.md, rhea-dcl-capability-matrix.md, burrow-capability-matrix.md,
                    policy-verdicts.md, shadow-gateway.md, audit-evidence.md
```

In dry-run, every approved plan goes through the **Shadow Gateway** (`apps/api/src/gateway/`). The gateway re-checks
the stored ALLOW verdict and the approval, then quotes Rhea pool #4512 and a NEAR Intents 1Click **dry** quote. It
records the best execution in `execution_routes` (`GET /v1/routes`). It has no signer. See
[docs/shadow-gateway.md](docs/shadow-gateway.md).

Every audit event is appended to a **hash chain in Postgres**, which continues across restarts. Every policy verdict
stores its inputs and config. `pnpm audit:verify` re-checks the chains and `pnpm audit:replay` re-evaluates the
verdicts. See [docs/audit-evidence.md](docs/audit-evidence.md).

`pnpm demo:attack` runs labelled attack fixtures (prompt injection, foreign recipient, extra Withdraw, stale price,
thin pool, forged approval, full-access key) through the real defences. Every attack is stopped and the log is
written to `docs/evidence/demo-attack.log.jsonl`. The live executor refuses full-access keys. See
[docs/security.md](docs/security.md).

Dependency direction is enforced mechanically (ESLint + `scripts/check-boundaries.mjs`, both driven by
`boundaries.config.mjs`). See [docs/architecture.md](docs/architecture.md).

## Quick start

Requirements: Node 22 (`.nvmrc`), pnpm 9.15 (`packageManager`), Docker with Compose v2 (for Postgres, or the whole
stack). No NEAR wallet, key or API key is needed.

```bash
pnpm install --frozen-lockfile
cp .env.example .env              # testnet + dry-run by default; set API_TOKEN, POSTGRES_PASSWORD, DATABASE_URL, AUTOPILOT_ACCOUNT_ID
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

### Local Docker demo (simulation, orchestrator, dry-run)

Everything in containers, bound to `127.0.0.1` only. `.env` and `config/autopilot.json` are git-ignored; generate
fresh secrets rather than reusing the example values.

```bash
cp .env.example .env    # then set: API_TOKEN / POSTGRES_PASSWORD (openssl rand -hex 32), DATABASE_URL to match,
                        # DATA_SOURCE=simulation, AUTOPILOT_ENGINE=orchestrator, EXECUTION_MODE=dry-run,
                        # AUTOPILOT_ACCOUNT_ID=<any valid *.testnet id>; DASHBOARD_PORT etc. if a port is taken
cp config/autopilot.testnet.example.json config/autopilot.json   # set policy.signerAccountId = AUTOPILOT_ACCOUNT_ID
docker compose up -d --build        # postgres -> api (runs migrations) -> dashboard; all three have health checks
docker compose ps                   # wait for (healthy)
docker compose logs -f api          # structured JSON logs
docker compose stop                 # stop, keep data   |   docker compose start   # resume
```

Two images serve every API and dashboard container: `near-autopilot-api:local` (built by `api`) and
`near-autopilot-dashboard:local` (built by `dashboard`). The testnet / shadow / analytics services reuse them, so a
rebuild runs each Dockerfile once instead of once per service: `docker compose build api dashboard`, then
`docker compose --profile shadow --profile testnet up -d` to restart whatever runs the old image.

The `pgdata` volume survives `stop`, `down` and reboots (`restart: unless-stopped` brings the stack back when Docker
Desktop starts). `docker compose down -v` deletes the database: don't, unless you mean it. Switch portfolio with
`SIMULATION_PORTFOLIO=demo-5000` in `.env` and `docker compose up -d api`.

In this mode the three market-dependent agents (market intelligence, LP optimizer, capital allocator) report
`no_action / insufficient_data` every cycle because no market-data source is integrated; only the liquidation
guardian acts. Each run's `snapshot.agents` records what every agent returned.

### Testnet, read-only

With `DATA_SOURCE=chain`, `NEAR_NETWORK=testnet` and `EXECUTION_MODE=dry-run`, the API reads the configured account
through `NEAR_RPC_URL` with view calls only. At start-up it checks that the RPC really serves testnet; Burrow
plans are only built after the verifier has confirmed the contract's code, its oracle and the token listing.
`AUTOPILOT_ACCOUNT_ID` must be an existing testnet account; it is only read, never signed for.

A ready-made profile runs it next to the simulation stack (same Postgres; each API lists only its own rows):

```bash
cp config/autopilot.testnet.example.json config/autopilot.testnet.local.json   # set policy.signerAccountId
# .env: TESTNET_ACCOUNT_ID=<your-account>.testnet   (optional: TESTNET_RPC_URL, TESTNET_ENGINE)
docker compose --profile testnet up -d --build
# simulation: dashboard http://127.0.0.1:3004, API :4000   |   testnet: dashboard http://127.0.0.1:3002, API :4001
docker compose --profile testnet stop    # keeps data
```

Network, data source and dry-run are fixed for this profile in `docker-compose.yml`. Prices come from **mainnet
market data** (Pyth with `PYTH_API_KEY`, DefiLlama as fallback), applied to the testnet tokens as labelled
`REFERENCE_PRICE — NOT A REAL TESTNET TOKEN PRICE`; the dashboard shows
`TESTNET EXECUTION · MAINNET MARKET DATA · NO MAINNET TRANSACTIONS`, a Market data page (source, asset id, price,
timestamp, age, validity, reason per observation), and for each check the reasons it did or did not act. Mapping,
validation and fallback rules: [docs/market-data.md](docs/market-data.md). Set `TESTNET_MARKET_DATA=none` to price
from the testnet Burrow oracle instead (which currently prices nothing). Testnet yield data (Burrow rates, Rhea v1 and
DCL pools, read-only at one block, validated): [docs/yield-data.md](docs/yield-data.md), page Yield data,
`TESTNET_YIELD_DATA=none` to turn it off. A read-only MAINNET shadow analysis of a simulated portfolio (profile
`shadow`, no transactions): [docs/mainnet-shadow.md](docs/mainnet-shadow.md). Read-only integration suites:

```bash
pnpm --filter @near-autopilot/burrow-adapter test:live     # BURROW_LIVE=1
pnpm --filter @near-autopilot/rhea-dcl-adapter test:live   # RHEA_DCL_LIVE=1
```

### Mainnet read-only analytics: shadow collector and analytics dashboard

Profile `shadow` also runs an autonomous **collector** that reads MAINNET with view calls only (no signer exists, no
transaction is built or sent, no LLM is called) and stores everything in Postgres:

- every Rhea v1 and DCL pool (full registry rescan every `COLLECTOR_REGISTRY_EVERY` cycles, and after downtime longer
  than that), classified as `DISCOVERED / LIQUID / LOW_LIQUIDITY / UNSUPPORTED / DATA_INVALID / ANALYTICS_ELIGIBLE /
LP_SIMULATION_ELIGIBLE` with reason codes. Discovery never allowlists a pool;
- all Burrow markets (supply / borrow APR, utilisation, limits, reward programmes);
- prices per source (Pyth, DefiLlama), with freshness, confidence and divergence checks;
- fee windows 1H / 24H / 7D / 30D from cumulative pool volumes, an LP entry simulation (fees, impermanent loss,
  entry/exit cost, gas) and a strategy comparison for the simulated demo portfolios, all from one snapshot per cycle.

```bash
docker compose --profile shadow up -d --build
# analytics dashboard http://127.0.0.1:3001 (analytics API :4003)   |   shadow autopilot dashboard :3003, API :4002
docker compose --profile shadow logs -f shadow-collector   # one JSON line per cycle: status, records, duration
```

The cycle interval is `SHADOW_CYCLE_INTERVAL_SECONDS` (default 900 s, counted from the end of a cycle). Opening the
dashboard never triggers a read from the chain: it only shows what the collector stored. Without `PYTH_API_KEY` the
collector uses DefiLlama only and marks every cycle `partial`. Details: [docs/mainnet-shadow.md](docs/mainnet-shadow.md).

| Port (127.0.0.1) | Service                                     | Profile   |
| ---------------- | ------------------------------------------- | --------- |
| 3001             | analytics dashboard (collector data)        | `shadow`  |
| 3002             | testnet autopilot dashboard                 | `testnet` |
| 3003             | shadow autopilot dashboard                  | `shadow`  |
| 3004             | simulation autopilot dashboard              | default   |
| 4000 – 4003      | API: simulation, testnet, shadow, analytics | as above  |
| 5432             | Postgres (volume `pgdata`)                  | default   |

### Testnet transactions (manual, confirmed, capped)

`pnpm --filter @near-autopilot/api testnet-tx ...` prepares a read-only preview of one allowlisted operation
(`wrap.testnet` `storage_deposit` / `near_deposit`), and signs and sends it only when you repeat its exact preview
hash, with a key file you keep outside the repository. Limits: 0.1 NEAR per operation, 1 NEAR in total, 0.5 NEAR
always kept, balance never below 14 NEAR. See [docs/testnet-transactions.md](docs/testnet-transactions.md). The autopilot itself still never signs.

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

| Command                                     | Purpose                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                  | API + dashboard in watch mode                                                                                    |
| `pnpm verify`                               | format check, lint, typecheck, tests (what CI runs)                                                              |
| `pnpm test`                                 | Vitest across all packages (via Turborepo)                                                                       |
| `pnpm typecheck`                            | `tsc` in strict mode across all packages                                                                         |
| `pnpm lint`                                 | ESLint + dependency boundary check                                                                               |
| `pnpm check:boundaries`                     | Standalone layer check                                                                                           |
| `pnpm db:generate`                          | Generate a new Drizzle migration after editing `schema.ts`                                                       |
| `pnpm db:migrate`                           | Apply migrations manually                                                                                        |
| `pnpm --filter @near-autopilot/api test:db` | Migrations + repository on real Postgres (`DATABASE_TEST_URL`, CREATEDB rights; uses its own throwaway database) |

## Security rules

- Never put a seed phrase, private key or wallet file in this repository; none is needed for the demo or the
  read-only testnet mode. `.env`, `config/autopilot.json`, key and credential files are git-ignored.
- `EXECUTION_MODE=live` is refused on mainnet, with the orchestrator engine, and with simulation; it also refuses to
  start without a signer, and the autopilot ships none. The separate `testnet-tx` tool signs only on testnet, only
  allowlisted operations, only after you confirm the exact preview.
- Generate `API_TOKEN` and `POSTGRES_PASSWORD` locally (`openssl rand -hex 32`); never reuse example values.
- All published ports bind to `127.0.0.1`. Details and threat model: [docs/security.md](docs/security.md).

## HTTP API

All `/v1/*` routes require `Authorization: Bearer <API_TOKEN>`.

| Route                          | Description                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `GET /health`                  | Liveness                                                         |
| `GET /ready`                   | Readiness (database reachable)                                   |
| `GET /v1/portfolio`            | Live valuation, health factor, holdings                          |
| `GET /v1/runs`                 | Recent pipeline runs                                             |
| `GET /v1/proposals`            | Proposals with policy outcome and tx hash                        |
| `GET /v1/policy`               | Active limits (read-only)                                        |
| `GET /v1/market-data`          | Mainnet reference prices, per source and asset (testnet profile) |
| `GET /v1/yield`                | Testnet yield estimates per source, with validation and reasons  |
| `GET /v1/testnet-transactions` | Manually confirmed testnet transaction ledger (read-only)        |
| `POST /v1/runs`                | Run one cycle now (409 if one is running)                        |

Response shapes live in `packages/core/src/api-contracts.ts` and are shared with the dashboard.

## Honest limitations

- **The autopilot ships no signer, and mainnet never signs.** (The `testnet-tx` tool's key-file signer is testnet-only
  and outside the autopilot pipeline.) `EXECUTION_MODE=live` refuses to start until you implement
  `loadSigner()` (`apps/api/src/signer.ts`), and `loadApiEnv`/`wire()` reject live execution on mainnet outright
  (there is no override). Mainnet runs are dry-run. See [docs/security.md](docs/security.md).
- **Simulation is not on-chain.** `DATA_SOURCE=simulation` uses synthetic balances and fixed demo prices served by
  an in-process mock RPC; nothing it shows was read from NEAR, and nothing is ever sent.
- **`dry-run` sends nothing.** A `dry_run` proposal is a plan that passed policy, not a transaction; it has no tx hash.
- **No transaction has ever been submitted from this repository**, on any network. Transaction payloads (Rhea v1
  `ft_transfer_call` swap message, Burrow repay/collateral messages) follow the contracts' source and are gated at
  runtime by on-chain verification (chain id, deployed-code exports, oracle identity, token listing), but their
  on-chain _effect_ is unverified. Responses are strictly Zod-validated so a mismatch fails closed. Evidence and gaps:
  [docs/burrow-capability-matrix.md](docs/burrow-capability-matrix.md),
  [docs/security.md](docs/security.md#pre-mainnet-checklist).
- Testnet: Burrow, its oracle and both Rhea contracts were confirmed with read-only calls (docs/security.md), but the
  testnet oracle reported **no fresh price for any asset** when checked (2026-11-04). The testnet profile therefore
  prices with mainnet REFERENCE prices, which say nothing about the test tokens' own value or liquidity.
- Pyth Hermes requires an API key since August 2026; without `PYTH_API_KEY` only DefiLlama is used and every price is
  `single_source`.
- The orchestrator engine is dry-run only: its idempotency and control stores are in memory. Its audit entries are
  written through to Postgres `audit_events` (fails closed), so they survive restarts. Yields come only from testnet
  Burrow supply rates (testnet profile); Rhea v1 fee APRs need two observations ≥ 1 h apart and an allowlisted pool,
  DCL APRs are not computed, and there is no LP position reader, so the LP Optimizer returns `insufficient_data`.
- The public testnet RPC is slow (~3 s per call) and rate-limits (HTTP 429). The RPC client retries reads only, with
  backoff, jitter, Retry-After and bounded concurrency, and never retries a send; a dedicated endpoint is still
  advisable.
- `pnpm db:generate` cannot diff against the current schema: `packages/db/drizzle/meta` has no snapshot files
  (migration `0001` is hand-written). Write further migrations by hand, or regenerate the snapshots first.
- Rhea quoting is single-hop through operator-listed pools only.
- Proposals that exceed the approval threshold are recorded as `requires_approval` and held; there is no
  approval UI yet.
- `requires_approval` and `approved` rows are never auto-resumed. An `approved` row that never resolves
  (crash mid-send) must be reconciled by hand using its transaction hash/plan hash.
