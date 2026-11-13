# DECISIONS

_Architecture Decision Record (lightweight). Each entry: context → decision → consequences._

## D1 — Extend the existing architecture; do not rewrite from scratch

**Context:** 9 of the 13 target layers already have a real home (orchestrator with 4 agents, policy engine, adapters, risk, audit, idempotency). The brief forbids rewriting working architecture without evidence (§23).
**Decision:** Treat the transformation as extend/specialize/consolidate on top of the current monorepo; only the Guard contract is fully net-new.
**Consequences:** Lower regression risk, faster delivery, keeps `verify` green. Requires discipline to resist greenfield rewrites.

## D2 — Autonomy stays locked until a Guard contract exists and is independently reviewed

**Context:** Brief wants autonomous execution but also "SECURITY ALWAYS" and "no autonomous mainnet by default"; owner explicitly dropped _fully_ autonomous autopilot as unsafe/off-putting.
**Decision:** Autonomy ladder = Observe (now) → Approve (owner signs in wallet) → Autonomous (Guard-enforced, off by default, post-review). Autonomous mode is shown as locked/roadmap, never faked.
**Consequences:** Honest product; execution work (P6) is hard-gated on Guard (P5) + review.

## D3 — No fabricated intelligence

**Context:** No LLM is wired; heuristics only. UIs could imply model confidence that doesn't exist.
**Decision:** Never display fabricated AI confidence. If an `LlmClient` is added, it is an additional, schema-validated agent with heuristics as the safe fallback; disabled by default.
**Consequences:** Trustworthy UX; aligns with brief §21.

## D4 — System-wide data provenance tiers

**Context:** Brief §5/§16 require distinguishing verified on-chain facts from estimates/predictions.
**Decision:** Introduce a provenance enum in `core` and thread it through DTOs and UI; missing data returns explicit `unavailable|degraded`.
**Consequences:** Small cross-cutting change early (P1) that many later features depend on.

## D5 — Keep the dry-run / `loadSigner()=null` invariant on `main`/`fix/audit`

**Context:** It is the backbone safety property.
**Decision:** No change to this on shared branches; any signing lands behind review on gated branches/flags.
**Consequences:** Shared branches remain safe to deploy (e.g. public demo).

## D6 — Target architecture confirmed from the master brief

**Context:** The planner's Claude Docs document never shipped; the owner supplied the full master prompt directly.
**Decision:** Use the master brief (§4 thirteen layers) as the authoritative target. (Superseded by `REWORK_PLAN.md` and `HACKATHON_PLAN.md`.)
**Consequences:** No further blocking on an external doc; proceed through the roadmap.

## D7 — Mainnet only; DB names kept as history

