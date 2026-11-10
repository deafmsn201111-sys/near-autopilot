# near-autopilot

A policy-gated autopilot for NEAR DeFi positions. Agents watch a wallet and its
[Burrow](https://burrow.finance) lending position, propose actions (repay debt, add collateral,
rebalance through [Rhea](https://rhea.finance) pools), and a deterministic **policy engine** decides
whether each action may run. Nothing is signed unless policy approved that exact transaction.

> **Safe by default.** The system starts in `dry-run`: it reads the chain, plans transactions,
> evaluates policy and records everything, but never signs or broadcasts. Live execution requires
> you to supply a key-custody implementation (see [docs/security.md](docs/security.md)).
>
> **Status:** a working local demo (simulation + dry-run) and read-only mainnet integration. **Mainnet execution is
> not a finished or verified feature**, and no seed phrase, private key or wallet is needed to run anything below.

**Plan and roadmap:** [docs/HACKATHON_PLAN.md](docs/HACKATHON_PLAN.md).

## NEAR HACKATHON 2026

Tracks: **security** (primary), **defi**, **thesis**. When and how it was built, the libraries used, and how to tell
the hackathon work apart: [HACKATHON_BUILD.md](HACKATHON_BUILD.md).

- **Whole project:** [`hackathon-submission`](https://github.com/deafmsn201111-sys/near-autopilot/tree/hackathon-submission).
  All of it was written in the hackathon window; there is no pre-hackathon code.
- **Changes since the git import:** [`hackathon-start...hackathon-submission`](https://github.com/deafmsn201111-sys/near-autopilot/compare/hackathon-start...hackathon-submission).
- **About the first commit** (`232bfb7`, "Baseline: project state as found before audit fixes"): this is not
  pre-hackathon code. The project was started on 2026-11-02 in a local browser session of Claude, with no repository
  connected, and imported into git on 2026-11-04. The next commits audit and fix it. Git cannot prove the dates
  before 2026-11-04; they rest on the author's statement.

NEAR Autopilot is a DeFi manager for NEAR on its way to full autonomy. It guards lending positions against
liquidation, refuses actions that lose money after costs, and analyses liquidity pools. Three levels are kept apart
everywhere in this repository:

| Level             | What                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Works now**     | Automatic decisions, a 12-check policy engine, a tamper-evident audit trail. Execution is **dry-run only**: plans are built, checked and simulated, never signed or sent. |
| **Analysis only** | Liquidity pools (Rhea v1 and DCL concentrated liquidity) are costed and backtested. The agent never opens a position.                                                     |
| **Roadmap**       | See [docs/HACKATHON_PLAN.md](docs/HACKATHON_PLAN.md).                                                                                                                     |

Mainnet is read-only: signing on mainnet is locked in code, and NEAR Intents 1Click is used for dry quotes only.

**Live demo (public, read-only):** https://near-autopilot-demo.tailafdf42.ts.net. It runs in public demo mode: live
mainnet data, the two simulated demo portfolios, "Let the agent do it" as a dry run; operator controls are off
([deploy/public](deploy/public/README.md)).

Every "try it" step below starts from the [Quick start](#quick-start): `./scripts/quickstart.sh`, then the dashboard on
`http://127.0.0.1:3001`. On a fresh clone it took 6 min 13 s (2026-11-08).

### Security track: give an AI money without giving it the keys

**What works**

- Every action an agent proposes passes a deterministic policy engine with 12 checks. The answer is ALLOW, WARN or
  BLOCK. The checks include:
  - allowlists of contracts, tokens and recipients;
  - a strict parse of the Burrow message, so a hidden `Withdraw` is caught;
  - price freshness and oracle deviation;
  - per-action and daily USD limits;
  - a gas budget.
- Only the policy engine can mint an approved plan, and the approval is checked again at execution. An operator
  approval is single-use and expires.
- Every decision is appended to a hash chain in PostgreSQL, with ed25519-signed checkpoints.

**Why the agent does not sign, not even with a function-call key**

NEAR's way to give an agent limited keys is a function-call access key scoped to one contract. Such a key **cannot
attach a deposit**, not even 1 yoctoNEAR. But every action this agent takes is a NEP-141 `ft_transfer_call`: a
repayment or deposit on Burrow, or a swap on Rhea. NEP-141 requires exactly 1 yoctoNEAR on that call. So:

- a function-call key cannot sign any of these actions: the NEAR runtime rejects them;
- a full-access key could, but it can also add keys, deploy code and drain the account. The executor **refuses a
  full-access key** before any cycle runs ([`key-guard.ts`](packages/tx-execution/src/key-guard.ts)).

The result is deliberate: the agent cannot sign on its own, and everything runs dry-run. Real autonomous execution
needs custody with its own limits, for example an on-chain guard contract or an MPC signer. That is on the roadmap,
not built.

**Try it**

1. Run `pnpm demo:attack`. You see 8 attacks stopped and 2 control actions allowed, ending in `signed 0, broadcast 0`.
   - The attacks: two prompt injections, a foreign recipient, an extra Withdraw, a stale price, a thin pool, a forged
     approval and a full-access key.
   - The log is in `docs/evidence/demo-attack.log.jsonl`.
2. Open `:3001` and keep the demo portfolio and Demo mode. On "Repay … of the loan", press **Let the agent do it**:
   - enter `30`: you see "Done as a dry run", and the demo balances change under a "Changed by the agent
     (simulated)" note;
   - enter `80`: the policy asks for your confirmation ("exceeds auto-approval threshold $50").
3. Open `:3001/activity`. You see your request, the policy's answer and that nothing was signed or sent.
4. Run `docker compose --profile shadow exec analytics-api node --import tsx src/evidence/cli.ts verify`. You see
   every audit chain `ok` and `"checkpoints":"ok"`. `:3001/audit` shows the same.
5. Open `:3001/policy`. You see stored verdicts, each check with its inputs.
6. Run `pnpm --filter @near-autopilot/analytics test`. You see `signing-lock.test.ts` pass. It fails if any dashboard
   source calls a wallet's signing method.

**Not done**

- No autonomous signing and no guard contract.
- No TEE attestation and no counterparty-reputation service.
- Mainnet signing is locked; the wallet connection is sign-in only.

### DeFi track: protect the position, refuse value-losing actions

**This is dry-run. There are no real trades.** Mainnet is read only. Plans are built, checked and simulated. The
1Click API is called with `dry: true`, which is a constant in the client.

**What works**

- A read-only mainnet collector runs every 15 minutes. It reads Rhea v1 and DCL pools and Burrow markets, and prices
  from several cross-checked sources. Everything is stored with block heights.
- Two demo portfolios ($500 and $5,000, labelled simulated) are analysed every cycle. Each option is costed after
  fees, swaps, gas, borrowing interest and impermanent loss.
- An action below the hurdle is refused: a net benefit under $0.50, or a benefit under 3× its cost.
- The health guardian repays debt or adds collateral when the Burrow health factor falls. It never borrows.
- The Shadow Gateway compares a Rhea quote with a 1Click dry quote for each allowed plan. It records the best route
  with `executed: false`.

**Try it**

1. Open `:3001`. You see the demo portfolio:
   - holdings, net worth and the monthly result;
   - loan safety ("safe unless NEAR falls N%");
   - the options ranked after costs, each with its plan, costs and risks.
2. Open `:3001/opportunities`, then a "USDC / wNEAR (concentrated …)" pool. You see a table for ±5/±15/±50 % ranges:
   fees, divergence loss and net result, plus what actually happened over the stored window.
3. Open `:3001/routes`. You see Rhea compared with 1Click for an allowed plan, with `executed: false`.
4. Press **Connect wallet** and sign in with a NEAR wallet (checked with HOT). You see your own mainnet account, read
   only: holdings, Burrow position, options. Nothing can be signed.

**Not done**

- No real swaps, deposits or repayments on mainnet.
- No LP execution: pools are analysis only.
- No Chain Signatures and no cross-chain settlement.

### Thesis track: displayed APR and TVL are not the yield you keep

[THESIS.md](THESIS.md) tests three counts on 90 days of NEAR mainnet data: Rhea v1 and Burrow, 91 daily blocks, from
2026-08-06 to 2026-11-04. The falsification rules were fixed in advance. Verdict: supported on all three, with the
counter-evidence written out.

**Try it**

1. Run `pnpm install && pnpm thesis:rebuild`, then `git diff --stat`. Nothing changes: the committed CSV, SVG charts
   and THESIS.md are exactly what the committed raw data gives. A test fails otherwise.
2. Check any data point by hand with the archival RPC call in THESIS.md's "Reproduce" section. For example, pool 4512
   at block 223087984 returns the same reserves as `thesis/data/raw/rhea-pools.jsonl`.
3. Open `:3001/research`. You see the findings in plain language, with the charts.

**Not done**

- Rhea DCL pools are not part of the thesis yet: they are in the dashboard only.
- No BigQuery or Intents Explorer data: the thesis uses archival RPC view calls only.
- The window is 90 days.

## What it does

Two interchangeable decision engines feed the same pipeline
(snapshot → agents → planner → **policy engine** → executor → Postgres → dashboard), selected by `AUTOPILOT_ENGINE`:

**`legacy`** (default)

| Agent             | Job                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `health-guardian` | When the Burrow health factor drops below a trigger, repays debt (or adds collateral) to reach a target. Never borrows. |
| `rebalancer`      | Optional. Keeps wallet holdings near target weights with one capped Rhea swap per cycle.                                |

**`orchestrator`** (dry-run only; [docs/orchestrator.md](docs/orchestrator.md))

| Agent                  | Job                                                                                  | In the current API wiring                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `liquidation-guardian` | Ranked de-risk candidates (repay, add collateral) from the position and stress tests | Active                                                                                                          |
| `market-intelligence`  | Volatility, oracle-divergence, depeg and liquidity signals that tighten decisions    | Shadow profile: mainnet prices (source divergence, 24h range); else `insufficient_data`                         |
| `lp-optimizer`         | Rhea DCL range re-centring, advisory only, with payback estimate                     | `insufficient_data`: no LP positions are read; shadow profile reports the pools observed and why rejected       |
| `capital-allocator`    | Target-weight allocation swaps using yield estimates                                 | Shadow profile: valid Burrow supply APRs ([docs/mainnet-shadow.md](docs/mainnet-shadow.md)); missing ones named |

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
  rhea-dcl-adapter/ Rhea/Ref v2 concentrated-liquidity (DCL): typed views, exact tick math, tx builders, ABI check (the analytics API uses its liquidity math for the DCL estimates; no DCL transaction is built)
  burrow-adapter/   Burrow markets/accounts/oracle readers, exact health-factor/LTV/stress maths, verified repay and collateral builders
  agents/           Health guardian and rebalancer (pure decision logic)
  orchestrator/     Multi-agent portfolio orchestrator: schema-validated proposals, pure decision engine, stale-data guard, idempotency, audit hash chain, escalation, emergency read-only mode (docs/orchestrator.md; AUTOPILOT_ENGINE=orchestrator, dry-run only)
  policy-engine/    12 checks -> ALLOW / WARN / BLOCK verdict with policy version and snapshot id (stored in policy_verdicts, docs/policy-verdicts.md); the only code that can mint an ApprovedPlan
  tx-execution/     Planner registry, live executor, explicit dry-run executor
  db/               Drizzle schema, client, SQL migrations
config/             autopilot.example.json (mainnet ids), autopilot.shadow.example.json (mainnet read-only shadow profile)
docs/               architecture.md, security.md, financial-engine.md, orchestrator.md, mainnet-shadow.md,
                    rhea-dcl-capability-matrix.md, burrow-capability-matrix.md,
                    policy-verdicts.md, shadow-gateway.md, audit-evidence.md
```

In dry-run, every approved plan goes through the **Shadow Gateway** (`apps/api/src/gateway/`). The gateway re-checks
the stored ALLOW verdict and the approval, then quotes Rhea pool #4512 and a NEAR Intents 1Click **dry** quote. It
records the best execution in `execution_routes` (`GET /v1/routes`). It has no signer. See
[docs/shadow-gateway.md](docs/shadow-gateway.md).

Every audit event is appended to a **hash chain in Postgres**, which continues across restarts. Every policy verdict
stores its inputs and config. `pnpm audit:verify` re-checks the chains and `pnpm audit:replay` re-evaluates the
verdicts. See [docs/audit-evidence.md](docs/audit-evidence.md).

**Investment thesis:** [THESIS.md](THESIS.md). `pnpm thesis:rebuild` rebuilds it offline from the raw mainnet data
committed in `thesis/data/raw/`: CSV, SVG charts and the document with every number. A test fails if the committed
outputs differ from what the raw data gives. `pnpm thesis:fetch` re-reads the raw data (archival RPC, view calls only).

`pnpm demo:attack` runs labelled attack fixtures (prompt injection, foreign recipient, extra Withdraw, stale price,
thin pool, forged approval, full-access key) through the real defences. Every attack is stopped and the log is
written to `docs/evidence/demo-attack.log.jsonl`. The live executor refuses full-access keys. See
[docs/security.md](docs/security.md).

Dependency direction is enforced mechanically (ESLint + `scripts/check-boundaries.mjs`, both driven by
`boundaries.config.mjs`). See [docs/architecture.md](docs/architecture.md).

## Quick start

**Three commands, Docker only.** No NEAR wallet, private key or API key:

```bash
git clone https://github.com/deafmsn201111-sys/near-autopilot && cd near-autopilot
./scripts/quickstart.sh            # or --offline: simulation only, nothing leaves the machine
open http://127.0.0.1:3001         # analytics: policy decisions, routes, audit trail, thesis, markets
```

The script never overwrites anything. It works as follows:

1. Creates `.env` with fresh random secrets (never printed) and `config/autopilot.json`, only if they are missing.
2. Starts Postgres, the simulation autopilot (dashboard `:3004`) and the read-only mainnet analytics (`:3001`, shadow
   autopilot `:3003`).
3. Waits until every container is healthy.
4. Runs one dry-run cycle, so a policy verdict, a gateway record and audit entries exist from the start.

Nothing is signed or sent. Mainnet is read with view calls through a public RPC.

**Without keys**, the public RPC is rate-limited, so the collector sends one request at a time and retries patiently.
Pyth is skipped and cycles report `partial`; the NEAR price still comes from the three-exchange quorum plus DefiLlama.
Set `MAINNET_READ_RPC_API_KEY` (FastNEAR) and `PYTH_API_KEY` in `.env` for full-speed, complete cycles.

**Measured on a fresh clone** (2026-11-08, macOS, Docker Desktop): `./scripts/quickstart.sh` took 6 min 13 s to
healthy containers, with no manual edits, and `pnpm verify` passed. (Earlier, 2026-11-06: 3 min 51 s; `audit:verify`
passed and `audit:replay` matched 1 of 1 verdict.)

## Using the dashboard (`:3001`)

Four pages for a person who wants to use the autopilot, and one area for reviewers.

| Page              | What you see and do                                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Portfolio**     | Net worth, monthly result, loan safety in words; what the portfolio holds; **what you could do with the idle money**, best result after every cost first, each with its plan, costs, risks and the autopilot's own view; the last decision; "Refresh with live data" |
| **Opportunities** | Every Rhea pool, Burrow market and same-asset loop with usable data, ranked by result after costs, risk and data confidence together                                                                                                                                 |
| **Activity**      | Every decision of the autopilot for the portfolio, in plain words: what each agent saw, what was proposed, what the safety policy said and why. Identical checks in a row are grouped                                                                                |
| **Research**      | The investment thesis in four findings and one table: advertised APR vs what people kept, by pool type, with survivors and shrunk pools                                                                                                                              |
| For reviewers     | The technical evidence: safety policy checks, audit trail with signed checkpoints, execution routes, controls (pause, read-only), system health, raw markets, prices, simulations, collector log                                                                     |

**Shadow mode.** Prices, pools and rates are read live from NEAR mainnet (view calls). The two portfolios ($500 and
$5,000) are simulated and labelled as such.

- **Let the agent do it** (Demo mode, demo portfolios): the agent plans the action, the policy runs its 12 checks,
  and the executor runs it as a dry run. The demo balances then change as if it had been sent: a simulated ledger
  with a "Reset demo" button. Nothing is signed or sent.
- **Connect wallet** (HOT Connector): sign-in only, no access key added. It opens a read-only view of your own mainnet
  account. The two mainnet modes are shown, but their signing is locked.

**Actions on the Portfolio page** (all simulated over 30 days, current rates held, not compounded):

- _Repay part of the loan with idle USDt_ — saves the borrow interest; the autopilot itself repays only to protect the
  loan (health factor below 1.5).
- _Lend idle USDt / NEAR on Burrow_, _swap NEAR to a stablecoin and lend it_ — supply rate minus gas and swap cost.
- _Provide liquidity on Rhea_ — from the stored LP simulation: fees − impermanent loss − entry/exit − gas.
- _Loop on Burrow_ — deposit, borrow the same asset, deposit again: leverage set exactly by Burrow's health-factor
  formula for a target HF of 1.6. Shown for comparison; the autopilot never borrows.

Each action says whether it clears the autopilot's profit bar (at least $0.50 after costs and a gain of at least 3× the
costs), or why the autopilot would not do it.

### What works today, and what does not

| Area                                                                                | Status                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mainnet market data (prices with quorum, Rhea registry and history, Burrow markets) | Implemented, read-only                                                                                                                           |
| Opportunity ranking with risk and confidence                                        | Implemented (heuristic ordering aid, documented weights)                                                                                         |
| Independent policy engine (12 checks), Shadow Gateway, hash-chained audit, replay   | Implemented                                                                                                                                      |
| Durable orchestrator mode and idempotency (restart- and race-safe)                  | Implemented (PostgreSQL, migrations 0013-0014)                                                                                                   |
| LP simulation                                                                       | Two-token v1 pools: stored simulation. DCL: per-range backtest from stored history (pools with confirmed prices). Other pool types `UNSUPPORTED` |
| Net yield for Burrow supply                                                         | Implemented: supply rate minus gas (and swap cost where a swap is needed)                                                                        |
| Looping strategy (same-asset, Burrow)                                               | Implemented as a simulation; the autopilot cannot borrow                                                                                         |
| Signed audit checkpoints outside the database                                       | Implemented (ed25519 key in .env; file + append-only table; migration 0015)                                                                      |
| Wallet connection                                                                   | Sign-in only (HOT Connector) with a read-only account view; signing locked                                                                       |
| Mainnet execution, AI assistant                                                     | **Not implemented.** Planned, see [docs/HACKATHON_PLAN.md](docs/HACKATHON_PLAN.md)                                                               |

Verify without the UI, inside the running container (no Node needed on the host):

```bash
docker compose --profile shadow exec analytics-api node --import tsx src/evidence/cli.ts verify   # chains + signed checkpoints
docker compose exec api node --import tsx src/evidence/cli.ts replay    # every stored verdict, recomputed
```

With Node and `pnpm install`: `pnpm demo:attack` (attack fixtures against the real defences) and
`pnpm thesis:rebuild` (thesis outputs from the committed raw data, byte-identical).

**Developer setup:** Node 22 (`.nvmrc`), pnpm 9.15 (`packageManager`), Docker with Compose v2 (for Postgres, or the
whole stack).

```bash
pnpm install --frozen-lockfile
cp .env.example .env              # mainnet + dry-run by default; set API_TOKEN, POSTGRES_PASSWORD, DATABASE_URL, AUTOPILOT_ACCOUNT_ID
cp config/autopilot.example.json config/autopilot.json   # then edit (see below)

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

Use it with `config/autopilot.example.json` (the demo tokens must be allowlisted).
`AUTOPILOT_ENGINE=orchestrator` runs the multi-agent orchestrator instead of the legacy guardian; both are covered by
`apps/api/test/simulation.test.ts`.

### Local Docker demo (simulation, orchestrator, dry-run)

Everything in containers, bound to `127.0.0.1` only. `.env` and `config/autopilot.json` are git-ignored; generate
fresh secrets rather than reusing the example values.

```bash
cp .env.example .env    # then set: API_TOKEN / POSTGRES_PASSWORD (openssl rand -hex 32), DATABASE_URL to match,
                        # DATA_SOURCE=simulation, AUTOPILOT_ENGINE=orchestrator, EXECUTION_MODE=dry-run,
                        # AUTOPILOT_ACCOUNT_ID=<any valid *.near id>; DASHBOARD_PORT etc. if a port is taken
cp config/autopilot.example.json config/autopilot.json   # set policy.signerAccountId = AUTOPILOT_ACCOUNT_ID
docker compose up -d --build        # postgres -> api (runs migrations) -> dashboard; all three have health checks
docker compose ps                   # wait for (healthy)
docker compose logs -f api          # structured JSON logs
docker compose stop                 # stop, keep data   |   docker compose start   # resume
```

Two images serve every API and dashboard container: `near-autopilot-api:local` (built by `api`) and
`near-autopilot-dashboard:local` (built by `dashboard`). The shadow / analytics services reuse them, so a
rebuild runs each Dockerfile once instead of once per service: `docker compose build api dashboard`, then
`docker compose --profile shadow up -d` to restart whatever runs the old image.

The `pgdata` volume survives `stop`, `down` and reboots (`restart: unless-stopped` brings the stack back when Docker
Desktop starts). `docker compose down -v` deletes the database: don't, unless you mean it. Switch portfolio with
`SIMULATION_PORTFOLIO=demo-5000` in `.env` and `docker compose up -d api`.

In this mode the three market-dependent agents (market intelligence, LP optimizer, capital allocator) report
`no_action / insufficient_data` every cycle because no market-data source is integrated; only the liquidation
guardian acts. Each run's `snapshot.agents` records what every agent returned.

### Mainnet read-only analytics: shadow collector and analytics dashboard

A read-only MAINNET shadow analysis of a simulated portfolio, with the price quorum and yield rules:
[docs/mainnet-shadow.md](docs/mainnet-shadow.md). Read-only integration suites:

```bash
pnpm --filter @near-autopilot/burrow-adapter test:live     # BURROW_LIVE=1
pnpm --filter @near-autopilot/rhea-dcl-adapter test:live   # RHEA_DCL_LIVE=1
```

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

| Port (127.0.0.1) | Service                              | Profile  |
| ---------------- | ------------------------------------ | -------- |
| 3001             | analytics dashboard (collector data) | `shadow` |
| 3003             | shadow autopilot dashboard           | `shadow` |
| 3004             | simulation autopilot dashboard       | default  |
| 4000, 4002, 4003 | API: simulation, shadow, analytics   | as above |
| 5432             | Postgres (volume `pgdata`)           | default  |

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
reason, never the value). See `.env.example` for the full list. `NEAR_NETWORK` accepts only `mainnet`;
mainnet contract defaults are built in.

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
  read-only mainnet mode. `.env`, `config/autopilot.json`, key and credential files are git-ignored.
- `EXECUTION_MODE=live` is refused on mainnet, with the orchestrator engine, and with simulation; it also refuses to
  start without a signer, and the autopilot ships none. Users sign in their own wallet.
- Generate `API_TOKEN` and `POSTGRES_PASSWORD` locally (`openssl rand -hex 32`); never reuse example values.
- All published ports bind to `127.0.0.1`. Details and threat model: [docs/security.md](docs/security.md).

## HTTP API

All `/v1/*` routes require `Authorization: Bearer <API_TOKEN>`.

| Route                 | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `GET /health`         | Liveness                                                        |
| `GET /ready`          | Readiness (database reachable)                                  |
| `GET /v1/portfolio`   | Live valuation, health factor, holdings                         |
| `GET /v1/runs`        | Recent pipeline runs                                            |
| `GET /v1/proposals`   | Proposals with policy outcome and tx hash                       |
| `GET /v1/policy`      | Active limits (read-only)                                       |
| `GET /v1/market-data` | Mainnet prices, per source and asset (shadow profile)           |
| `GET /v1/yield`       | Mainnet yield estimates per source, with validation and reasons |
| `POST /v1/runs`       | Run one cycle now (409 if one is running)                       |

Response shapes live in `packages/core/src/api-contracts.ts` and are shared with the dashboard.

## Honest limitations

- **The autopilot ships no signer, and the server never signs.** `EXECUTION_MODE=live` refuses to start until you implement
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
  [docs/security.md](docs/security.md#pre-signing-checklist).
- Pyth Hermes requires an API key since August 2026; without `PYTH_API_KEY` only DefiLlama is used and every price is
  `single_source`.
- The orchestrator engine is dry-run only. Its control state (mode, quarantines) and idempotency (cycle claims,
  actions, in-doubt executions) are durable in Postgres (migration 0013) and restart- and race-safe; its audit entries
  are written through to `audit_events` (fails closed). Yields come only from mainnet
  Burrow supply rates (shadow profile); Rhea v1 fee APRs need two observations ≥ 1 h apart and an allowlisted pool,
  DCL APRs are not computed, and there is no LP position reader, so the LP Optimizer returns `insufficient_data`.
- Public RPCs are slow and rate-limit (HTTP 429). The RPC client retries reads only, with
  backoff, jitter, Retry-After and bounded concurrency, and never retries a send; a dedicated endpoint is still
  advisable.
- `pnpm db:generate` cannot diff against the current schema: `packages/db/drizzle/meta` has no snapshot files
  (migration `0001` is hand-written). Write further migrations by hand, or regenerate the snapshots first.
- Rhea quoting is single-hop through operator-listed pools only.
- Proposals that exceed the approval threshold are recorded as `requires_approval` and held; there is no
  approval UI yet.
- `requires_approval` and `approved` rows are never auto-resumed. An `approved` row that never resolves
  (crash mid-send) must be reconciled by hand using its transaction hash/plan hash.
