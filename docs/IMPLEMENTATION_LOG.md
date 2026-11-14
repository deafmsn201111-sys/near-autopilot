# IMPLEMENTATION_LOG

_Append-only log of what was actually inspected/changed each session (brief §23)._

## 2026-11-08 — Phase 0 Discovery

**Inspected:**

- Ran `pnpm verify` → 15/15 green. API tests 261 passed / 38 skipped.
- Read live wiring (`apps/api/src/wiring.ts`): two engines, orchestrator behind `AUTOPILOT_ENGINE`, 4 heuristic agents wired, `LlmAgent` unwired.
- Read `signer.ts` → `loadSigner()` returns null (dry-run invariant confirmed).
- DB schema: 24 tables; migrations 0000–0016.
- Config: zod env schema (DATA_SOURCE, EXECUTION_MODE, AUTOPILOT_ENGINE, market/yield, RPC keys, CEX/DefiLlama/Pyth).
- HTTP surface: ~40 routes (read-only analytics + operator + health + gateway).
- No smart contract in repo (Guard = net-new). CI = verify job + Postgres db job.
- Probed live demo: real mainnet prices render.

**Changed files:**

- `docs/PROJECT_AUDIT.md`, `docs/CURRENT_ARCHITECTURE.md`, `docs/TARGET_ARCHITECTURE.md`, `docs/DEPENDENCY_MAP.md`, `docs/TECHNICAL_RISKS.md`, `docs/SECURITY_THREAT_MODEL.md`, `docs/IMPLEMENTATION_ROADMAP.md`, `docs/PROJECT_STATUS.md`, `docs/IMPLEMENTATION_LOG.md`, `docs/KNOWN_ISSUES.md`, `docs/DECISIONS.md` (all new).
- Earlier same day (pre-transformation): redeploy of public demo to `fix/audit` (no app code change in this step).

**Tests run:** `pnpm verify` (green). No code changed in P0 → no regression risk.

**Remaining issues / blockers:** target architecture confirmed from the master brief (planner doc never shipped). Autonomous execution blocked on Guard + review.

**Next:** P1 `T1.1` provenance enum.

## 2026-11-10 — #12 remove testnet

- Env: `NEAR_NETWORK` mainnet only; `mainnet-reference` and `testnet-onchain` removed (D7).
- Market data: testnet reference assets and labels removed; `testnetToken` → `token` in the API contract.
- Adapters: testnet Burrow/DCL deployments and `DCL_TESTNET_CANDIDATES` removed; fixtures use mainnet ids.
- Attack demo runs on mainnet ids with an inline policy; `docs/evidence/demo-attack.log.jsonl` regenerated (8/8 stopped).
- `config/autopilot.testnet.example.json` deleted; `docs/market-data.md` and `docs/yield-data.md` folded into
  `docs/mainnet-shadow.md`.
- Left for #13: `apps/dashboard`, `autopilot-config`, `EXECUTION_MODE=live` / `signer.ts`.

## 2026-11-10 — Security 1: guard `/api/prepare` (#9)

- `apps/analytics/app/api/prepare/route.ts` answers 415 unless `content-type` is `application/json` (also blocks
  cross-site form posts) and 429 with `retry-after` over 30 calls per visitor / 600 overall per 10 minutes.
- The in-memory limiter moved from `lib/public-demo.ts` to `lib/rate-limit.ts` and is always on for prepare. The
  visitor key is the `X-Forwarded-For` that Caddy overwrites. Map bounding stays with #11.

**Tests run:** `pnpm verify` (green), new `apps/analytics/test/prepare-route.test.ts`.

## 2026-11-11 — #13 remove autopilot, apps/dashboard, PUBLIC_DEMO

- Deleted the autopilot API (`src/main.ts`, `src/server.ts`, `services/requests.ts`, `presenters.ts`), `signer.ts`, the
  live branch in `wire()`, `control/` and `/v1/control/*`, the collector's `/run` and pause, `apps/dashboard`,
  `/autopilot`, `request-actions.ts`, `PUBLIC_DEMO` (D8).
- `autopilot-config.ts` → `market-config.ts`, `config/autopilot.shadow.example.json` → `config/market.json`,
  `AUTOPILOT_CONFIG_FILE` → `MARKET_CONFIG_FILE`; the old example config is a test fixture now.
- `analytics-api` applies the migrations; compose: `postgres`, `analytics-api`, `collector`, `analytics` (no profiles).
  `quickstart.sh` rewritten; CI builds the analytics image instead of the dashboard one.
- Signing only via `MAINNET_WALLET_SIGNING` (on in deploy/public, D9); the account-lookup rate limit is always on.
- Docs: README, architecture.md rewritten, orchestrator / policy-verdicts / shadow-gateway / mainnet-shadow /
  deploy README updated, `docs/dashboard.md` folded into README (looping formula).

**Tests run:** `pnpm verify` (green); new `market-config.test.ts`, `rate-limit.test.ts`, `/v1/control` 404 test.
Not run here: `./scripts/quickstart.sh` (no Docker on the build machine).

## 2026-11-11 — #52 account view no longer spends its own rate limit

The layout refreshes every page every 15 s; on "Your account" each refresh re-read the account and took one of the
30 lookups per visitor per 10 min, so an idle tab hit "Too many requests" in about 7 minutes. The account read is now
cached per visitor for 60 s (`lib/product.ts`), shared by `accountView` and `accountRecommendations` (which used to read it a
second time, outside the limit); only a real read spends the limit. After a new transaction from the wallet
(`AccountWatcher`, `PrepareDialog`) the `refreshAccount` server action drops that visitor's cached read first (another
visitor cannot drop it), so the page shows
the new state at once. Limit unchanged.