**Context:** Testnet code paths (`NEAR_NETWORK=testnet`, `MARKET_DATA=mainnet-reference`, `YIELD_DATA=testnet-onchain`,
testnet deployments in the adapters) made the code and the README tell different stories (#12).
**Decision:** The env schema accepts only `NEAR_NETWORK=mainnet`, `MARKET_DATA=none|mainnet-live`,
`YIELD_DATA=none|mainnet-onchain`. The database is not migrated: the `testnet_transactions` table, the `testnet_token`
column and the CHECK constraints that still allow `'testnet'` stay as history; only the TypeScript field is renamed
(`token`). Reads are filtered to the deployment's own provenance, which is mainnet.
**Consequences:** No migration risk on the VPS. `packages/db/src/schema.ts` and the migrations keep the word
"testnet". `EXECUTION_MODE=live` is now always refused; its removal belongs to #13.

## D8 — Remove the autopilot; keep the collector's agents

**Context:** The autopilot layer (its HTTP API with `/v1/runs` and `/v1/requests`, `signer.ts`, the operator controls
`/v1/control/*`, `apps/dashboard`, `PUBLIC_DEMO`) described a product that signs on its own. The rework
(`REWORK_PLAN.md`) is an analyst: the user signs every transaction in their own wallet (#13).
**Decision:** Delete the autopilot API process, the server signer extension point, the operator controls (pause,
read-only mode, "run now", the `/autopilot` page, "Refresh with live data", "Reset demo"), `apps/dashboard` and
`PUBLIC_DEMO`. Keep the collector and its orchestrated cycle on the two simulated demo portfolios (dry-run, Shadow
Gateway quotes, policy verdicts); its agents become LLM tools in #18. The collector's allowlists and limits move to
`config/market.json` (`MARKET_CONFIG_FILE`, zod schema in `apps/api/src/market-config.ts`). `analytics-api` now applies
the migrations. The account-lookup rate limit no longer depends on a flag: it is always on.
**Consequences:** No process can sign, and no HTTP route changes the system state except building an unsigned cascade.
The `collector_control` and orchestrator mode tables stay in the database, unused by the UI. The legacy engine
(`AUTOPILOT_ENGINE=legacy`) stays in code for tests; nothing deployed runs it.

## D9 — Wallet signing on the public site, caps unchanged

**Context:** With `PUBLIC_DEMO` gone, signing is controlled only by `MAINNET_WALLET_SIGNING` (`HACKATHON_PLAN.md`,
Signing).
**Decision:** `deploy/public/docker-compose.yml` sets `MAINNET_WALLET_SIGNING: '1'` (fixed, not read from `.env`). The
cascade caps in `apps/api/src/wallet/validate-cascade.ts` stay as they are: 0.15 NEAR per action, 0.3 NEAR per
cascade, plus the signer, receiver and method allowlists and the gas cap.
**Consequences:** A visitor can sign a validated cascade for their own account in their own wallet. The server still
holds no key. Raising a cap needs a new entry here.

## D10 — Rate limits on the public site and the account read cache

**Context:** The public site reads any mainnet account a visitor types ("Your account") and builds unsigned cascades
(`/api/prepare`) without sign-in. Each account read is dozens of RPC calls through our FastNEAR key, which the
collector shares. Without a limit one script can use up the key's quota (the demo portfolios then go stale too), load
the small server, or get the server's IP blocked by the RPC provider. An idle "Your account" tab used to hit its own
limit in about 7 minutes, because the 15 s auto-refresh re-read the account on every tick (#52).
**Decision:**

- Limits (`apps/analytics/lib/rate-limit.ts`, sliding 10-minute window, in memory): account reads 30 per visitor and
  600 for all visitors; `/api/prepare` the same, plus `content-type: application/json` only. The visitor is the client
  IP that Caddy sets in `X-Forwarded-For` (`deploy/public/Caddyfile`), never a header the client sends.
- An account read is cached per visitor (IP + account id) for 60 s from when the data arrives
  (`apps/analytics/lib/product.ts`). Re-renders and the auto-refresh reuse it; only a real read spends the limit.
  Concurrent renders share one read; failed reads are not cached.
- After a new transaction from the wallet (`AccountWatcher`, `PrepareDialog`) the `refreshAccount` server action drops
  the caller's own cached read, so the page shows the new state at once. Another visitor cannot drop it. It also
  skips the API cache (D20).
- The 15 s auto-refresh stays on every page, so prices and the health factor keep updating (at most once a minute
  on the account view).
- `MAINNET_READ_RPC_URL` must be the FastNEAR URL whenever `MAINNET_READ_RPC_API_KEY` is set; the public NEAR RPC
  ignores the key and answers 429 under load.
- The live demo uses FastNEAR's free key, not a paid plan (owner, 12 Nov, #41): the limits above and the 60 s cache
  keep our load small; a paid plan is the fallback if the live 429 check fails.
  **Consequences:** An open account tab spends about 10 of its 30 reads per 10 minutes. Changes made without a
  transaction from the wallet (prices, incoming transfers) show within about 75 s. Limits and the cache live in one
  Next.js process: a restart resets them, and several instances would need a shared store. Raising a limit or the TTL
  needs a new entry here.

## D11 — Nonce CSP and public error texts

**Context:** Security item 6 (`HACKATHON_PLAN.md`): strict CSP, generic error messages.
**Decision:** Scripts run only with the per-response nonce (`'strict-dynamic'`); `connect-src`, `frame-src` and
`img-src` allow any `https:` because wallets in HOT Connector's iframe inherit the policy and call their own backends.
Errors: invalid input (zod, Fastify's own 4xx) is a 400 with its reason; a prepare our code refuses (`RangeError`,
`MissingPriceError`, `PreconditionError`, `UnsupportedIntentError`) is a 422 with its reason; everything else is a
bare 500/502, details only in the log. Stored reasons are fixed phrases too: collector, route and price failures are
written as `<kind>` (`RpcError` / `MarketHttpError` kind, HTTP status, else `unknown error`) and served through
`apps/api/src/public-text.ts`, which also cleans rows written before (#48).
**Consequences:** Every page renders dynamically (nonce). A new inline script needs the nonce from `headers()`.

## D12 — NEP-413 ownership proof gates the LLM analysis

**Context:** Security item 2 (`HACKATHON_PLAN.md`): LLM runs cost money, and connecting a wallet proves nothing (the
site only learns an account name).
**Decision:** The wallet signs a fixed NEP-413 message (`packages/core/src/ownership.ts`, recipient
`near-autopilot.tech`). The nonce holds the signing time; the server accepts it for 24 h (5 min clock skew), with no
challenge and no stored state. The signing key must be a **full-access** key of the account (`view_access_key`):
function-call keys are often held by dApps, so they do not count. The proof lives in an HttpOnly cookie (`np_owner`, 24 h),
the UI server forwards it as `x-ownership-proof`, and `GET /v1/analytics/account/:id` returns `ownerVerified`,
verified per request outside the account cache (a positive result is kept 60 s). Any failure, including a failed RPC read, means false (heuristics).
**Consequences:** A stolen proof can be replayed for 24 h, but only for the same account under the same rate limits.
The LLM path (#18) runs only when `ownerVerified` is true. A shorter TTL or a server challenge needs a new entry here.

## D13 — Central LLM on the wallet path (architecture C)

**Context:** #18. The plan has the central LLM call the existing orchestrator agents as tools. On a wallet, the Capital
Allocator and LP Optimizer had no inputs, and the concentration and DCL checks exist only in the wallet code.
**Decision:**

- Tools: `LiquidationGuardianAgent`, `CapitalAllocatorAgent` (`supplyIdle`, every Burrow token with an oracle price)
  and `MarketIntelligenceAgent`, run on a fresh Burrow snapshot of the tokens the wallet holds (`SnapshotService`),
  priced with the collector's confirmed prices, the same ones the portfolio table uses. `priceoracle.near` returned no
  recent price on 11 Nov 2026, so it is only Market Intelligence's second source (empty when it has none). Yields
  are today's Burrow supply rates; there is no 24 h volatility on this path. Plus three
  wallet checks: concentration, DCL out of range and Burrow withdrawals (#64). The LP Optimizer waits for a 24 h volume source (separate issue).
- Only `lending.repay` (guardian) and `lending.supply` (allocator) worth at least $1 become recommendations; the
  repay text states the health factor the repayment actually reaches. When the account view's loan card repays from
  collateral (the wallet cannot reach the target), the guardian tool returns that card instead of the agent's wallet
  repay, so the AI path never offers a repay the wallet cannot pay (#64). Repayments are sized to HF 1.6, never the
  whole debt by default; the user can pick another amount. Allocator swaps (they would
  move the whole wallet into the highest-yield token) and collateral top-ups (prepare's supply is not collateral) are
  dropped.
- The LLM returns only `{picks: [{id, why}]}` (zod). Unknown ids are dropped; a "why" with a number that neither its own
  card nor the tools' shared context (health factor, notes, signals) shows in a readable field (not ids or raw
  amounts) is replaced by the code's text. Non-ASCII numerals ("１", "½"), magnitude words ("thousand") and a sign
  count as numbers too. Every warning kind the model left out (a loan warning above all) is put back first. At most
  6 model turns (one per tool if it does not call them in parallel), at most 10 tool calls per turn, 45 s for the
  whole analysis including the wallet read; on the deadline the model call in flight is aborted. An empty ranking or any failure returns the rule-based list, labelled.
- `POST /v1/wallet/prepare` accepts an optional exact `amount` (base units) for repay and supply, capped at the
  wallet balance. Cascade caps and `validateCascade` are unchanged.
- The test that banned LLM code from `apps/api/src/analytics` now allows the provider only in `analytics/main.ts`
  (wiring); the collector stays LLM-free, and the no-signing/no-sending ban is unchanged.
- The Next route allows 5 analyses per visitor per 10 minutes (it alone knows the visitor) and 600 overall, the
  account-read guard for the RPC reads. The global AI limit lives in
  the analytics API (#22): at most 60 runs that reach the model per 10 minutes for everyone; over it the owner gets the
  rule-based list with fallback `busy`. Rule-based answers (no proof, LLM off, cap) and cache hits never count.
- AI results are cached in the analytics API for 10 minutes, at most 200 entries (`BoundedMap`, in memory): key =
  sha256 of the observation the agents get (dates dropped, maps sorted), the rule-based list and the strategy preset
  (`default` until #25). Only `source: 'llm'` results are cached; a hit makes no model call and writes no `llm_calls`
  row, and is only served after the ownership check. A hit still costs the snapshot read. Amounts, prices and rates
  count by their 4 leading digits, so interest accrued between two clicks still hits; a cached repay amount can then
  be up to ~0.1% short of the debt (a little dust left), accepted.
- Only the proven owner (D12) gets a model call: without a valid `x-ownership-proof` the endpoint returns the rule-based list with "Verify ownership…". `ANTHROPIC_API_KEY` stays off the public server until #21 (spend cap) is merged.
  **Consequences:** An analysis costs one snapshot read (about 2 RPC calls per Burrow token) plus up to 6 model calls (`MAX_TURNS`).
  With the key unset the route is free and returns the rule-based list.

## D14 — LLM spend cap, model allowlist, 7-day call log

**Context:** #21. The Anthropic key may go on the public server only once spend is recorded and capped. D13's tool loop
makes up to 6 model calls per analysis (`MAX_TURNS`).
**Decision:**

- `ANTHROPIC_MODEL` is an allowlist: `claude-haiku-5-5` or `claude-sonnet-5-5`, each with a list price in
  `apps/api/src/llm/pricing.ts` (Haiku $0.10/$0.50 per MTok, $0.50/$2.50 above a 100K-token prompt; Sonnet $2/$10).
  Anything else fails the analytics API at start.
- Daily cap per UTC day: the `llm_settings` row (#31's admin field) when set, else `LLM_DAILY_CAP_USD`, default $5.
  Before each model call: spent today + this run so far + one worst-case call (100K input, `ANTHROPIC_MAX_TOKENS`
  output) must fit, else no call and fallback code `cap`. A request whose input could go over 100K tokens (Haiku's
  long-context rate) is never sent: the bound is the last reply's input + output tokens + the UTF-8 bytes of the new
  tool results + 2K overhead; over it, fallback `loop_limit` (#85).
- In the analytics API's memory (one process), each model call in flight holds one worst-case call, taken before the
  budget is read, and a run holds its actual spend until its row is written; parallel analyses therefore cannot all
  pass the same check (near the cap both may stop: fail closed). A run whose row fails to write keeps its cost held
  for that UTC day. An unreadable budget counts as spent (`cap`). The row is stamped with the time the run ends.
- Usage comes from every reply through `ToolLlm.open({ onUsage })`, before the reply is checked, so a billed
  `max_tokens` or `refusal` reply is counted. SDK `maxRetries: 0`, so no billed retry goes unseen. A call aborted on
  the deadline or cut by a dropped connection may still be billed but returns no usage, so it is recorded at one
  worst-case call (#85).
- `llm_calls`: one row per analysis that reached the model, numbers only (account id, model, tokens, cost in
  micro-USD, latency, tools, outcome code); no IP, no visitor key, no model or tool text. Deleted after 7 days by the
  analytics API (on start, then hourly).
- Fallback codes (`off`, `kill_switch` and `not_owner` never reach the model, so never in `llm_calls`): `off`, `kill_switch` (D16), `not_owner`, `cap`, `model_error`, `invalid_output` (bad JSON or schema), `empty`,
  `deadline`, `loop_limit` (too many turns or tool calls).

## D15 — Leaked secrets are rotated, history is not rewritten

**Context:** #45. The repo goes public for the judges. A real FastNEAR key was committed to `.env.example` in
`ed756ee` and blanked in #47.
**Decision:**

- Rotate every real leak at its provider; no history rewrite. Once public, forks, clones and GitHub's
  `refs/pull/*` keep old commits anyway, so a rewrite does not unpublish anything, and it breaks every open
  branch and worktree four days before the deadline. A rotated key is worthless whatever history shows.
- CI job `secrets` runs gitleaks 8.30.1 (pinned, checksum-checked binary) over the full history of the checked-out commit on every PR and every push to `main`.
  False positives go to `.gitleaks.toml` (public NEAR token ids, a test key) with a reason; a rotated leak goes to
  `.gitleaksignore` by fingerprint.
- `near-dapp` and `near-intents` (from `near/agent-skills`, no licence) are no longer committed; `.claude/skills/README.md`
  says how to install them. The other third-party skills keep their licences next to them.
  **Consequences:** The old FastNEAR key stays readable in history and must be dead before the repo goes public
  (owner step on #45). A new real finding turns CI red until it is rotated and listed.

## D16 — Admin: own token, loopback-only service, Caddy 404

**Context:** #31. With the LLM key on the public server the owner needs AI spend and a kill switch without a deploy,
and a break-in to the public site container must not be able to change them.
**Decision:**

- `/v1/admin/*` (`apps/api/src/analytics/admin.ts`) accepts only `ADMIN_API_TOKEN`; `API_TOKEN` gets 401 there and
  `ADMIN_API_TOKEN` gets 401 everywhere else. No admin token configured = every admin URL answers 401. The API refuses
  to start when both tokens are equal.
- The admin UI is the same Next image as the site with `ADMIN_UI=1` (service `analytics-admin`, `127.0.0.1:3003` on the server, 3002 locally,
  no Caddy route), opened through an SSH tunnel. Without `ADMIN_UI=1`, `/admin` and the admin server actions answer
  404 and never call the API. The public `analytics` container has no `ADMIN_API_TOKEN`. Caddy answers 404 for
  `/admin` and `/admin/*` before proxying.
- Kill switch, daily cap and the deposit balance the owner types in live on the single `llm_settings` row (migration
  0019). The switch is read before the result cache on every analysis, so off means no model call and no cached AI
  result (fallback code `kill_switch`); an unreadable switch counts as off. No confirm step: it is reversible.
- Writes are zod-checked JSON: cap $0.01–$1000 per day, deposit $0.01–$1M.
- Run-out estimate = (deposit − spend since it was entered) / 7-day daily average. Spend older than 7 days is purged,
  so the screen asks to re-enter a balance older than 7 days.
  **Consequences:** anyone with SSH to the server can open the admin; there is no login. Screens 2–4 (#33, #34) reuse
  the token and service.

## D17 — Haiku 5.5 at its default effort stays the analysis model

**Context:** #16. Haiku 5.5 was the default by guess. Measured on the real tool-use loop (`analyseAccount`, code
computes numbers, the model orders and explains) with `pnpm --filter @near-autopilot/api llm:compare`, 13 Nov 2026,
3 runs per config on two mainnet wallets: `autopilot-test.near` (Burrow loan, HF 1.28, idle USDt) and the public
`hodl13.near` (4 in-range Rhea DCL positions, 99% NEAR). Cost at list prices ($0.10/$0.50 Haiku, $2/$10 Sonnet per
1M tokens); every run took 2 model turns and about 2.9K input tokens; total spend $0.11.

| Wallet              | Config             | $ / analysis | p50 latency | AI answer, no fallback | "why" replaced | Loan warning first |
| ------------------- | ------------------ | ------------ | ----------- | ---------------------- | -------------- | ------------------ |
| autopilot-test.near | Haiku 5.5 (medium) | $0.0006      | 4.4 s       | 3/3                    | 0              | 3/3                |
| autopilot-test.near | Sonnet 5.5 `low`   | $0.0089      | 3.9 s       | 3/3                    | 0              | 3/3                |
| autopilot-test.near | Sonnet 5.5 (high)  | $0.0100      | 5.3 s       | 3/3                    | 0              | 3/3                |
| hodl13.near         | Haiku 5.5 (medium) | $0.0005      | 2.6 s       | 3/3                    | 0              | n/a                |
| hodl13.near         | Sonnet 5.5 `low`   | $0.0078      | 3.4 s       | 3/3                    | 0              | n/a                |
| hodl13.near         | Sonnet 5.5 (high)  | $0.0082      | 3.9 s       | 3/3                    | 0              | n/a                |

Ranking: every config put the loan first and said the same thing with the same numbers ("health factor 1.28 … repay
about $11 of USDC"; "99% in NEAR … swap about $31"). The one difference: Haiku left out the $5 idle-USDt supply card
(about 10% a year) on all 3 runs, Sonnet `low` kept it on 3/3, Sonnet high on 1/3. Raw picks are on #16.
**Decision:** keep `claude-haiku-5-5` at its default effort (`medium`). It is as valid and as safe (loan first, no
"why" rejected by the numbers check) at 1/15 the cost, so the $20 deposit lasts about 35K analyses instead of 2K.
The adapter takes an optional effort (used by the comparison); no env setting is added since the default wins.
**Consequences:** the AI list may leave out small idle-balance cards (info only; warnings are put back by code). Revisit
with `llm:compare` if the prompt or tools change; a Sonnet → Haiku fallback step is not needed.

## D18 — The account view reads indexers for discovery and prices unlisted tokens as estimates

**Context:** #73. The NEAR RPC has no "list tokens" or "list pools of an account" call, so the account view only read
allowlisted tokens and pools and showed `npro-validator.near` (about $335k) as $2.
**Decision:**

- Three new read-only external endpoints, all through `apps/api/src/analytics/discovery.ts`: FastNEAR
  `api.fastnear.com/v1/account/{id}/full` (tokens and staking pools, no key), `api.ref.finance/liquidity-pools/{id}`
  (Rhea v1 pool ids; `indexer.ref.finance/liquidity-pools` returns `[]` and is not used) and
  `indexer.ref.finance/list-token-price` (prices, cached 5 minutes). Every answer is zod-checked, capped (4 MB, 60
  tokens, 5 staking pools, 20 pools, 5 s timeout) and treated as a hint: pool shares and staked balances are read
  on-chain, token metadata via `ft_metadata`.
- "Verified" = listed by Burrow or named in our own label list (`apps/api/src/thesis/labels.ts`). Anything else is
  display-only: symbol sanitised to `[A-Za-z0-9._-]{1,12}`, marked "Unverified", never in an action, a
  recommendation or the agents' observation (#19). Swapping such tokens is #90. Wallet balances of tokens outside
  Burrow's list come from FastNEAR as is (at most 30 per account, priced ones first).
- An unlisted token's price is Rhea's indexer price, tagged "price estimate"; it counts in the totals and allocation.
  A collector-confirmed price always wins, and actions and `prepare` only ever use confirmed prices.
  **Consequences:** A thin pool can give a meme token an inflated estimate, so the total can overstate such an
  account; the "Unverified · price estimate" label is the guard. An indexer outage shows a notice and the allowlisted
  view. A read makes up to 3 more HTTP calls and a bounded number of view calls; the 60 s cache (D10) is unchanged.

## D19 — Deposits from another chain: real 1Click quotes, verified on the server, no NEAR transaction

**Context:** #27 (security items 4 and 5 of HACKATHON_PLAN). A user with funds on Ethereum, Base, Arbitrum, Solana or
Bitcoin should be able to fund their NEAR account from the site. A real 1Click quote returns a deposit address that
receives real money.
**Decision:**

- A separate client (`apps/api/src/gateway/one-click-deposit.ts`) posts `dry: false` quotes to the hard-coded
  `https://1click.chaindefuser.com`; it never reads `ONE_CLICK_URL`. The dry client (`one-click.ts`) is unchanged. No
  retries: every real quote mints a new address and the user must see exactly one.
- Origin tokens: every `/v0/tokens` entry on `eth`, `base`, `arb`, `sol`, `btc` (zod-parsed, cached 10 minutes; asset
  ids and decimals taken from that list, never built by hand). No memo chains. Destination: a token from
  `config/market.json` `policy.allowedTokens` (wNEAR, USDC, USDT), never user input; recipient = the connected
  account, delivered to the NEAR chain.
- The refund address is checked on the server before 1Click is called: EVM `0x` + 40 hex (EIP-55 when mixed case);
  Solana base58 decoding to 32 bytes; Bitcoin mainnet base58check P2PKH/P2SH, bech32 v0 (20/32 bytes) or bech32m v1
  taproot (32 bytes), with checksum (`@scure/base`). Burn addresses (zero EVM address, all-zero Solana key) and
  witness versions that are not spendable today are refused.
- The answer is zod-parsed and verified: `dry: false`, `EXACT_INPUT`, `ORIGIN_CHAIN` deposit and refund,
  `DESTINATION_CHAIN` recipient, `originAsset`, `destinationAsset`, `amount`, `quote.amountIn`, `recipient`,
  `refundTo`, `slippageTolerance`; `amountOut` above 0 and `minAmountOut` within the 1% slippage; fees at most 1%; no
  `customRecipientMsg` or virtual-chain recipient; a deposit address that is a valid address of the origin chain; no
  memo; a deadline in the next 7 days. Any mismatch: no address is shown, a generic error, the reason logged.
- Stored in `deposit_quotes` (migration 0020) with our id, deleted after 30 days. The UI gets our id and read-only
  fields.
- Gate: a connected account plus the proxy limit (5 quotes per visitor, 100 overall per 10 minutes), no NEP-413
  proof. A quote costs nothing; someone naming another account as recipient only sends their own money there.
- `ONE_CLICK_JWT` is optional, only in the `analytics-api` service, sent as `Authorization: Bearer` to 1Click only,
  never logged or returned. The fee shown is the sum 1Click echoes in `quoteRequest.appFees` of that quote (a live
  keyless USDC→USDC quote echoed 1 bp, not the 25 bps of the published table), tagged protocol-reported; "not
  reported" when it echoes none. It is already taken off `amountOut`.
- QR: `qrcode-generator` (MIT, no dependencies) drawn as inline SVG; no external QR service.
- No NEAR transaction is built, so `validateCascade` and its allowlists are untouched.
  **Consequences:** 1Click sets the deadline itself (a live quote gave about 3 days, not the 10 minutes we ask for);
  the page counts down from the server's seconds-left. Status tracking is #29. The analytics API now makes outbound calls to 1Click and writes rows.

## D20 — A fresh account read after a transaction

**Context:** #65. After signing, the portfolio caught up only after 2–3 minutes: `refreshAccount` dropped the UI's
cached read, but the API kept its own 60 s cache per account (D10), and the watcher refreshed once, at `optimistic`
finality, before the new state was readable.
**Decision:**

- `GET /v1/analytics/account/:id?fresh=1` replaces the API's cached read for that account, at most once per account
  every 5 s; any other request in that gap gets the cache as before. The ownership cache is untouched.
- Only the `refreshAccount` server action asks for it (after a signed cascade in `PrepareDialog`, or a nonce bump in
  `AccountWatcher`). Each fresh read is a normal account read: it spends one of the visitor's 30 reads (D10).
- The page retries up to 4 reads, 5 s apart (`apps/analytics/lib/portfolio-refresh.ts`), until the holdings differ
  from the visitor's last read (holding and position amounts to 4 significant digits, so Burrow interest and gas do
  not count as a change), and shows "Transaction seen, updating your portfolio…" meanwhile. One refresh per account
  at a time.
- Next bundles server actions apart from page rendering, each with its own copy of a module, so the account read
  cache and the rate-limit counters live once per process (`apps/analytics/lib/process-state.ts`). Before this, the
  action dropped and refilled a cache the page never read, and its reads had a limit of their own.
  **Consequences:** A signed transaction costs up to 4 account reads; a visitor looping the action spends their own
  limit, and the API reads one account at most every 5 s past its cache. A transaction that changes no holding (only
  one below 4 significant digits) shows the note for the full ~15 s.

## D21 — One-click actions start at $1

**Context:** #120. #99 set a $10 minimum per card to stop "$0" actions; it hid every card on wallets under ~$20,
the size a judge's test wallet usually is.
**Decision:** `MIN_ACTION_USD` is $1 for rule-based cards and agent-sized deposits. Rebalances and idle assets under
$1 are listed as skipped with a reason (idle ones from $0.10; less is dust and says nothing). A loan repay is at least
$1 and at most the debt.
**Consequences:** A $1–10 action costs a fraction of a cent in gas on NEAR, so it is still worth signing; the prepare
caps and cascade validation are unchanged.

## D22 — Three strategy presets on "Your account"

**Context:** #25. One fixed risk line (HF 1.5, concentration 60%) treated a cautious holder and a looper the same.
**Decision:**

- One table, `packages/core/src/strategy.ts`; Balanced keeps the numbers used before presets. Numbers agreed with the
  DeFi teammate on 13 Nov:

  | Strategy     | Safe from HF | Repay to HF | Urgent below HF | Concentration card / urgent / swap to |
  | ------------ | ------------ | ----------- | --------------- | ------------------------------------- |
  | Conservative | 1.80         | 2.00        | 1.50            | 50% / 75% / 40%                       |
  | Balanced     | 1.50         | 1.60        | 1.30            | 60% / 85% / 50%                       |
  | Aggressive   | 1.25         | 1.35        | 1.15            | 75% / 95% / 65%                       |

- Concentration counts non-stable tokens only (the stablecoin list in `apps/api/src/thesis/labels.ts`).
- The rule-based repay (from the wallet or the collateral, #64) is sized to the preset's target HF, and the
  withdraw card keeps the HF at that target. The guardian's `watchBelowBps` and `targetHealthFactorBps` follow the preset; the danger (1.1) and
  critical (1.05) lines stay the agents' defaults. The loop comparison keeps HF 1.6.
- The API caches the wallet read without the preset and computes the cards and the loan label per request; the UI
  account cache and the AI analysis cache key include it. Unknown preset → 400, missing → Balanced.
- The choice lives in the URL and one cookie in this browser that remembers the last 20 accounts (quick hackathon solution; #100 moves it to a
  server-side setting written by the proven owner).
- When all three presets give the same cards and loan label on an account, the API returns `strategyNote`, one
  sentence on why (no loan, the largest non-stablecoin's share), shown under the picker.
  **Consequences:** A shared link shows its own strategy; on another browser the last choice is not restored.

## D23 — An idle-token supply is not capped at the swap size limit

**Context:** #131. On a wallet with $507 of idle USDC the rule-based card supplied all of it, while the AI path's
Capital Allocator capped the deposit at `swap.maxSwapUsd` ($100, the old autopilot's per-trade cap) and the card then
called $100 "your idle USDC". The decision engine also rejected a larger supply as `EXCEEDS_ORCHESTRATOR_LIMIT`.
**Decision:** `lending.supply` deposits the whole held balance of the chosen token; `maxSwapUsd` limits swaps only
(agent and decision engine). A supply is not a trade (no price, no slippage), it can be withdrawn any time, and the
user signs it. The policy engine's `maxActionUsd` on the dry-run autopilot path, the prepare caps and `validateCascade`
are unchanged.
**Consequences:** The AI and rule-based idle-supply cards name the same amount for the same token. Only the AI path
turns `supplyIdle` on; if the dry-run autopilot ever does, a supply above the policy's `maxActionUsd` is rejected
(fail-closed) instead of scaled down. The two paths can still pick different tokens when several are idle (#139).
