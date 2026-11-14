# near-autopilot

A policy-gated autopilot for NEAR DeFi positions. Agents watch a wallet and its
[Burrow](https://burrow.finance) lending position, propose actions (repay debt, add collateral,
rebalance through [Rhea](https://rhea.finance) pools), and a deterministic **policy engine** decides
whether each action may run. Nothing is signed unless policy approved that exact transaction.

> **The server never signs.** It holds no key. It builds an exact **unsigned** transaction cascade, checks it
> against fixed caps (allowlisted contracts and methods, at most 0.15 NEAR per action and 0.3 NEAR per cascade) and
> hands it to your own wallet, where you sign it or not ([docs/security.md](docs/security.md)).
>
> **Status:** read-only mainnet analytics and wallet-signed cascades. No seed phrase, private key or wallet is needed
> to run anything below.

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

NEAR Autopilot is an AI DeFi analyst for NEAR. It guards lending positions against
liquidation, refuses actions that lose money after costs, and analyses liquidity pools. Three levels are kept apart
everywhere in this repository:

| Level             | What                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Works now**     | Automatic decisions, a 12-check policy engine, a tamper-evident audit trail. Execution is **dry-run only**: plans are built, checked and simulated, never signed or sent. |
| **Analysis only** | Liquidity pools (Rhea v1 and DCL concentrated liquidity) are costed and backtested. The agent never opens a position.                                                     |
| **Roadmap**       | See [docs/HACKATHON_PLAN.md](docs/HACKATHON_PLAN.md).                                                                                                                     |

The server reads mainnet with view calls only; a transaction is only ever signed in the user's own wallet. NEAR
Intents 1Click gives dry quotes for route comparison, and real quotes only for depositing into your account from
another chain (you send from your own wallet there; the server builds no transaction).

**Live site:** https://near-autopilot.tech. Live mainnet data, the two simulated demo portfolios, and your own
account once you connect a wallet ([deploy/public](deploy/public/README.md)).

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
- a full-access key could, but it can also add keys, deploy code and drain the account.

The result is deliberate: the server holds no key and never signs. The agents' proposals run as dry runs on the demo
portfolios; for a connected wallet the server builds the unsigned cascade, `validateCascade` checks it
([`validate-cascade.ts`](apps/api/src/wallet/validate-cascade.ts)), and the user signs it in their own wallet.

**Try it**

1. Run `pnpm demo:attack`. You see 8 attacks stopped and 2 control actions allowed, ending in `signed 0, broadcast 0`.
   - The attacks: two prompt injections, a foreign recipient, an extra Withdraw, a stale price, a thin pool, a forged
     approval and a full-access key.
   - The log is in `docs/evidence/demo-attack.log.jsonl`.
2. Open `:3001/activity?account=autopilot-test.near`. You see the transactions that account signed through the app,
   each confirmed by NEAR RPC, with what really happened ("Repaid 5.01 USDC on Burrow") and an explorer link.
3. Run `docker compose exec analytics-api node --import tsx src/evidence/cli.ts verify`. You see every audit chain
   `ok` and `"checkpoints":"ok"`. `:3001/audit` shows the same.
4. Open `:3001/policy`. You see the safety verdict of every cascade built for a real account (ALLOW or BLOCK, each
   check), and the attack demo labelled as fixtures.
5. Run `pnpm --filter @near-autopilot/analytics test`. You see `signing-lock.test.ts` pass. It fails if any site
   source other than `lib/wallet-sign.ts` calls a wallet's signing method.

**Not done**

- No server-side signing (by design) and no guard contract.
- No TEE attestation and no counterparty-reputation service.

### DeFi track: protect the position, refuse value-losing actions

**This is dry-run. There are no real trades.** Mainnet is read only. Plans are built, checked and simulated. The
route comparison calls 1Click with `dry: true`, a constant in that client. Real 1Click quotes exist only for deposits
from another chain (below), in a separate client.

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
4. Press **Connect wallet** and sign in with a NEAR wallet (checked with HOT). You see your own mainnet account:
   holdings, Burrow position, options. A recommendation's button builds the exact unsigned transactions; you sign
   them in your wallet or cancel.

5. **Fund from another chain.** Connected, press **Deposit** (next to your account) or **Fund from another chain**
   on the portfolio. Pick the network you send from (Ethereum, Base, Arbitrum, Solana or Bitcoin), then the token
   (search by symbol, popular ones first, every token with its logo), the amount, what you receive on NEAR (wNEAR, USDC or USDT) and your own refund address on that chain. The server
   checks the refund address, asks 1Click for a real quote, verifies it against what you asked and only then shows
   a one-time deposit address with a QR code, the deadline 1Click sets and the fee 1Click reports in the quote (an optional
   partner key, `ONE_CLICK_JWT`, gives the partner schedule). Send exactly that amount from your wallet on that chain;
   1Click delivers to your NEAR account, or refunds to your address if the swap fails. The dialog follows the
   deposit like a payment terminal: waiting, "received 40 of 50 USDC", swapping, then done (with the NEAR
   transaction), refunded (amount and reason) or failed. It checks every 5 s, backing off to 30 s, at most 120 times;
   it stops at a final status, or 30 min after the deadline if nothing arrived ("expired"), and keeps the last status with a
   **Check again** button. The browser sends only our quote id; the server looks up the address, asks 1Click
   (cached 5 s per quote, rate-limited per visitor). What we keep: one `deposit_quotes` row per address shown (your
   NEAR account, the tokens and amounts, your refund address on the other chain, the deposit address, deadline, fee,
   1Click's id and signature, and the latest status with its time), deleted after 30 days; no IP address.

**Not done**

- The agents never act on their own: every mainnet transaction is one the user signed.
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

The collector runs the agents on the two simulated demo portfolios every cycle
(snapshot → agents → planner → **policy engine** → dry-run executor → Postgres → site). Two engines exist, selected by
`AUTOPILOT_ENGINE`; the collector uses `orchestrator`:

**`legacy`**

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
in Postgres and visible on the site.

### Architecture C: the central LLM on a connected wallet

**Run AI analysis** on a connected wallet calls `POST /v1/analytics/account/:id/analysis`. The server reads a fresh
Burrow snapshot of that wallet (balances and loan, priced with the same confirmed prices as the portfolio table) and
gives the central LLM six tools:

| Tool                      | What runs                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `liquidation_guardian`    | The orchestrator's `LiquidationGuardianAgent`: smallest repayment that restores HF 1.6, from the wallet, or from the collateral of the same token when the wallet holds too little, or by withdrawing another collateral token, swapping it and repaying (HF never under 1.15 after any step); the card shows the loan rate and what the Burrow deposits earn per month, and a safe loan that earns more than it costs gets no repay offer |
| `capital_allocator`       | The orchestrator's `CapitalAllocatorAgent` (idle supply): deposit idle tokens at today's Burrow rate                                                                                                                                                                                                                                                                                                                                       |
| `market_intelligence`     | The orchestrator's `MarketIntelligenceAgent`: Burrow oracle vs the collector's confirmed prices, and the 24 h price range                                                                                                                                                                                                                                                                                                                  |
| `portfolio_concentration` | Wallet check: share of the portfolio in one token; the swap uses only what the wallet holds                                                                                                                                                                                                                                                                                                                                                |
| `lp_optimizer`            | The orchestrator's `LpOptimizerAgent`: an out-of-range Rhea DCL position moves to a new range around the price (remove → swap → add) when the extra fees, from the pool's 24 h volume, repay the move within 14 days; else the exit to the wallet                                                                                                                                                                                          |
| `burrow_withdrawals`      | Wallet check: Burrow supply that can move to the wallet (all of it with no loan, else what keeps HF 1.6)                                                                                                                                                                                                                                                                                                                                   |

**Loans.** A loan below HF 1.5 gets a card that repays down to HF 1.6, not the whole debt (a loop that earns more than
it costs is the user's call to close). When the wallet lacks the debt token, it repays from the collateral of the same
token in one priced Burrow call (`DecreaseCollateral` + `Repay`), so nothing has to be in the wallet. The card has an
amount field, a slider and "To safe (1.6)" / "Whole debt" buttons; the health factor after the chosen amount updates
live in the loan-safety colours, and the button prepares exactly that amount. When the debt token is neither in the
wallet nor the collateral, the card repays with another collateral token in separate transactions signed in order:
withdraw it from Burrow (only what the wallet lacks), swap it on Rhea, repay with the swap's minimum output. The card
and the preview show the health factor after each step; it never drops under 1.15, even if you stop after the first
one, or the card has no button and says why (D25). A card with no action that can be built (no route for the swap,
or the concentrated token is not in the wallet) is advice without a button.

The model sees only numbers and token names from our own list: a token's own `ft_metadata` symbol never reaches it (an
unknown token appears as its shortened contract id, on the AI-ranked cards too), and the prompt does not carry the
account id. The model only orders the candidates the tools returned and writes a short "why". Code computes every number and every
transaction amount: an id no tool returned is dropped, and a "why" that contains a number its own card or the tools' shared context does not show is replaced
by the code's own text, and every warning the model left out (a loan warning above all) is put back first. At most 6 model turns and 45 s. With no API key, or on any failure (model error, invalid JSON, too many
turns), the page shows the rule-based list, labelled **Heuristic (AI unavailable)**; an LLM answer is labelled
**AI-ranked**. When neither the rules nor the agents find an action worth $1 or more, no model is called: the page says
**Nothing for the AI to rank** and keeps the same "How the AI got here" timeline: the wallet read, each agent's line,
and a neutral "AI not asked" step with a reason built by code from those lines (e.g. "Why: Health factor 1.29; safe
from 1.25 on Aggressive · Nothing idle to put to work · …"). A recommendation still goes through `POST /v1/wallet/prepare` and `validateCascade`; agent-sized
amounts are passed as exact base units and capped at the wallet balance. The LP Optimizer is not a tool yet (it
needs a 24 h volume source), and the allocator's swap proposals and the guardian's collateral top-up are not offered.

Under **AI-ranked**, **How the AI got here** lists each agent the model called, one line each with its key number
(health factor before and after the repayment, the supply rate, the largest gap between two price sources, the
concentration share, positions out of range) and that number's provenance label, plus what became of its card
(its place in the AI ranking, kept by code when the model left out a loan warning, or left out by the AI), under a
pipeline of the run: what was read on-chain, what each agent returned, what the model ranked, and what code checked
before showing it (explanations whose numbers all came from the agents, explanations replaced, warnings put back,
made-up actions dropped). The model may add one sentence (at most 300 characters) on why the cards are in this
order; it is shown under the ranking step as "Why this order: …" only when every number in it appears on a card the
user sees or in the tools' shared context, there are at least two cards, and code did not put back a warning the
model left out (that changes the order); otherwise it is dropped. The line is built on the server
from the tool output, so it shows the same number as the card. When Market Intelligence has no second price source
it says so; it never reports "healthy" without a comparison.

The pipeline fills in live while the analysis runs: the browser asks for `text/event-stream` and the API sends one
event per real step (`read`, `asked` when the model picks the agents to call, an `agent` event as each tool result
comes back, `ranked`, `checked`), then `done` with the same analysis the JSON reply carries. All four stages show
from the first event: the current one pulses, later ones are dimmed, each agent the model asked for waits on a
placeholder until its result arrives, and a clock runs until the end. The events are the same server-built lines, never raw tool output. A cached result or a rule-based list arrives as a single `done`, so it appears at once (a cached one is labelled
"from a run N min ago"); a stream that breaks falls back
to the plain JSON request.

**Spend cap and what we log.** The model is `claude-haiku-5-5` or `claude-sonnet-5-5` (anything else stops the API at
start). Before each model call the server checks today's spend (UTC day) plus that call's worst case against
`LLM_DAILY_CAP_USD` (default $5; a value in the `llm_settings` table overrides it); over it, no call is made and the
page shows the rule-based list with "daily AI budget reached". Every fallback carries a code (`off`, `kill_switch`, `not_owner`,
`cap`, `model_error`, `invalid_output`, `empty`, `nothing_to_rank`, `deadline`, `cancelled`, `loop_limit`). **What we log:** one `llm_calls` row per
analysis that reached the model, with the account id, model, input/output tokens, cost in USD, latency, tools
called and the outcome code. No IP address, no visitor key, no text from the model or the tools. Rows older than 7
days are deleted (on start, then hourly). One `events` row per wallet connect (reported by the browser, marked
client-reported, at most once per account per UTC day), ownership proof, analysis (AI or rule-based), prepared
cascade with its `validateCascade` verdict and per-check result (also a blocked one), signed transaction (the tx hash,
written only after NEAR RPC shows it final and successful, signed by the account, and exactly a step the server
prepared) and 1Click deposit quote. Account id only, no IP address; rows older than 30 days are deleted.

**Admin (server only).** A separate loopback-only admin (`/admin`, reached through an SSH tunnel; the public site
answers 404) shows AI spend against the cap and has a kill switch and the cap field
([deploy/public/README.md](deploy/public/README.md#admin-ai-spend-and-kill-switch), D16 in `docs/DECISIONS.md`).

## Repository layout

```
apps/
  api/            MAINNET read-only collector (src/collector), analytics API + wallet cascade builder
                  (src/analytics, src/wallet), pipeline wiring (src/wiring.ts)
  analytics/      Next.js site, the product UI (talks to the analytics API only)
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
  tx-execution/     Planner registry, dry-run executor
  db/               Drizzle schema, client, SQL migrations
config/             market.json: token/pool allowlists and market limits for the collector and its agents
docs/               architecture.md, security.md, financial-engine.md, orchestrator.md, mainnet-shadow.md,
                    rhea-dcl-capability-matrix.md, burrow-capability-matrix.md,
                    policy-verdicts.md, shadow-gateway.md, audit-evidence.md
```

In dry-run, every approved plan goes through the **Shadow Gateway** (`apps/api/src/gateway/`). The gateway re-checks
the stored ALLOW verdict and the approval, then quotes Rhea pool #4512 and a NEAR Intents 1Click **dry** quote. It
records the best execution in `execution_routes` (`:3001/routes`). It has no signer. See
[docs/shadow-gateway.md](docs/shadow-gateway.md).

Every audit event is appended to a **hash chain in Postgres**, which continues across restarts. Every policy verdict
stores its inputs and config. `pnpm audit:verify` re-checks the chains and `pnpm audit:replay` re-evaluates the
verdicts. See [docs/audit-evidence.md](docs/audit-evidence.md).

**Investment thesis:** [THESIS.md](THESIS.md). `pnpm thesis:rebuild` rebuilds it offline from the raw mainnet data
committed in `thesis/data/raw/`: CSV, SVG charts and the document with every number. A test fails if the committed
outputs differ from what the raw data gives. `pnpm thesis:fetch` re-reads the raw data (archival RPC, view calls only).

`pnpm demo:attack` runs labelled attack fixtures (prompt injection, foreign recipient, extra Withdraw, stale price,
thin pool, forged approval, full-access key) through the real defences. Every attack is stopped and the log is
written to `docs/evidence/demo-attack.log.jsonl`. See
[docs/security.md](docs/security.md).

Dependency direction is enforced mechanically (ESLint + `scripts/check-boundaries.mjs`, both driven by
`boundaries.config.mjs`). See [docs/architecture.md](docs/architecture.md).

## Quick start

**Three commands, Docker only.** No NEAR wallet, private key or API key:

```bash
git clone https://github.com/deafmsn201111-sys/near-autopilot && cd near-autopilot
./scripts/quickstart.sh
open http://127.0.0.1:3001         # portfolio, opportunities, policy decisions, routes, audit trail, thesis
```

The script never overwrites anything. It works as follows:

1. Creates `.env` with fresh random secrets (never printed), only if it is missing.
2. Starts Postgres, the analytics API (applies the migrations), the mainnet collector and the site (`:3001`).
3. Waits until every container is healthy. The collector's first cycle fills the pages within a few minutes.

Nothing is signed or sent. Mainnet is read with view calls through a public RPC.

**Without keys**, the public RPC is rate-limited, so the collector sends one request at a time and retries patiently.
Pyth is skipped and cycles report `partial`; the NEAR price still comes from the three-exchange quorum plus DefiLlama.
Set `MAINNET_READ_RPC_API_KEY` (FastNEAR) and `PYTH_API_KEY` in `.env` for full-speed, complete cycles.

**Measured on a fresh clone** (2026-11-08, macOS, Docker Desktop): `./scripts/quickstart.sh` took 6 min 13 s to
healthy containers, with no manual edits, and `pnpm verify` passed (measured before the autopilot API was removed).

## Using the dashboard (`:3001`)

Four pages for a person, and one area for reviewers.

| Page              | What you see and do                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Portfolio**     | Net worth, monthly result, loan safety in words; what the portfolio holds; **what you could do with the idle money**, best result after every cost first, each with its plan, costs, risks and the autopilot's own view; the last decision                             |
| **Opportunities** | Every Rhea pool, Burrow market and same-asset loop with usable data, ranked by result after costs, risk and data confidence together                                                                                                                                   |
| **Activity**      | What you did through the app for your account, newest first: each prepared cascade with what NEAR says really happened for every signed step, confirmed by RPC. Anyone sees the confirmed transactions; analyses and unsigned cascades only after you verify ownership |
| **Research**      | The investment thesis in four findings and one table: advertised APR vs what people kept, by pool type, with survivors and shrunk pools                                                                                                                                |
| For reviewers     | The technical evidence: safety policy checks, audit trail with signed checkpoints, execution routes, system health, raw markets, prices, simulations, collector log                                                                                                    |

**Live data, simulated demo.** Prices, pools and rates are read live from NEAR mainnet (view calls). The two demo
portfolios ($500 and $5,000) on Home are simulated and labelled as such.

- **Signing progress.** After you sign, each step shows ⏳ while it executes and ✓ or ✗ when the server has asked
  NEAR RPC for its final status. A failed step names the contract, its error and what happened to your funds (refund
  confirmed, or nothing left your wallet); the next step is not offered.

- **Connect wallet** (HOT Connector): no access key added. It opens your own mainnet account with ranked
  recommendations; a recommendation's button builds the unsigned cascade and your wallet asks you to sign it.
  **Run AI analysis** re-ranks and explains them with the central LLM for a visitor who verified ownership (below; 5 runs per visitor per 10 minutes).
- **Your account** reads everything the account holds on NEAR: native NEAR, every fungible token (list from
  FastNEAR's `/v1/account/{id}/full`), Burrow, Rhea v1 liquidity in any pool (pool ids from `api.ref.finance`, shares
  read on-chain), Rhea DCL positions, liquid staking and NEAR staked with validator pools (balances read on-chain).
  Tokens on our list are priced with the collector's confirmed prices; any other token is marked **Unverified**,
  priced as an estimate from Rhea's indexer (or "no price", kept out of the totals), shown only and never used in a
  suggestion or sent to the model. The largest 7 rows show first ("Show all" for the rest); anything under $1, and
  every unpriced unverified token, sits behind "Show small balances". When an indexer is down, the page says so and
  shows the allowlisted tokens and pools only.

- **Strategy** (on "Your account"): Conservative, Balanced or Aggressive. It changes when a loan or a position gets a
  card, how urgent the card is and how much it suggests repaying or swapping; the Liquidation Guardian and the AI
  prompt use the same lines. Stablecoins never count as a concentration. The choice is in the link (`&strategy=`) and
  is remembered for that account in this browser.

  | Strategy     | Loan safe from HF | Repay back to HF | Urgent below HF | One token: card / urgent / swap down to |
  | ------------ | ----------------- | ---------------- | --------------- | --------------------------------------- |
  | Conservative | 1.80              | 2.00             | 1.50            | 50% / 75% / 40%                         |
  | Balanced     | 1.50              | 1.60             | 1.30            | 60% / 85% / 50%                         |
  | Aggressive   | 1.25              | 1.35             | 1.15            | 75% / 95% / 65%                         |

  A strategy is the set of risks it accepts, not a forecast; within that set the code picks the highest yield it can
  compute. The idle-money card names what its strategy weighed, as a "calculated estimate" line under the reason:

  | Strategy     | Idle money may go to                                        | Today                                                         |
  | ------------ | ----------------------------------------------------------- | ------------------------------------------------------------- |
  | Conservative | Burrow lending only                                         | supply                                                        |
  | Balanced     | Burrow lending, or a stablecoin pool that pays clearly more | supply (no stablecoin pool is tracked yet)                    |
  | Aggressive   | the highest yield, leverage included                        | supply, or a same-asset loop at HF 1.35 shown as numbers only |

  The app never borrows, so a loop has no button: when it pays more, the supply card keeps its button (the loop's
  first step) and says what the loop would earn, at which borrow rate it stops paying, and that it can be liquidated.

- **Verify ownership** (optional, unlocks AI analysis). Connecting alone does not prove that you own an account: the
  site only learns an account name from the wallet, and anyone can type any account. So the AI analysis (which costs
  money per run) is only for a visitor who signs a short NEP-413 message in the wallet. It is not a transaction:
  nothing is sent and no gas is paid. The server rebuilds the exact text, checks the signature, checks that the
  signing key is a full-access key of that account on mainnet (a key only the owner holds, not a key a dApp was
  given), and accepts the proof for 24 hours. Anyone else, or a visitor who declines to sign, gets the heuristic
  analysis. If the key can't be read from the network at that moment, the page says so and checks again once by itself
  (no new signature; "Check again" after that); it never shows such a failure as "not the owner".

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
| Wallet connection and signing                                                       | HOT Connector; unsigned cascades checked by `validateCascade`, signed in the user's wallet (`MAINNET_WALLET_SIGNING=1`)                          |
| Server-side execution                                                               | **None, by design.** The server holds no key                                                                                                     |
| AI analysis of a connected wallet                                                   | Implemented: central LLM calls three orchestrator agents and three wallet checks as tools (architecture C above); rule-based fallback, labelled  |

Verify without the UI, inside the running container (no Node needed on the host):

```bash
docker compose exec analytics-api node --import tsx src/evidence/cli.ts verify   # chains + signed checkpoints
docker compose exec analytics-api node --import tsx src/evidence/cli.ts replay   # every stored verdict, recomputed
```

With Node and `pnpm install`: `pnpm demo:attack` (attack fixtures against the real defences) and
`pnpm thesis:rebuild` (thesis outputs from the committed raw data, byte-identical).

**Developer setup:** Node 22 (`.nvmrc`), pnpm 9.15 (`packageManager`), Docker with Compose v2.

```bash
pnpm install --frozen-lockfile
pnpm verify                       # format, lint (incl. boundaries), typecheck, tests
./scripts/quickstart.sh           # the whole stack in containers
```

### Local stack

Everything in containers, bound to `127.0.0.1` only. `.env` is git-ignored; the quickstart generates fresh secrets.

| Service         | What it does                                                                                        | Port (127.0.0.1) |
| --------------- | --------------------------------------------------------------------------------------------------- | ---------------- |
| `postgres`      | Database (volume `pgdata`)                                                                          | 5432             |
| `analytics-api` | Applies the migrations, serves the stored data read-only, builds unsigned wallet cascades           | 4003             |
| `collector`     | Reads mainnet on a schedule (view calls only), runs the agents on the two simulated demo portfolios | none             |
| `analytics`     | The site                                                                                            | 3001             |

```bash
docker compose ps                   # wait for (healthy)
docker compose logs -f collector    # one JSON line per cycle: status, records, duration
docker compose stop                 # stop, keep data   |   docker compose start   # resume
```

The `pgdata` volume survives `stop`, `down` and reboots. `docker compose down -v` deletes the database: don't, unless
you mean it.

### The mainnet collector

A read-only MAINNET analysis of two simulated portfolios, with the price quorum and yield rules:
[docs/mainnet-shadow.md](docs/mainnet-shadow.md). The collector reads MAINNET with view calls only (no signer exists,
no transaction is sent, no LLM is called) and stores everything in Postgres:

- every Rhea v1 and DCL pool (full registry rescan every `COLLECTOR_REGISTRY_EVERY` cycles, and after downtime longer
  than that), classified as `DISCOVERED / LIQUID / LOW_LIQUIDITY / UNSUPPORTED / DATA_INVALID / ANALYTICS_ELIGIBLE /
LP_SIMULATION_ELIGIBLE` with reason codes. Discovery never allowlists a pool;
- all Burrow markets (supply / borrow APR, utilisation, limits, reward programmes);
- prices per source (Pyth, DefiLlama, exchanges), with freshness, confidence and divergence checks;
- fee windows 1H / 24H / 7D / 30D from cumulative pool volumes, an LP entry simulation (fees, impermanent loss,
  entry/exit cost, gas) and a strategy comparison for the demo portfolios, all from one snapshot per cycle;
- the agents' decision for each demo portfolio (`DATA_SOURCE=simulation`: an in-process mock RPC serves the
  synthetic balances, every row is labelled `simulation`), the policy verdicts and the Shadow Gateway's dry quotes.

The cycle interval is `SHADOW_CYCLE_INTERVAL_SECONDS` (default 900 s, counted from the end of a cycle). Opening the
site never triggers a read from the chain for the market pages: they show what the collector stored. Without
`PYTH_API_KEY` the collector skips Pyth and marks every cycle `partial`.

| Demo portfolio | Synthetic position                                        | What the agents do                                            |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `demo-500`     | gross $500: 120 wNEAR collateral, 200 USDt debt, HF ~1.28 | guardian repays ~$40 USDt; policy approves; dry-run, not sent |
| `demo-5000`    | gross $5,000: 1150 wNEAR collateral, 2000 USDt debt       | needed repay ~$464 exceeds the $100 per-action cap; rejected  |

**Looping** (`apps/api/src/analytics/looping.ts`): same-asset loops only. With Burrow's health factor
`Σ collateral·vr / Σ debt/vr` and the same asset on both sides, HF = L·vr²/(L−1), so a target HF h gives
L = h/(h−vr²) exactly. Net = L·supply − (L−1)·borrow − gas for every round in and out. Reports the break-even borrow
rate and the days until rate drift alone would bring the health factor to 1.0.

Read-only integration suites:

```bash
pnpm --filter @near-autopilot/burrow-adapter test:live     # BURROW_LIVE=1
pnpm --filter @near-autopilot/rhea-dcl-adapter test:live   # RHEA_DCL_LIVE=1
```

### Market config

`config/market.json` (validated at startup by `apps/api/src/market-config.ts`, unknown keys rejected) holds:

- `policy` — signer account (the demo account, never used to sign), contract/token/recipient allowlists, per-action and
  daily USD limits, approval threshold, slippage and oracle-deviation caps, cooldown;
- `guardian`, `rebalancer`, `orchestrator` — the agents' thresholds;
- `rhea.pools` — the exact pools a swap may use;
- `yield` — the pools observed for fee APRs and the yield plausibility limits.

`policy.signerAccountId` must equal `AUTOPILOT_ACCOUNT_ID`. The wallet cascade limits are separate and fixed in code
(`apps/api/src/wallet/validate-cascade.ts`).

### Environment

All environment variables are validated at startup by `packages/config` (errors name the variable and
reason, never the value). See `.env.example` for the full list. `NEAR_NETWORK` accepts only `mainnet`;
mainnet contract defaults are built in.

## Scripts

| Command                                     | Purpose                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                  | Analytics API + site in watch mode                                                                               |
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
  read-only mainnet mode. `.env`, key and credential files are git-ignored.
- The server holds no key and never signs: `EXECUTION_MODE=live` is refused at start-up, and there is no signer in
  the code. Users sign in their own wallet, only when `MAINNET_WALLET_SIGNING=1`, and only cascades that pass
  `validateCascade`.
- Generate `API_TOKEN` and `POSTGRES_PASSWORD` locally (`openssl rand -hex 32`); never reuse example values.
- All published ports bind to `127.0.0.1`. Details and threat model: [docs/security.md](docs/security.md).

## HTTP API

The analytics API (`apps/api/src/analytics`). All `/v1/*` routes require `Authorization: Bearer <API_TOKEN>`; the site
calls them from its server, so the token never reaches the browser. Every route is read-only (`GET /v1/analytics/*`)
except `POST /v1/wallet/prepare`, which builds an unsigned cascade and checks it with `validateCascade`, and
`POST /v1/analytics/account/:id/analysis`, which runs the LLM analysis (reads only; it builds no transaction).

## Honest limitations

- **The server never signs.** There is no signer in the code, and `loadApiEnv`/`wire()` reject live execution
  outright (there is no override). The agents' runs are dry-run; a mainnet transaction is only ever signed by the user
  in their own wallet. See [docs/security.md](docs/security.md).
- **Simulation is not on-chain.** `DATA_SOURCE=simulation` uses synthetic balances and fixed demo prices served by
  an in-process mock RPC; nothing it shows was read from NEAR, and nothing is ever sent.
- **`dry-run` sends nothing.** A `dry_run` proposal is a plan that passed policy, not a transaction; it has no tx hash.
- **Transactions are signed and sent only by the user's wallet**, never by the server. Transaction payloads (Rhea v1
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

## Disclaimer

- **Not financial advice.** Recommendations are generated by heuristics and an LLM and can be wrong. They show the
  numbers behind every suggestion; deciding what to do is yours.
- **Nothing runs on its own**, despite the name. NEAR Autopilot never holds your keys: every transaction is built
  unsigned, shown action by action, and signed by you in your own wallet, at your own risk. Review every action in
  your wallet before you approve it.
- **DeFi is risky.** Burrow, Rhea and liquid-staking contracts carry smart-contract, oracle, liquidation,
  impermanent-loss and slippage risk. Displayed APRs are variable, not guaranteed returns.
- **Unaudited hackathon software**, provided as is, without warranty of any kind ([MIT](LICENSE)).