**Tests run:** `pnpm verify` (green), `next build`; new `account-cache.test.ts`.

## 2026-11-11 — Security 6: strict CSP and generic error messages (#10)

- `apps/analytics/middleware.ts` sets a per-response nonce CSP (`lib/csp.ts`): `script-src 'nonce-…' 'strict-dynamic'`,
  `object-src 'none'`, `base-uri`, `form-action`, `frame-ancestors 'none'`. The theme script and HOT Connector's
  sandboxed wallet iframe get the nonce (`cspNonce`). Caddy adds a second baseline policy next to it (`+` header).
- API: Fastify error handler returns `internal error` for 5xx and logs the details; account and prepare routes keep
  their own 4xx / `RangeError` texts and replace upstream (RPC) text with a short message. The UI shows the API's own
  message, never the internal URL or a `fetch failed` cause.

**Tests run:** `pnpm verify` (green); new `public-errors.test.ts`, `api-errors.test.ts`, `csp.test.ts`. Local run:
every script on 14 pages carries the nonce, an injected inline handler is blocked, HOT's iframe renders its QR, the
missing-account page shows the short message, Caddy (local container) sends both policies.

## 2026-11-11 — Security 7: bounded caches, polling limits, VPS hardening (#11)

- `BoundedMap` (`packages/core`): a Map capped at N keys, dropping the least recently set. The API account cache
  (`account-view.ts`, 500 entries, stale entries deleted on read) and the per-visitor rate-limit counts
  (`lib/rate-limit.ts`, 10,000 keys, expired keys swept first) use it. The overall per-kind counts live in their own
  map, so a flood of new visitors on one route cannot evict another route's overall cap.
- `AutoRefresh` and `AccountWatcher` poll through `lib/polling.ts`: no ticks while the tab is hidden, and they stop
  after 30 minutes (since #60, coming back to the tab starts them again). 1Click status polling limits are in #29.
- `setup.sh` keeps `.env` at `chmod 600` on every run. The server README has the ufw rules (SSH, 80, 443 only), notes
  that Docker-published ports bypass ufw, and that a new secret goes only to the services that use it.

**Tests run:** `pnpm verify` (green); new `bounded-map.test.ts`, `polling.test.ts`, more cases in
`rate-limit.test.ts`.

## 2026-11-11 — Anthropic `LlmClient` adapter (#15)

- `apps/api/src/llm/anthropic-client.ts`: `AnthropicLlmClient` implements the orchestrator's `LlmClient` port over
  the official `@anthropic-ai/sdk` (one user message, model and `max_tokens` from config). Any reply that does not
  stop on `end_turn`, or has no text, throws, so the caller falls back to heuristics. 120 s timeout, one retry. `anthropicLlmFromEnv`
  returns null without a key (LLM off). Not wired yet: that is #18.
- `llmEnvSchema` (`packages/config`): `ANTHROPIC_API_KEY` (optional), `ANTHROPIC_MODEL` (default
  `claude-haiku-5-5`), `ANTHROPIC_MAX_TOKENS` (default 4096, max 16000). In both compose files only `analytics-api` receives
  the key; its env schema merges `llmEnvSchema` when #18 wires the agent.

**Tests run:** `pnpm verify` (green); new `anthropic-llm.test.ts` (mocked SDK), `llmEnvSchema` cases in
`env.test.ts`.

## 2026-11-11 — Pool allowlist for `add_liquidity` (#23)

- `POST /v1/wallet/prepare`: an `add_liquidity` intent whose `poolId` is not in `config.rhea.pools` is rejected
  with 409 `pool <id> is not allowlisted` before any chain read.
- `validateCascade` takes `allowedPools`; every `add_liquidity` action must carry a numeric `pool_id` in it. With
  no `allowedPools` given, any `add_liquidity` fails (closed by default).

**Tests run:** `pnpm verify` (green); new `prepare-pool-allowlist.test.ts`, two cases in `validate-cascade.test.ts`.

## 2026-11-11 — NEP-413 ownership check for LLM analysis (#20)

- `apps/api/src/wallet/ownership.ts`: `verifyOwnership` rebuilds the NEP-413 payload (borsh, tag 2^31+413, SHA-256),
  checks the ed25519 signature with `node:crypto`, the 24 h nonce window and that the key is a full-access key of the
  account. Fails closed. Message, recipient and nonce layout are shared with the UI from `@near-autopilot/core/ownership`.
- The account endpoint returns `ownerVerified` (D12). The UI shows "Ownership verified" or "Heuristic analysis" on the
  account page, with a **Verify ownership** button when the connected wallet is that account (`signOwnership` in
  `lib/wallet-sign.ts`). Disconnect clears the proof cookie. The LLM itself is wired behind this flag in #18.

**Tests run:** `pnpm verify` (green); new `ownership.test.ts` (signatures made with `@near-js/crypto` + `borsh`, not
our code), a proof-forwarding case in `account-cache.test.ts`.

## 2026-11-11 — Tool-use loop: orchestrator agents as LLM tools (#18)

- `packages/orchestrator/src/tool-loop.ts`: `runToolLoop` with a `maxTurns` bound; unknown tools and invalid inputs
  get an error result and never run. New port `ToolLlm` / `ToolChat` in `ports.ts`.
- `apps/api/src/llm/anthropic-client.ts`: `AnthropicToolLlm` (manual Messages API tool loop; replays assistant content
  unchanged; any stop other than `end_turn`/`tool_use` throws). `anthropicToolLlmFromEnv` wired in `analytics/main.ts`.
- `apps/api/src/analytics/ai-analysis.ts`: five tools (three orchestrator agents, two wallet checks), picks
  validation, numbers-from-tools check, labelled fallback. `POST /v1/analytics/account/:id/analysis` in
  `account-view.ts`; the account read is now a reusable `readAccount`.
- `prepare`: optional exact `amount` for repay/supply (`exactAmount` in `wallet/amounts.ts`).
- UI: **Run AI analysis** button, source badge, `/api/analysis` route (rate limited), `amount` passed to prepare.
- Decision D13.

**Tests run:** `pnpm verify` (green); new `tool-loop.test.ts`, `ai-analysis.test.ts` (scripted fake LLM),
`analysis-endpoint.test.ts`, `analysis-route.test.ts`, `AnthropicToolLlm` and `exactAmount` cases.

## 2026-11-11 — Backlog review: template, milestones M1–M4, rewritten issues

**Why:** issues were vague; work found mid-task turned into ad-hoc issues or scope creep, and the Day 1–4 milestones
no longer said what comes first.

- Issue template `.github/ISSUE_TEMPLATE/task.md` (Why, Goal, Scope in/out, Done when, How to verify, Docs,
  Depends on / Blocks / Conflicts with, Size, Agent notes). All 37 open issues rewritten to it after a code audit.
- Milestones M1 Safe to open → M2 Demo works → M3 Full scope → M4 Submission replace Day 2–4; the order of work is
  the `Order:` line in each milestone's description, which `/ticket` reads.
- New issues #67–#76 (AI ranking reset, backups/uptime, cross-token unwind, demo decision, docs refresh, LLM on
  production, full portfolio read, home for judges, live/owner carry-over, positioning). #28 merged into #27.
