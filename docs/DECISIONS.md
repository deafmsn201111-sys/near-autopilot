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
holds no key. Raising a cap needs a new entry here. The local `docker-compose.yml` defaults to signing on too
(`${MAINNET_WALLET_SIGNING-1}`, `.env.example` sets `1`; an empty value in `.env` keeps it off), with the same caps.

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
  are today's Burrow supply rates. 24 h volatility is the high-low range of the collector's own stored consensus
  prices (at least 12 snapshots spanning 12 h; #104), taken over a rolling median of five snapshots so one or two
  bad prints drop out while a move that holds 45 min counts (#159). Plus three
  wallet checks: concentration and Burrow withdrawals (#64), and the `LpOptimizerAgent` on the wallet's DCL
  positions (D26, #63).
- Only `lending.repay` (guardian) and `lending.supply` (allocator) worth at least $1 become recommendations; the
  repay text states the health factor the repayment actually reaches. When the account view's loan card repays from
  collateral (the wallet cannot reach the target), the guardian tool returns that card instead of the agent's wallet
  repay, so the AI path never offers a repay the wallet cannot pay (#64). The same holds for the card that withdraws
  another collateral token, swaps it and repays (D25, #69). Repayments are sized to HF 1.6, never the
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
- Fallback codes (`off`, `kill_switch`, `not_owner`, `busy` and `nothing_to_rank` never reach the model, so never in `llm_calls`): `off`, `kill_switch` (D16), `not_owner`, `cap`, `model_error`, `invalid_output` (bad JSON or schema), `empty`,
  `nothing_to_rank` (the agent tools, run as code first, offered no card), `deadline`, `cancelled` (the visitor
  left; #151), `loop_limit` (too many turns or tool calls). A cancelled run keeps its slot in the global run limit: it
  already reached the model, and freeing it would let open-and-close bypass the limit. A run stops 2 s after its last caller
  left with no one joining, so a broken stream's JSON retry (#150) still joins the same run.

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
  **Amendment (#160):** a swap's output lands a few blocks after its input leaves, so the first changed read can show
  only the debit. The refresh now reads up to 6 times, 5 s apart, and stops at the first read after a change that
  shows nothing new, or on a failed read (`refreshAccount` returns null); a signed transaction costs up to 6 reads,
  usually 3. A credit landing more than 5 s after the debit still needs a reload.
  **Amendment (#117):** the watcher reads the native balance (`view_account`, still one RPC call per 6 s tick)
  instead of the access-key nonces, so an incoming NEAR transfer triggers the same refresh; an own transaction moves
  the balance too. Answers from an older block are dropped. Like the holdings check, it compares the balance at 4
  significant digits, so gas refunds, dust and a contract's gas rewards do not trigger it. It stays quiet while a
  refresh runs and for 10 s after one ends, so the refresh started after signing is not followed by a second one.
  Not watched, shown only on a reload after the cache expires: incoming fungible tokens (no cheap per-account signal),
  a balance move below 4 significant digits, a transfer in the 10 s quiet window, and one that landed before the page
  mounted while its render came from the cache.

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
(fail-closed) instead of scaled down. When several tokens are idle, both paths rank them by dollars a year at the live
Burrow rate, each at least $1 and 1% a year (#139): the rule-based card offers the top earner and names the runner-up;
the AI path gets every such token as a candidate (at most 8) and the model may rank another first, saying why.

## D24 — The AI pipeline streams over Server-Sent Events through the site proxy

**Context:** #113. The AI analysis takes several seconds and its pipeline appeared only at the end.
**Decision:** The same `POST /v1/analytics/account/:id/analysis` answers `text/event-stream` when the request asks
for it (`Accept`), else JSON as before. Events: `read`, `asked` (the agents the model chose to call, before they
run), `agent` (one per offered tool, in tool-result order, the server-built trace line without its pick; sent again
if a failed agent later succeeds), `ranked`, `checked`, `done` (the full analysis), `error`. A reused result carries
`cachedAt`, shown as "from a run N min ago" so it is never mistaken for a live run. Account and
strategy errors are still plain JSON with their status, before any event. Ownership, kill switch, cache, daily cap,
global limit and the 45 s deadline are the same code path. The Next.js route passes the body through with
`cache-control: no-cache, no-transform` and `x-accel-buffering: no`; Caddy's `reverse_proxy` has
`flush_interval -1`. SSE over a POST `fetch` stream rather than `EventSource` (GET only, no body, no custom headers).
**Consequences:** If a stream breaks before `done`, the browser repeats the request as JSON, which may make a second
model call (it counts against the same limits). A client that leaves keeps the server run going; its result is cached.

## D25 — Repay a loan with another collateral token (withdraw → swap → repay)

**Context:** #69. wNEAR collateral, USDC debt and no USDC in the wallet left the guardian without a button. The first
step (withdraw) lowers the health factor, and the user may stop after any step.
**Decision:** (grill, 13 Nov)

- The loan card offers `repay_with_collateral` when the wallet cannot cover the repay and no collateral is the debt
  token: the largest Burrow collateral token with an allowlisted Rhea v1 pool to the debt token. It swaps the
  collateral token already in the wallet first and withdraws only the rest, so a run stopped after step 1 comes back
  as swap → repay on the next read (no separate "continue").
- Floor: the health factor after the withdraw (and the swap, which does not touch Burrow) stays at or above **1.15**,
  the agents' danger line (1.10) plus 0.05 for prices moving between the steps. If no withdrawal keeps it there, the
  card has no button and says why. The swap is sized to reach the preset's target HF, or the most the floor allows;
  the card plans 0.02 above the floor so a small price tick before the click does not make prepare refuse it.
- The card sizes from a live Rhea quote at 0.5% slippage; prepare re-reads the account, re-quotes, sizes the repay
  from the swap's minimum output plus the debt token already in the wallet (capped at the debt + 0.1%), refuses a
  withdrawal that breaks the floor at the fresh read (409), and writes the HF after each step into the preview.
- Separate transactions signed in order (register on a token if needed, Burrow `oracle_call` withdraw, Rhea swap,
  Burrow repay). No new method, receiver or cap: `validateCascade` allows the oracle, Burrow, Rhea and the two tokens.
- No amount picker on this card; the AI path gets the same card from the guardian tool (no new orchestrator proposal
  kind).
- Not for a wNEAR debt: Rhea may pay a swap into wNEAR out as native NEAR, and the repay step needs the token. The
  candidate token may sit on Burrow or only in the wallet; the quote runs only when the wallet cannot repay to the
  strictest preset's target.
  **Consequences:** one extra Rhea quote per account read, only for a loan under the strictest preset's safe line with
  no same-token collateral. Prices can still move between the steps; the floor is the margin.

## D26 — The LP Optimizer re-centres an out-of-range DCL position (#63)

**Context:** An out-of-range DCL position earns nothing, and the only offer was the exit to the wallet.
**Decision:** The `lp_optimizer` tool replaces the `liquidity_positions` wallet check and runs `LpOptimizerAgent` on
every wallet DCL position in an allowlisted pool.

- **24 h volume:** Rhea's indexer `list-pools?type=dcl&sort=tvl&limit=100` (`volume_24h`, USD), zod-parsed, cached
  5 min, converted to the pool's token Y at the confirmed price. A pool with no row, or an indexer error, gives the
  agent no view of that position (`insufficient_data`), never a guessed number. Chosen over two of our own on-chain
  readings 24 h apart, which a fresh deploy or a local run does not have.
- **Units:** DCL liquidity counts Y per point; the CLMM formulas count per unit of sqrt price. Every DCL liquidity
  (position, pool, market depth) is multiplied by `1 / (sqrt(1.0001) - 1)` before the agent sees it (tested against
  the contract math). Gas is an estimate of 0.1 NEAR for the whole cascade.
- **Range:** the agent's ticks (`±halfWidthTicks`, agent config) are widened outward to multiples of the pool's
  `point_delta` and clamped to the contract bounds; the result must hold the current point. Only out-of-range
  positions get a card.
- **Cascade** (`recentre_dcl`): reads the position and pool fresh, then remove liquidity → withdraw both tokens →
  swap the surplus token to the new range's ratio (only when it is above 0.5 % of the position; min-out = the
  contract's `quote` minus slippage) → deposit both → `add_liquidity`. Every amount is sized from guaranteed minimums
  (the removal's minimums, the swap's min-out), and the add's minimums follow the same slippage. Stopping halfway
  leaves the tokens in the wallet, the same state as the exit.
- **`validateCascade`:** `add_liquidity` sent to the DCL contract needs a string `pool_id` in the DCL allowlist
  (`rhea.dclPools` in `config/market.json`: the two USDC/wNEAR pools, fees 100 and 2000). Any other receiver keeps the
  v1 rule (numeric `pool_id` in `rhea.pools`). Caps are unchanged.
- **One card per position:** the re-centre when it pays back within `maxPaybackDays` (14), else the exit, now titled
  as an exit.
- **Our own swap moves the pool** before the add: the add's minimums allow for the move implied by the quote, and a
  move larger than the slippage refuses the re-centre (409) rather than loosening the minimums. Prepare also refuses
  a position back in range, a paused pool, and a range at the top point bound or wider than 200 000 points.
- **wNEAR stays wNEAR:** the DCL contract pays withdrawals and swap output with `ft_transfer` (ref-ui passes no unwrap
  flag to `withdraw_asset`; no `near_withdraw` in 100 recent mainnet receipts), so the later wNEAR deposit is funded.

**Consequences:** The cost and fee numbers are estimates (volume persists, fixed time in range, no IL). A position too
large for the pool's depth gets the card but prepare refuses it. If the add still fails, the tokens sit in the
user's Rhea balance.

## D27 — Token logos come only from the token contract, as checked data URIs

**Context:** #124. Tokens were shown as bare symbols; other NEAR apps show logos.
**Decision:** The logo is the token's own `ft_metadata.icon`, read by the API (view call) and kept only if it is a
`data:image/(png|jpeg|webp|gif|svg+xml)` URI of at most 32 KB (`safeTokenIcon`, `packages/core`); the UI checks it
again and renders it only through `<img>`, where an SVG cannot run scripts. Cached per process (500 tokens, a failed
read is not cached). Native NEAR and wNEAR (no icon on chain) get one checked-in NEAR logo; every 1Click deposit asset
is a `nep141:` NEAR token, so it uses that token's icon. The five deposit chains have checked-in logos
(`apps/analytics/public/chains`). No external token list: no new host in the CSP, no third-party data. Any other
token without an icon shows a letter placeholder.
**Consequences:** A contract can still pick a misleading logo, as it can pick a misleading symbol; the "Unverified"
badge stays the trust signal. Logos are inlined in the page (0.5–11 KB each today).

## D28 — Real activity: one `events` table, RPC is the only judge of "signed"

**Context:** #32. Activity and /policy showed only the collector's shadow decisions over the demo portfolios; nothing
the real wallet path did reached them, and the team could not count connects, analyses, prepares and signatures.
**Decision:** One `events` table (migration 0021; account id only, no IP; 30 days). Kinds: `connect` (browser-reported,
`source: client`, once per account per UTC day), `verified` (ownership proof passed), `analyse` (AI / rule-based),
`prepare` / `prepare_blocked` (with the `validateCascade` verdict, a per-rule check list and the exact steps),
`signed`, `oneclick_quote`. `validateCascade` returns the result per rule (signer, receivers, methods, gas, deposit,
arguments); no limit changed. `POST /v1/wallet/confirm` is the single verifier: it reads the transaction from NEAR RPC
(`tx`, `wait_until: FINAL`) and writes `signed` only when it is final and successful, signed by the account, and
exactly a step of the stored cascade (receiver, and per action the method, args and deposit; gas is not compared
because a wallet may change it), included in a block no older than the prepare (60 s clock slack), so an older
transaction with the same args does not count. One row per tx hash. If the server has no record of the cascade (the
best-effort prepare row was not stored, or events are off), the step shows "sent, not checked" and the cascade goes
on: a recording failure must not block the user's own cascade. The browser asks after every step; a failed or unconfirmed step
stops the cascade. Activity is public per account for confirmed transactions only; analyses and unsigned cascades need
the ownership proof. /policy is public: the account is cut to "ali…near", no amounts (intent amounts, preview and a
wrapped NEAR deposit are left out, long numbers in check messages are cut). The collector's demo shadow loop keeps
running for Home's demo portfolios; only its UI (Activity feed, demo verdicts, `/v1/analytics/agent-activity`) is
removed. `/v1/analytics/policy/verdicts` stays as the audit-evidence API (replay), unused by the site.
**Consequences:** A `connect` count is a claim, not proof. A signed transaction whose confirm never ran (tab closed
before the check) is not counted; the owner can reopen nothing to fix it (no indexer, after the hackathon). A failed
step is shown in the dialog but not stored. Old transactions stop being readable on the non-archival RPC after ~2
days, which is far longer than the confirm window.

## D29 — Priced Burrow actions go through `execute_with_pyth`, not the oracle's `oracle_call` (#166)

**Context:** #166. On 13 Nov Burrow mainnet rejected every `priceoracle.near` → `oracle_call` with "Price oracle
disabled" (`price_receiver.rs`), so borrow, withdraw and repay from collateral (and the withdraw → swap → repay
cascade) failed on-chain. The same actions succeed through `contract.main.burrow.near` → `execute_with_pyth`
(tx `9jmdbLjUwjgUtDfsgTniP6Fw6gho8bFrZnKgT3a2Xznt`): Burrow works out the assets it must value and fetches their
prices itself (`actions_pyth.rs`).
**Decision:** The three priced builders call `execute_with_pyth { actions }` on the verified Burrow contract with
1 yoctoNEAR and 300 Tgas; the actions keep their shape (`max_amount` caps). `validateCascade`'s method allowlist
swaps `oracle_call` for `execute_with_pyth` and requires it to attach exactly 1 yocto with a non-empty `actions`
list; the receiver allowlist for these cascades is Burrow instead of the
oracle. No gas or deposit cap changes (300 Tgas is the existing per-action ceiling). Burrow verification requires
`execute_with_pyth` instead of `oracle_on_call`. The oracle verification keeps only `get_price_data` (Market
Intelligence's second price source, D13); it no longer requires `oracle_call`.
**Consequences:** No more `asset_ids` resolution on our side. If Burrow also disables Pyth (`enable_pyth_oracle`),
the call panics "Pyth oracle disabled" on-chain and nothing moves but gas; not pre-checked, because that check
would sit in deployment verification and also block supply and repay, which need no prices.

## D30 — A strategy is the risks it accepts; it decides where idle money goes (#132)

**Context:** #132. The presets only moved risk lines, so a wallet with idle stablecoins and no loan got the same card
under all three. We are not traders and do not forecast yields.
**Decision:** A preset is the set of risk types it accepts; within that set the code picks the highest yield it can
compute from live protocol rates. Conservative: Burrow lending only (smart-contract and rate risk). Balanced: also a
stablecoin liquidity pool when one pays clearly more (peg risk, small impermanent loss). Aggressive: also leverage, a
same-asset Burrow loop at its target health factor 1.35 (`loopFor`). The supply card stays the only button: the app has
no borrow action, so a loop that pays more after the gas of every round, and fits the market's free liquidity, is a
line on the supply card (net APR, $ a year, break-even borrow rate, liquidation risk), not a card of its own. An AI supply card for the same token carries the same code-computed line; the prompt says which
risks the preset takes and never to propose borrowing. Volatile-pair liquidity is not offered for idle money: a
single-token wallet would have to swap half into a volatile token, and no stablecoin pair is in the collector's pools.
**Consequences:** On a USDC-only wallet all three presets supply today (borrow 16.6% > supply 10.8% makes the loop lose)
but each card says why in its own numbers. Balanced compares a stablecoin pool once one is collected (StableSwap pools
are not ranked yet). The health-factor lines are unchanged (D22).

## D31 — Stablecoins swap into each other through Rhea pool 4179 (#191)

**Context:** #191. A loan in USDt or USDT.e with USDC in the wallet or as collateral got only an advisory card: the
swap → repay builder needs an allowlisted route, and `rhea.pools` had only wNEAR/USDC (4512). Direct USDC/USDT.e
simple pools are empty; RATED_SWAP pool 4179 holds USDt / USDC / USDT.e / USDC.e (~$105k, 2 bp fee; 1,000 USDC →
1,000.5 USDT.e on 14 Nov).
**Decision:** `config/market.json` lists pool 4179 three times as exact pairs: USDC↔USDt, USDC↔USDT.e, USDt↔USDT.e.
This widens the swap routes the account view may quote and build (swap → repay, the Guardian). No cap changes:
`validateCascade`'s code is unchanged; its `allowedPools` (built from this list, checked only for `add_liquidity`) now
also holds 4179, but the `add_liquidity` prepare route refuses any non-SIMPLE pool before a cascade is built. The swap
keeps its slippage floor from a fresh `get_return` quote; the policy token allowlist is untouched. Price impact is
shown only for a SIMPLE pool (a stable pool's reserve ratio is not its price). Burrow's borrow rate is shown whenever
Burrow reports it and the block is fresh, no longer only when the supply side passes its liquidity / price checks.
**Consequences:** The same entries reach the collector (venue quotes, the yield allowlist flag of 4179, and the demo
agents' routable pairs: a demo may now propose USDC↔USDt, which its policy allows, dry-run only; USDT.e stays blocked,
it is not in `policy.allowedTokens`). The pool is listed once per pair because the registry models two-token pools
(ponytail: a `tokens[]` entry once a fourth stablecoin route is needed). A loan in any of the three stablecoins can be
repaid from either of the other two in one cascade.

## D32 — Solana mints that can change a transfer are not deposit origins (#185)

**Context:** A Token-2022 mint with a `transferFeeConfig` (NEARKAT: 300 bps) delivers less than the `EXACT_INPUT`
quote to the 1Click deposit address, so the deposit is refunded after the deadline, while the QR (#128) presents it
as the exact amount. Other extensions (transfer hook, pausable, default frozen state, permanent delegate,
non-transferable) can block or take a transfer the same way.
**Decision:** The API reads every Solana mint 1Click lists with one jsonParsed `getMultipleAccounts` call per 100
mints (`gateway/solana-transfer-fee.ts`, `SOLANA_RPC_URL`, public mainnet RPC by default, one attempt, 5 s timeout),
cached 10 minutes. A mint is offered only when every extension is on a harmless allowlist (metadata, groups, close
authority, a transfer fee of 0 in both the older and newer setting, a transfer hook with no program); anything else,
an account that is not a mint, or a non-native token with no mint is dropped from `/v1/deposit/assets` and refused by
`/v1/deposit/quote` (both use the same list). A live check, not a denylist, so a mint that adds a fee later is caught.
A read older than 10 minutes is answered at once and refreshed in the background; a failed read keeps the last answer
(at most an hour) and is retried after a minute; a mint never read, or listed with a malformed address, is not
offered. `HttpJsonClient`'s timeout now also covers the body, so a stalled RPC cannot hold a request. On 14 Nov all 22 listed mints were read: only
NEARKAT has a non-harmless extension.
**Consequences:** One more outbound, read-only call from the analytics API. If the Solana RPC is down from start,
only native SOL is offered on Solana. EVM fee-on-transfer tokens are not detected.

## D33 — HOT Kit is the origin-chain wallet connector (#169)

**Context:** #169. Deposit, withdraw and Google login (#126, #171, #172) need wallets on other chains. HOT Kit
(`@hot-labs/kit`) 2.0.0 (13 Nov 2026) connects EVM, Solana, TON, Stellar, TRON, BTC and more with no API key.
**Decision:** `@hot-labs/kit` pinned to exactly `2.0.0` in `apps/analytics`, used only in `lib/hot-kit.ts`: one lazily
created `HotKit` with the EVM and Solana connectors only, imported on first use (the deposit dialog), never on page
load. The kit's NEAR connector is left out: its session restore reads near-connect's `selected-wallet` key, and the
NEAR wallet stays in `lib/wallet.ts`. One picker per chain (`kit.connect(WalletType.EVM | SOLANA)`), because in 2.0.0
the all-chains picker never settles when its nested chain picker is closed. While a kit popup is open the deposit
`<dialog>` drops to non-modal, or the top layer makes the popup inert. WalletConnect (mobile wallets by QR) uses our
Reown project id from `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`: public by design, inlined by Next at build time, so a
Docker build arg (compose and `deploy/public/build-bundle.sh` read it from the local `.env`), checked by
`walletConnectProjectIdSchema`; empty or malformed = browser wallets only. The Reown project must allow the site's
domains. No Next polyfills needed, no CSP change (relay `wss:` and verify frame `https:` are already allowed).
**What it calls:** by default only hex-api (`hex-api.app`: EVM/Solana RPC, prices and token lists, 1Click proxy;
`mpc.hex-api.app`: intents relay) and public chain RPCs; connecting itself fetched only wallet icons
(`storage.herewallet.app`, `tgapp.herewallet.app`); with a project id, WalletConnect also talks to Reown's relay. No telemetry. Our 1Click quote and status path stays ours.
**#172 finding:** Google login (`@hot-labs/kit/privy`) needs our own Privy app (`appId`) and gives a NEAR implicit
account whose ed25519 key never leaves Privy's TEE; it can `signAndSendTransaction`, so Privy, not the user's device,
holds the key.
**Consequences:** HOT Kit adds ~1.1 MB of lazy chunks (the core chunk ~110 kB gzip) to the deposit dialog only. The
kit adds no signing path in this step; #126 decides where the origin-chain transfer lives and extends
`test/signing-lock.test.ts`.

## D34 — A deposit may be sent from the user's own EVM / Solana wallet, built from the stored quote (#126)

**Context:** #126. Sending a 1Click deposit by hand (copy the address, type the amount) is where money gets lost. HOT
Kit (D33) can ask the connected EVM or Solana wallet for a transfer. That is signing on a non-NEAR chain, which the
"signing only in the user's wallet" rule did not cover, and `validateCascade` checks NEAR cascades only.
**Decision:** the user's own origin-chain wallet may be asked for exactly one kind of transaction: the transfer of a
stored 1Click quote. `GET /v1/deposit/transfer/:id` rebuilds it from our `deposit_quotes` row, never from the browser:
chain, token (native by its exact 1Click asset id, else the contract `paymentToken` names), `amountIn` in base units
and the deposit address, which must be an address of that chain. It refuses (409) a quote within 2 minutes of its
deadline (a wallet prompt can stay open), one whose stored or freshly asked (never cached) 1Click status is anything
but unpaid, so a retry after a send is refused once 1Click sees it, Bitcoin and any asset it cannot name; no 1Click
status is a 502, never a transfer. The browser refuses the answer
unless it is exactly the quote on screen (id, chain, asset, decimals, amount, deposit address), and `lib/hot-kit.ts`
refuses again when the kit would read the token as another network or contract; only then does it call the kit's
`wallet.transfer` (EVM: the kit switches the network and refuses to send on another one). The user signs in their
wallet; the server never sees a key. `test/signing-lock.test.ts` keeps `.transfer(` / `sendTransaction` /
`signIntents` to that one call in `lib/hot-kit.ts`. The connected wallet of the chosen chain fills the refund address
until the user types another; the server still validates it. The QR / manual path stays for every quote.
**Consequences:** no new caps: the amount and receiver are the quote's, which the user saw and 1Click verified. After
a send the button is replaced by the transaction link, so one quote is not paid twice from the dialog; the existing
status polling follows the deposit. The API hands a quote's transfer out once (#214): `transfer_issued_at` on
`deposit_quotes` is set by a conditional update, and a second request (another tab) gets 409. Only the dialog that saw
its wallet reject the send (declined, no gas, no token, refused by the network) asks again with `retry=1`. Bitcoin and TRON wallets stay manual (stretch).

## D35 — One HOT Kit connects every wallet; its NEAR connector runs on our near-connect 0.12 (#189)

**Context:** #189. After #126 there were two connectors: near-connect for the NEAR account and HOT Kit for EVM /
Solana. The kit's own NEAR connector creates near-connect 0.8.2, which cannot pass the CSP nonce to the wallet iframes
(D11): under our nonce CSP no NEAR wallet would load.
**Decision:** `lib/hot-kit.ts` creates one kit with NEAR, EVM and Solana connectors. The NEAR one is the kit's
connector built on our own near-connect 0.12 instance (`network: mainnet`, `signInWithoutAddKey`, `cspNonce`), the only
place near-connect is imported; a one-line shim turns the kit's `connect(walletId)` (0.8 form) into 0.12's
`{ walletId }`, or 0.12 would open its own second list. The session stays near-connect's `selected-wallet` key, so a
wallet connected before #189 stays connected. "Connect wallet" opens the kit's all-chains list and settles on a NEAR
sign-in, so the 2.0.0 bug (D33: the list may never settle) cannot hang the button; connecting only an EVM / Solana
wallet leaves the page without a NEAR account. Disconnect signs out of every kit wallet. Signing is unchanged:
`lib/wallet-sign.ts` signs on the same near-connect wallet, cascades still pass `validateCascade`. The kit is loaded
only on "Connect wallet" or when `selected-wallet` exists. No Tron (not a deposit origin); Bitcoin is a follow-up
because `walletChainOf` would also open a wallet send on BTC, which D34 keeps manual.
**Consequences:** first-load JS fell by 15 kB on `/` and `/activity` (near-connect left the page bundle); a visitor
with a NEAR session now loads the kit core (~110 kB gzip, lazy) after hydration. The near-connect wallet type is cast
to the kit's 0.8.2 type; a kit upgrade must re-check that `connect(id)` shim. On a NEAR connect the kit also reads that account's token
balances client-side (public chain data, read-only); it signs nothing on connect.

## D36 — A withdrawal sends `ft_transfer` only to its stored 1Click quote's deposit address (#171)

**Context:** #171. Getting money out of NEAR was manual. For a NEAR origin, 1Click's deposit address is a NEAR
implicit account (64 hex, checked live on 14 Nov) that holds no storage on the token, so the transfer needs
`storage_deposit` for it and a plain `ft_transfer` (an `ft_transfer_call` would bounce: the account has no contract).
`ft_transfer` was not in `validateCascade`'s method allowlist.
**Decision:** `POST /v1/withdraw/quote` quotes one of our tokens (`policy.allowedTokens`, as 1Click lists it on NEAR)
to any 1Click token on Ethereum, Base, Arbitrum or Solana (the D32 filter applies; no Bitcoin), with the recipient
checked as an address of that chain and the NEAR account as the refund address; the quote is verified like a deposit
quote, its deposit address must be a NEAR implicit account, and it is stored in `deposit_quotes`. The intent
`withdraw_1click { quoteId }` of `/v1/wallet/prepare` takes token, receiver and amount from that row only: the row must
belong to the signer, be a NEAR-origin quote of a listed token, be more than 2 minutes from its deadline and not seen by
1Click (stored and freshly asked), and the wallet must hold the amount. It builds one transaction on the token:
`storage_deposit { account_id: <deposit address>, registration_only: true }` (bounds.min, capped at 0.0125 NEAR like
other registrations; skipped when registered) and `ft_transfer` of the quoted amount, 1 yocto. `validateCascade` allows
`ft_transfer` only when the context names `transferTo`, and only to it, with exactly 1 yocto and a positive amount;
every other cascade has no `transferTo`, so `ft_transfer` stays refused there. No cap changes. A quote is built at most once:
after every check passes, the build claims it with the same `transfer_issued_at` mark as a deposit transfer (#214), so
a failed build does not use it up and a second build (another tab, a rebuild) gets 409; the dialog offers one signing
attempt per quote. One EXACT_INPUT quote cannot be paid twice before 1Click sees the first transfer; after a decline
the user gets a new quote.
**Consequences:** A withdrawal is signed in the NEAR wallet like any cascade and confirmed step by step. Its status is
the deposit status path (#29); the recipient address is kept in the `oneclick_quote` event, not in `deposit_quotes`.
Native NEAR (needs a wrap first), Bitcoin and other chains are not offered yet.
