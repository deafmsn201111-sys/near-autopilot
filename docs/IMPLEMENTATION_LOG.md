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
  after 30 minutes (a reload starts them again). 1Click status polling limits are in #29.
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