- `HACKATHON_PLAN.md`: schedule and cut order follow the milestones; decisions updated (model allowlist and cap
  fallback, presets without min APR, 1Click chains / optional JWT / status by deposit address, `ADMIN_API_TOKEN`).

## 2026-11-12 — LLM spend cap and llm_calls (#21)

- `llm_calls` + `llm_settings` (migration 0018), `DrizzleLlmLedger`: one row per analysis that reached the model,
  numbers only, purged after 7 days by the analytics API.
- Daily cap per UTC day (`LLM_DAILY_CAP_USD`, default $5, DB override) checked before every model call against the
  worst case; usage via `ToolLlm.open({ onUsage })`, SDK retries off; `ANTHROPIC_MODEL` allowlist with a price table.
- Fallback codes on the analysis result and in `llm_calls.outcome` (D14).

## 2026-11-12 — LLM input: token names from our own list only (#19)

**Why:** anyone can deploy a token whose `ft_metadata` symbol is an instruction; that text reached the model's prompt.

- Agent tool candidates (guardian, allocator) name tokens with `modelTokenLabel` (`apps/api/src/thesis/labels.ts`: the
  same list as the thesis `tokenLabel`, else the contract id, shortened past 20 chars), not the snapshot symbol.
- The account view builds a second rule-based list for the model (`forModel`, kept off the HTTP body) with labelled
  symbols and DCL pair names; the wallet-check tools return it. The user-facing fallback and portfolio table keep the
  metadata symbol. The prompt no longer carries the account id.
- Residual: token ids, DCL pool/LP ids and agent notes still reach the model as contract ids (`accountIdSchema`
  charset, ≤ 64 chars); candidate ids need them.
- Test: `analysis-endpoint.test.ts` "what the model is sent" — hostile symbols on a wallet token and both DCL pool
  tokens appear nowhere in what the fake model receives.

## 2026-11-12 — Secrets audit before the repo goes public (#45)

- gitleaks over all refs (222 commits): 376 findings, all public NEAR token ids or a test key except the known
  FastNEAR key from `ed756ee`. Issue and PR bodies and comments (58 issues, 21 PRs): no secrets; the VPS IP in #8 is
  public through DNS.
- `.gitleaks.toml`, `.gitleaksignore`, CI job `secrets`; D15 (rotate, no rewrite).
- `.claude/skills`: MIT licences for `grill-me`/`grilling`, `README.md` with sources; `near-dapp`/`near-intents`
  untracked (no upstream licence).
- Repo description and homepage: owner step (needs admin rights).

## 2026-11-12 — Security 6b: no raw upstream text in stored reasons (#48)

**Why:** the collector stored raw upstream error text (RPC, price providers, 1Click) and the public pages showed it.

- `apps/api/src/public-text.ts`: `failureKind` (error kind + HTTP status, else `unknown error`) for every write site
  (venues, Pyth/DefiLlama/exchange observations, collector source and cycle, route probe); full text goes to the log.
- Read side: `publicCycle`, `publicRoute`, `publicObservation` on overview, collector, system, activity, routes,
  prices and price history, so rows stored before the fix are cleaned (marker rewrite + URL/HTML/stack net).

## 2026-11-12 — AI result cache and global AI limit in the API (#22)

- `analysisKey` (`apps/api/src/analytics/analysis-key.ts`): sha256 of the observation without dates, the rule-based
  list and the preset. `analyseAccount` reads the wallet first, then serves a cached `llm` result (10 min, 200
  entries) without a model call or `llm_calls` row.
