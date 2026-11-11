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
  the caller's own cached read, so the page shows the new state at once. Another visitor cannot drop it.
- The 15 s auto-refresh stays on every page, so prices and the health factor keep updating (at most once a minute
  on the account view).
- `MAINNET_READ_RPC_URL` must be the FastNEAR URL whenever `MAINNET_READ_RPC_API_KEY` is set; the public NEAR RPC
  ignores the key and answers 429 under load.
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
bare 500/502, details only in the log.
**Consequences:** Every page renders dynamically (nonce). A new inline script needs the nonce from `headers()`.

## D12 — Central LLM on the wallet path (architecture C)

**Context:** #18. The plan has the central LLM call the existing orchestrator agents as tools. On a wallet, the Capital
Allocator and LP Optimizer had no inputs, and the concentration and DCL checks exist only in the wallet code.
**Decision:**

- Tools: `LiquidationGuardianAgent`, `CapitalAllocatorAgent` (`supplyIdle`, every Burrow token with an oracle price)
  and `MarketIntelligenceAgent`, run on a fresh Burrow snapshot of the tokens the wallet holds (`SnapshotService`),
  priced with the collector's confirmed prices, the same ones the portfolio table uses. `priceoracle.near` returned no
  recent price on 11 Nov 2026, so it is only Market Intelligence's second source (empty when it has none). Yields
  are today's Burrow supply rates; there is no 24 h volatility on this path. Plus two
  wallet checks: concentration and DCL out of range. The LP Optimizer waits for a 24 h volume source (separate issue).
- Only `lending.repay` (guardian) and `lending.supply` (allocator) worth at least $1 become recommendations; the
  repay text states the health factor the repayment actually reaches. Allocator swaps (they would
  move the whole wallet into the highest-yield token) and collateral top-ups (prepare's supply is not collateral) are
  dropped.
- The LLM returns only `{picks: [{id, why}]}` (zod). Unknown ids are dropped; a "why" with a number that no tool
  showed in a readable field (title, why, health factor, notes; not ids or raw amounts) is replaced by the code's
  text. A loan warning the model left out is put back first. At most 6 model turns (one per tool if it does not call
  them in parallel), at most 10 tool calls per turn, 45 s for the whole analysis including the wallet read; on the
  deadline the model call in flight is aborted. An empty ranking or any failure returns the rule-based list, labelled.
- `POST /v1/wallet/prepare` accepts an optional exact `amount` (base units) for repay and supply, capped at the
  wallet balance. Cascade caps and `validateCascade` are unchanged.
- The test that banned LLM code from `apps/api/src/analytics` now allows the provider only in `analytics/main.ts`
  (wiring); the collector stays LLM-free, and the no-signing/no-sending ban is unchanged.
- The Next route allows 5 analyses per visitor and 60 overall per 10 minutes.
- `ANTHROPIC_API_KEY` stays off the public server until #20 (NEP-413) and #21 (spend cap) are merged.
  **Consequences:** An analysis costs one snapshot read (about 2 RPC calls per Burrow token) plus up to 4 model calls.
  With the key unset the route is free and returns the rule-based list.