- Global limit moved from the Next route to the API: 60 model runs per 10 minutes, fallback `busy`; the route keeps
  5 per visitor.

## 2026-11-12 — Aborted and long-context LLM calls count toward the daily cap (#85)

- A model call cut off (deadline, dropped connection) before its reply reported usage is recorded at one worst-case call
  (100K input + `ANTHROPIC_MAX_TOKENS` output), so the next run sees it against the cap.
- No request is sent whose input could pass 100K tokens (Haiku's 5x long-context rate): the bound is the last
  reply's input + output tokens + UTF-8 bytes of the new tool results + 2K overhead; over it, fallback `loop_limit`.

## 2026-11-12 — Fixed phrases for yield sources and orchestrator escalations (#82)

- `apps/api/src/yield/service.ts`: a failed source (final block, Burrow, Rhea v1, DCL) stores `failed: <kind>`
  (`failureKind`); the full error goes to `onError` (the logger). The agents' market notes inherit the clean detail.
- `packages/orchestrator`: `CYCLE_ABORTED` / `AUDIT_UNAVAILABLE`, `IN_DOUBT_EXECUTION` and `EXECUTION_FAILED`
  escalation messages and the aborted cycle detail (served as `portfolios[].outcome`) no longer carry the thrown or
  executor error; it is logged instead.

## 2026-11-12 — Rate limiter: no shared sweep (#59)

- `apps/analytics/lib/rate-limit.ts`: removed `sweep`, which dropped every visitor entry older than the window of the
  kind being consumed and scanned all 10,000 keys per call once full. Visitors now live in one `BoundedMap` per kind
  (10,000 each), so LRU eviction alone bounds memory and never drops a live entry of one kind for another.

## 2026-11-12 — Admin: Spend screen and kill switch (#31)

- API: `/v1/admin/spend` and `/v1/admin/settings` behind `ADMIN_API_TOKEN` (D16); `spendSummary` gives today vs cap,
  7 UTC days, model split, average per analysis and the deposit run-out estimate. Migration 0019 adds `llm_enabled`,
  `deposit_micro_usd`, `deposit_set_at` to `llm_settings`.
- `analyseAccount` reads the kill switch first: off → labelled rule-based list, code `kill_switch`, no model call, no
  cached AI result.
- UI: `apps/analytics/app/admin` (404 unless `ADMIN_UI=1`), server actions for the switch, cap and deposit.
- Deploy: `analytics-admin` service on `127.0.0.1:3002`, Caddy 404 for `/admin*`, `setup.sh` and `quickstart.sh`
  add `ADMIN_API_TOKEN` to an existing `.env`.

## 2026-11-12 — One priced-leg list for the account's totals, bar and concentration (#66)

- `apps/api/src/analytics/account-view.ts`: `accountPortfolio` builds the legs (wallet, Burrow, Rhea v1 + DCL split
  into tokens, liquid staking only when the wallet list does not already hold the token) and returns `metrics` and
  `totals` from them. Net worth now includes LP; stNEAR is counted once; the concentration % and its rebalance amount
  use the same total as the hero.
- `apps/analytics/app/page.tsx`: a real account's allocation bar reads `metrics.byToken`; the holdings table adds one
  row per LP position (and any staking token not in the wallet list), so it sums to "$X in assets". Demo portfolios
  are unchanged.

## 2026-11-12 — AI ranking survives auto-refresh (#67)

- The UI keeps the AI result while the card ids and holdings (4 significant digits, prices excluded) stay the same; the
  15 s refresh no longer drops it. When they change, the rule-based list returns with "Your portfolio changed — run the
  AI analysis again." (`apps/analytics/lib/portfolio-signature.ts`).

## 2026-11-13 — Haiku vs Sonnet on real wallets (#16)

- `apps/api/src/llm/compare-models.ts` (`pnpm --filter @near-autopilot/api llm:compare <account> …`): runs the real
  analysis loop per model/effort config and prints cost, latency, outcome and picks. `registerAccountView` now returns
  `analysisInputs`, which the analysis route also uses.
- `AnthropicToolLlm` takes an optional `effort` (`output_config.effort`).
- Result in D17: Haiku 5.5 at default effort stays; same answers as Sonnet 5.5 at 1/15 the cost.

## 2026-11-13 — The account view reads the whole account and hides small balances (#73)

- `apps/api/src/analytics/discovery.ts`: FastNEAR tokens + staking pools, Rhea v1 pool ids, Rhea indexer prices;
  zod, caps, null on failure (D18).
- `apps/api/src/analytics/account-view.ts`: wallet tokens beyond Burrow's list, v1 LP in any pool the account has
  shares in, native staking (staked / unstaking rows). Every holding and position row carries `verified`, `estimate`,
  `small`; actions, recommendations and the agents' observation use verified tokens only. `discovery.complete` tells
  the page when it fell back to the allowlists.
- `apps/analytics/app/page.tsx`: "What you hold" (top 7, "Show all"), "Unverified tokens", "Show small balances".
- Test: `apps/api/test/account-full.test.ts` replays recorded mainnet reads of `npro-validator.near`.

## 2026-11-13 — Portfolio mode label (#87)

- `apps/analytics/lib/portfolio-mode.ts`: one label + one "what you can do here" line from `isAccount`, the
  connected wallet (`np_account` cookie), the ownership proof and `MAINNET_WALLET_SIGNING`: demo / read-only (with a
  "not your connected wallet" line on mismatch) / your wallet / ownership verified. Replaces the "Live" / "Simulated"
  badge; the switch tab is now "Mainnet account" without the LIVE chip.
- `WalletButton` writes the `np_account` cookie before the post-connect page load, so the first load already knows
  the wallet.

## 2026-11-13 — Polling restarts when the user comes back (#60)

- `poll()` (`apps/analytics/lib/polling.ts`) still stops 30 minutes after start, but the tab becoming visible or
  getting focus starts a fresh 30-minute window, with an immediate tick if polling had stopped. An unattended tab
  still goes quiet (Security 7); a tab the user returns to updates again after signing. `stop()` removes the listeners.

**Tests run:** `pnpm verify` (green); `polling.test.ts` covers the deadline, restart on visible/focus, extending a
running window and listener removal.

## 2026-11-13 — Reasoning trace in the UI (#26)

- `apps/api/src/analytics/ai-analysis.ts`: `analyseAccount` returns `trace`, one `{tool, agent, ok, text, provenance}`
  per offered tool the model called (first-call order, made-up tool names dropped, `Failed` when every call failed).
  Each tool writes its line from the numbers it returns to the model; raw outputs stay on the server. The market tool
  also returns each held token's gap to the second price source. The heuristic fallback has an empty trace.
- `packages/orchestrator/src/agents/market-intelligence.ts`: with no second price source and no volatility it answers
  `insufficient_data` instead of `healthy`.
- `apps/analytics`: the analysis schema accepts `trace` and `calledTools` (both optional for older replies); a "How the
  AI got here" block under the badge, with the provenance label per line, or the plain list of called tools.
- Each trace line also says what became of its card (`pick`: ranked / kept by code / left out, and `rank`); a card
  the model left out still shows its number, labelled as left out. The guardian line names the debt token missing
  from the wallet when it cannot size a repayment. `run` summarises the model run (model, turns, tool calls, ms).
- `run.read` (tokens held, loan or not) and `run.checks` (picked, explained, replaced, restored, dropped) let the UI
  show the run as a four-step pipeline: read → agents → model ranking → code checks.

## 2026-11-13 — No $0 cards on small wallets (#99)

- Reduce-concentration and put-idle-to-work cards (rule-based and the AI deposit) need an action of at least $10
  (`MIN_ACTION_USD` in `apps/api/src/analytics/ai-analysis.ts`); amounts are in cents, never rounded to $0.
- A low health factor always keeps its card: the repay is 30% of the debt, at least $10, at most the whole debt.
- What the agents skip as too small comes back as `skipped` (plain sentences with the wallet's numbers) and the
  dashboard lists it under the cards, so a $1–9 wallet gets a read instead of "looks balanced" or a failing button.

## 2026-11-13 — Fresh portfolio after signing (#65)

- API: `GET /v1/analytics/account/:id?fresh=1` replaces the cached read, at most once per account every 5 s (D20).
- UI: `refreshAccount` now reads fresh and returns whether the holdings changed; `refreshPortfolio`
  (`apps/analytics/lib/portfolio-refresh.ts`) retries up to 4 times, 5 s apart, shared by `PrepareDialog` and
  `AccountWatcher`, which shows "Transaction seen, updating your portfolio…" while it runs. The fixed 4 s wait after
  signing is gone.

**Tests run:** `pnpm verify`; `account-full.test.ts` (fresh flag and its 5 s gap), `account-cache.test.ts` (fresh
read, change detection, visitor limit), `portfolio-refresh.test.ts` (retries stop, early stop, shared run).

- Owner's local check found the action and the page did not share state: Next puts server actions in the
  `action-browser` layer and pages in `rsc`, each with its own module copy. The account cache and the rate-limit maps
  now live in `processWide` (`globalThis`); `test/setup.ts` clears them between tests.

## 2026-11-13 — One-click actions from $1 (#120)

- `MIN_ACTION_USD` 10 → 1; the idle-asset "skipped" note from $0.10 (D21). An $11 all-NEAR wallet now gets a
  rebalance card of about $5.57.

**Tests run:** `pnpm verify`; `portfolio-recommendations.test.ts` thresholds rewritten for $1.

## 2026-11-13 — Deposit from another chain through 1Click (#27)

- `apps/api/src/gateway/one-click-deposit.ts`: real-quote client (hard-coded URL, optional JWT, cached token list,
  every echoed field verified). `refund-address.ts`: per-chain refund address check.
- `apps/api/src/analytics/deposit.ts`: `GET /v1/deposit/assets`, `POST /v1/deposit/quote`; `deposit-store.ts` +
  migration 0020 `deposit_quotes` (30-day purge).
- `apps/analytics`: `/api/deposit/*` proxies (`deposit-quote` limit 5/100 per 10 min), `DepositDialog` (form → deposit
  address, QR, deadline countdown, fee) in the header and on the portfolio.
- D19.

## 2026-11-13 — Repay from collateral, withdraw from Burrow, no dead-end cards (#64)

- `packages/burrow-adapter/src/builders.ts`: `buildRepayFromCollateral` (one priced `oracle_call` →
  `Execute { [DecreaseCollateral?, Repay] }`); `buildWithdraw` takes `fromCollateralRaw` and releases collateral
  first, since Burrow's `Withdraw` only draws on plain supply.
- `packages/core/src/loan-math.ts`: health factor after a repay (wallet or collateral), the repay that reaches a
  target, the withdrawal that keeps it; shared by the API and the UI amount picker.
- `apps/api/src/analytics/account-view.ts`: the loan card repays to HF 1.6 (wallet if it holds enough, else from
  collateral, else advice only) and carries `sizing`; a last "Withdraw from Burrow" card; the concentration swap is
  capped at what the wallet holds (no button when it holds none). `POST /v1/wallet/prepare` gains
  `repay_from_collateral` and an exact `amount` for `withdraw`; both draw plain supply first, then collateral.
- `apps/api/src/analytics/ai-analysis.ts`: the guardian tool returns the repay-from-collateral card when the wallet
  cannot repay; new `burrow_withdrawals` wallet check.
- `apps/analytics/components/RepayPicker.tsx`: amount field + slider + "To safe" / "Whole debt", live HF in the
  zone colours; prepares exactly the chosen amount.
- Supersedes #99's "repay 30% of the debt, at least $10": the loan card now repays to HF 1.6.

## 2026-11-13 — Three strategy presets (#25)

- `packages/core/src/strategy.ts`: Conservative / Balanced / Aggressive thresholds, the request schema and the cookie
  name; shared by the API and the UI (D22).
- `apps/api/src/analytics/account-view.ts`: `portfolioRecommendations` and `loanHealth` read the preset; the repay and
  withdraw cards use its target HF; concentration skips stablecoins; the cache holds the wallet read and the cards are computed
  per request; `?strategy=` on the account read and `{ strategy }` on the analysis, 400 on an unknown one.
- `apps/api/src/analytics/ai-analysis.ts`: `walletAgentConfig(tokens, strategy)` moves the guardian's watch and target
  lines; the system prompt gets one line naming the preset and its numbers; the preset is in the analysis cache key.
- `apps/analytics`: strategy picker on "Your account" (URL param, then a per-account cookie), the preset in the
  account read cache key and in `POST /api/analysis`.
- `strategyNote`: when the presets agree on an account, a sentence under the picker says why.

## 2026-11-13 — Incoming NEAR transfers refresh "Your account" (#117)

- `apps/analytics/lib/account-signal.ts`: the watcher reads `view_account` (balance + block height) instead of the
  access-key nonces; `watchStep` drops stale blocks, compares at 4 significant digits and stays quiet while a refresh
  runs or for 10 s after (`recentlyRefreshed` in `portfolio-refresh.ts`). A received NEAR transfer now shows the
  "Transaction seen" note and the new balance within one tick (D20 amendment).

## 2026-11-13 — Loan cards show the carry; a safe profitable loan is left alone (#86)

- `apps/api/src/analytics/account-view.ts`: the account read splits the monthly Burrow figure into what the loan costs
  and what the deposits earn (`LoanCarry`, null when a $1+ position has no rate); the loan card carries
  `carry: { text, provenance: 'calculated_estimate' }` ("Loan costs X% a year (≈ $Y/month); your Burrow deposits earn
  ≈ $Z/month", or "rate unavailable"). `keepsProfitableLoan`: HF at or above the strategy's safe line and deposits
  earning more than the loan costs drops the "Repay $N of your loan" action.
- `apps/api/src/analytics/ai-analysis.ts`: the guardian's wallet repay card carries the same line; the system prompt
  says the reason to repay is the health factor, never the loan itself.
- `apps/analytics`: the line under the card's why, tagged with its provenance.

## 2026-11-13 — AI "nothing to act on" is an AI result; $0.00 monthly is neutral (#130)

- `analyseAccount`: an empty answer is an AI result (`source: 'llm'`) only when every proposing tool ran without error
  and neither they nor the rule-based list produced a candidate. A model that drops a real candidate, or skips or
  fails a check, still falls back with `empty`.
- UI badge: "AI-checked · nothing to act on" for that case.
- "Monthly result now" that rounds to $0.00 shows `$0.00` with no sign or colour (`signedMoney`), and the sentence
  says the position roughly breaks even (`earningsSentence`) instead of "costs about $0.00".

## 2026-11-13 — Idle supply sized the same on the AI path (#131)

- `CapitalAllocatorAgent.proposeSupply` deposits the whole idle balance; the decision engine no longer applies
  `maxSwapUsd` to `lending.supply` (D23). The AI card now says "Put $507.42 of your idle USDt to work", as the
  rule-based card does.

## 2026-11-13 — Live AI pipeline over SSE (#113)

- `packages/orchestrator/src/tool-loop.ts`: `onResult` reports each tool result as it comes back.
- `apps/api/src/analytics/ai-analysis.ts`: `analyseAccount(..., onEvent)` emits `read`, `agent`, `ranked`, `checked`
  from the same server-built lines as the trace; the JSON reply is unchanged.
- `apps/api/src/analytics/account-view.ts`: the analysis endpoint streams when asked for `text/event-stream` (D24).
- `apps/analytics`: the `/api/analysis` proxy passes the stream through unbuffered; `runAnalysis` parses the events
  (zod, unknown ones ignored), falls back to JSON; "How the AI got here" fills in as events arrive.
- `deploy/public/Caddyfile`: `flush_interval -1` on the reverse proxy.
- UI design pass: all four stages from the first event (current one pulses, later ones dimmed, the rail fills as
  they complete), placeholders for the agents the model asked for (`asked` event, `onCalls` in the tool loop), a
  running clock on the button and the header, the old cards dimmed during the run and the new ones fading in,
  `cachedAt` → "from a run N min ago"; no motion under `prefers-reduced-motion`.

## 2026-11-13 — Repay a loan with another collateral token (#69)

- `packages/core/src/loan-math.ts`: `swapRepayPlan` sizes withdraw → swap → repay (wallet tokens first, then plain
  Burrow supply, then collateral) to the preset's target HF without the HF after the withdraw going under
  `SWAP_REPAY_FLOOR_HF` (1.15); reasons `floor`, `no_gain`, `nothing` when it cannot.
- `apps/api/src/analytics/account-view.ts`: the account read picks the largest collateral token with an allowlisted
  pool to the largest debt and quotes it once (only for a loan under the strictest safe line with no same-token
  collateral); the loan card becomes `repay_with_collateral` with the HF after each step in its text and `plan`.
- `apps/api/src/wallet/swap-repay.ts` + `POST /v1/wallet/prepare`: re-reads, re-quotes, refuses a withdrawal under the
  floor, builds register? → withdraw → register? → swap → repay, "Transaction k of n" previews with the HF after each
  step; `validateCascade` with the oracle, Burrow, Rhea and the two tokens.
- `apps/api/src/analytics/ai-analysis.ts`: the guardian tool returns that card on the AI path, with the HF steps in
  the trace. `apps/analytics`: the new intent in the zod schema, the prepare mapping and the button label.
- `packages/rhea-adapter/src/planner.ts`: `buildRheaSwap`, the one instant-swap builder the planner, the prepare swap
  and the swap-repay cascade share.
- D25 in `docs/DECISIONS.md`.

## 2026-11-14 — Local runs can sign (#30)

- `.env.example` sets `MAINNET_WALLET_SIGNING=1`; `docker-compose.yml` defaults to `${MAINNET_WALLET_SIGNING-1}`, so a
  fresh quick start shows "Sign", while an existing `.env` with an empty value stays off (D9, caps unchanged).
- README: the "no transaction has ever been submitted" bullet now says the user's wallet signs and sends; the
  nearblocks link to the first live tx follows the owner's run.

## #119 — No model call when there is nothing to rank

- `analyseAccount` runs the agent tools as plain code before the model; with no card offered it returns fallback
  `nothing_to_rank` (no model call, no `llm_calls` row) and the UI badge says "Nothing for the AI to rank" instead of
  "AI unavailable". It still lists each agent's line under "What the agents checked". This replaces #130's model call
  for the same case (owner's choice, 14 Nov): a supply under 1% a year is no longer offered to the model either.

## 2026-11-14 — LP Optimizer on the wallet path: DCL re-centre (#63)

- `packages/rhea-dcl-adapter/src/recentre.ts`: `alignRange` (agent ticks → DCL points) and `recentreSwap` (surplus to
  swap for a range's ratio), on the contract's own deposit math.
- `apps/api/src/analytics/lp-recentre.ts`: `lpObservation` builds an `LpPositionView` per wallet DCL position
  (liquidity converted to CLMM units, market depth as segments, 24 h volume and gas in token Y); `recentreSteps`
  builds the cascade.
- `apps/api/src/analytics/discovery.ts`: `dclVolumes24hUsd` from Rhea's indexer.
- `ai-analysis.ts`: `lp_optimizer` tool replaces `liquidity_positions`; `account-view.ts`: `observe()` fills
  `market.lpPositions`, prepare intent `recentre_dcl`; `validate-cascade.ts`: DCL `add_liquidity` allowlist (D26).
- `apps/analytics`: "Prepare new range" button for `recentre_dcl`; the exit card reads as an exit.

## 2026-11-14 — Market Intelligence: 24 h volatility on the wallet path (#104)

- `apps/api/src/analytics/series.ts`: `range24hBps` — high-low range (bps) of an asset's per-snapshot consensus
  price; null under 12 snapshots.
- `apps/api/src/analytics/account-view.ts`: the wallet observation fills `volatility24hBps` for each priced held
  token from the collector's last 24 h of `price_observations`; a failed read leaves the token without a range.
- A range above 15% is a `volatility_spike` and the Market Intelligence trace line names it (D13 updated).

## #124 — Token logos and a deposit picker

- `packages/core/src/token-icon.ts`: `safeTokenIcon` (image data URIs only, 32 KB cap) (D27).
- `apps/api/src/analytics/token-icons.ts`: `TokenIcons` (ft_metadata.icon, bounded cache, NEAR logo for
  `near`/`wrap.near`) and `GET /v1/tokens/icons?ids=`; `/v1/deposit/assets` gives each token its `icon`; LP rows carry
  their `tokens`.
- `apps/analytics`: `TokenIcon` (img or letter placeholder, falls back on a load error) on holdings rows (two
  overlapping on LP rows), recommendation cards (the intent's tokens) and the deposit quote. The deposit form is now
  network chips + Send/Receive token buttons + a token picker inside the dialog (search, popular chips, arrow keys,
  Enter, Esc back).

## 2026-11-14 — Both paths rank idle tokens by dollars a year (#139)

- `packages/orchestrator/src/agents/capital-allocator.ts`: `proposeSupplies` proposes a supply for every idle
  allocation asset, the most dollars a year (value × Burrow rate) first; the decision engine still ranks by net benefit.
- `apps/api/src/analytics/ai-analysis.ts`: one supply candidate per idle token with its yearly earnings; the prompt
  says a pick that skips the top earner explains why in its "why".
- `apps/api/src/analytics/account-view.ts`: the rule-based idle card offers the top earner in dollars a year (not the
  largest balance) and names the runner-up's yearly earnings.

## 2026-11-14 — Ownership: a key read that could not run is not "not the owner" (#144)

- `apps/api/src/wallet/ownership.ts`: `verifyOwnership` rethrows an `RpcError` from the access-key read that is not
  the node's own answer (timeout, rate limit, HTTP error, node down); a missing or function-call key is still `false`.
- `apps/api/src/analytics/account-view.ts`: such a failure is logged (`ownership key read failed`, account and error
  text, never the proof); GET account answers `ownerVerified: false, ownerCheckFailed: true`, POST analysis 503.
- `apps/analytics`: a read with `ownerCheckFailed` is cached 1 s, not 60 s (it used to hold "not verified" under the
  new proof's key); `OwnershipCheck` says the check could not run, refreshes once after 2 s and offers "Check again".

## 2026-11-14 — Real activity on an events table (#32)

- `packages/db`: migration 0021 `events` (unique tx hash, 30-day purge in `analytics/main.ts`).
- `packages/near-adapter/src/tx-status.ts`: final transaction status by hash + signer (zod), tested on recorded
  mainnet answers (`test/fixtures/tx-*.json`: Burrow repay/supply, Rhea swaps, a failed oracle call, unknown hash).
- `apps/api/src/wallet/validate-cascade.ts`: per-rule checks and a summary; `wallet/seal.ts` stores every prepare's
  verdict; `wallet/outcome.ts` turns receipts' logs into "Repaid 5.01 USDC on Burrow" and, on failure, the contract,
  its error and the funds' fate; `wallet/confirm.ts` is `POST /v1/wallet/confirm` (D28).
- `apps/api/src/analytics/events.ts`: `POST /v1/events` (connect), `GET /v1/analytics/account/:id/events`, `GET
/v1/analytics/policy/cascades`; analyse, verified and 1Click quote writers. `/v1/analytics/agent-activity` removed.
- `apps/analytics`: `/api/events` and `/api/confirm` (JSON only, rate-limited); the sign dialog shows each step ⏳ → ✓/✗
  and stops after a failed one; Activity and /policy rebuilt on events; shadow-mode text removed from Home and
  Opportunities.
- Found on the way: Burrow's `oracle_call` failed with "Price oracle disabled" on mainnet on 13 Nov (autopilot-test.near).

## 2026-11-14 — "Nothing for the AI to rank" says why (#143)

- On top of #119 (no model call when nothing to rank): `nothing_to_rank` carries `note` = the proposing agents' own
  lines joined in order (no model text); the guardian's safe-loan line names the strategy ("Health factor 1.29; safe
  from 1.25 on Aggressive").
- `Recommendations.tsx`: the nothing-to-rank case keeps the "How the AI got here" timeline: wallet read (new
  `read` on the analysis, set without a model run), the agents, and a neutral "AI not asked" step carrying the "Why: …"
  line with a provenance tag; the generic "Nothing to improve right now" is gone for that case.
- #143's original goal (a `source: 'llm'` result) is superseded by #119's decision not to call the model at all.

## 2026-11-14 — 1Click deposit status polling with limits (#29)

- `OneClickDepositClient.status`: `GET /v0/status?depositAddress=…` (JWT if set), zod per field; an unknown status
  is `UNKNOWN`, a malformed amount, reason or tx hash is dropped; only a base58 NEAR tx hash is kept, 1Click's
  `explorerUrl` is never used (the UI links nearblocks.io itself).
- `GET /v1/deposit/status/:id`: our quote id → stored deposit address → 1Click; answers cached 5 s per quote in a
  `BoundedMap` (1000 quotes), concurrent callers share one call; `deadlinePassed` from the server clock. The latest
  status and its time go to `deposit_quotes.status` / `status_at` (migration 0022) when it changes.
- `apps/analytics`: `/api/deposit/status/[id]` proxy with its own `consume('deposit-status')` limit (60 per visitor,
  10 000 overall per 10 min); `poll()` takes a schedule (`everyMs` as a function of ticks done); the deposit dialog
  polls 5 s → ×1.5 → 30 s, at most 120 checks, stops at `SUCCESS`/`REFUNDED`/`FAILED` or, while `PENDING_DEPOSIT`,
  30 min after the deadline (a late deposit can take a confirmation to show up); `INCOMPLETE_DEPOSIT` keeps
  polling so the refund shows up. "Check again" starts a new round with an immediate check; a 1Click 404 for our
  address reads as `PENDING_DEPOSIT`; late responses never replace newer ones; the browser zod-checks the status.

## 2026-11-14 — A broken AI stream no longer starts a second run or spends a second token (#150)

- `analyseAccount`: runs still going live in `AnalysisMemo.running` by account + strategy, checked before the wallet
  read; a request for the same pair waits for that run and gets its result (also a fallback) instead of starting a
  model run of its own. The model part moved into `runModel` unchanged.
- `/api/analysis`: a paid stream request leaves one free JSON retry for the same visitor + account + strategy
  (within 2 min of the stream, `BoundedMap` of 10 000; the pass is dropped only when used), so the client's fallback after a broken stream costs no second visitor token.
- `runAnalysis`: an `error` frame returns its error (zod, ≤ 200 chars) instead of re-POSTing as JSON; only a stream
  that ends without a valid `done` falls back.
