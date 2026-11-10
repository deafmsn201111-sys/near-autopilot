# Architecture

NEAR Autopilot reads a connected wallet's real mainnet portfolio, ranks what could be done with it, and builds an exact
**unsigned** transaction cascade that the user signs in their own wallet. The server never holds a key and never signs.

## Request path: wallet to signature

```
 browser (apps/analytics, :3001)                 analytics API (apps/api/src/analytics, :4003)
 ───────────────────────────────                 ─────────────────────────────────────────────
 connect wallet (HOT Connector) ──account id──►  GET /v1/analytics/account/:id
   lib/wallet.ts                                   view calls: wallet, Burrow, Rhea v1 + DCL, stNEAR/LiNEAR
                                                   + stored prices and markets (Postgres, from the collector)
 recommendations  ◄──portfolio + ranked recs───    portfolioRecommendations()
 "prepare" ─► /api/prepare (Next.js proxy) ────►  POST /v1/wallet/prepare
                                                   builders (adapters, src/wallet/*) -> assembleCascade
                                                   validateCascade -> refuse, or return unsigned txs
 PrepareDialog: preview  ◄──unsigned cascade───
 lib/wallet-sign.ts ─► user's wallet signs and sends (only if MAINNET_WALLET_SIGNING=1)
```

1. **Connect.** `apps/analytics/lib/wallet.ts` uses HOT Connector (`@hot-labs/near-connect`) with
   `signInWithoutAddKey`: connecting adds no access key, and only the account id leaves the wallet.
2. **Read.** `GET /v1/analytics/account/:id` (`apps/api/src/analytics/account-view.ts`) reads the account with view
   calls only: NEAR and token balances, the Burrow position and health factor, Rhea v1 LP shares on allowlisted pools,
   Rhea DCL positions, and liquid-staking tokens (stNEAR, LiNEAR). Prices, Burrow markets and token metadata come from
   what the collector stored in Postgres.
3. **Recommend.** `portfolioRecommendations()` in the same file returns ranked recommendations (reduce concentration,
   improve loan safety, put idle funds to work, reposition an out-of-range DCL position), each with an intent and the
   numbers behind it. The site renders them in `components/Recommendations.tsx`.
4. **Prepare.** The site posts the intent to `apps/analytics/app/api/prepare/route.ts`, a rate-limited proxy that adds
   the server-side API token, which forwards to `POST /v1/wallet/prepare`. The request is zod-validated (supply, repay,
   swap, add_liquidity, reposition_dcl, unwrap, borrow, withdraw). The API verifies the protocol deployment, resolves
   exact base-unit amounts (`src/wallet/amounts.ts`), prepends storage registration and wrapping where needed
   (`src/wallet/wrap.ts`), builds the transactions with the adapter builders and orders them (`src/wallet/cascade.ts`).
5. **Validate.** Every cascade passes `validateCascade` (`apps/api/src/wallet/validate-cascade.ts`) before it is
   returned: every transaction's signer must be the connected account, receivers and `ft_transfer_call` targets must be
   on the per-cascade allowlist, methods on a fixed allowlist, gas at most 300 Tgas per action, deposits at most
   0.15 NEAR per action and 0.3 NEAR per cascade (wrapping NEAR is exempt, it is the user's own value). A failure
   refuses the whole cascade.
6. **Sign.** `components/PrepareDialog.tsx` shows the preview. `apps/analytics/lib/wallet-sign.ts` is the only file
   that asks a wallet to sign (enforced by `apps/analytics/test/signing-lock.test.ts`), and only when
   `MAINNET_WALLET_SIGNING=1`. The wallet shows every action again; the user approves or rejects there.

## Data path: collector, Postgres, analytics API

```
 NEAR mainnet (views) ┐
 Pyth, DefiLlama,     ├─► collector ──► Postgres ◄── analytics-api ◄── apps/analytics
 exchanges, 1Click    ┘   (src/collector/main.ts)    (src/analytics/main.ts)
```

- **collector** (`apps/api/src/collector/main.ts`; service `collector` locally, `shadow-collector` on the public
  server) reads mainnet with view calls and public price APIs on a schedule (default 900 s) and stores prices, Burrow
  markets, Rhea pools and yields. Each cycle also runs the orchestrator (`wire()` in `apps/api/src/wiring.ts`) on the two
  **simulated** demo portfolios. Its executor is the dry-run [Shadow Gateway](shadow-gateway.md); policy verdicts,
  routes and the audit chain are stored. Details: [mainnet-shadow.md](mainnet-shadow.md),
  [orchestrator.md](orchestrator.md).
- **analytics-api** (`apps/api/src/analytics/main.ts`) applies the DB migrations at start, then serves the stored data
  read-only under `/v1/analytics/*` (bearer token) plus `POST /v1/wallet/prepare`.
- **analytics** (`apps/analytics`, Next.js 15 App Router) is the site. Server components call the API over HTTP; the
  token never reaches the browser.
- Config: `config/market.json` (allowlisted pools and tokens, policy limits, orchestrator settings), loaded by
  `apps/api/src/market-config.ts` from `MARKET_CONFIG_FILE`. Env is validated in `packages/config`, which rejects
  `EXECUTION_MODE=live`.

Local stack: `./scripts/quickstart.sh` (postgres, analytics-api, collector, analytics; see `docker-compose.yml`).
Public server: `deploy/public/README.md`.

## Packages

| Package                     | Role                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/core`             | Domain types, ports, `ActionIntent`, `PlannedTransaction`, provenance, canonical JSON     |
| `packages/config`           | Zod env schema                                                                            |
| `packages/db`               | Drizzle schema and migrations                                                             |
| `packages/near-adapter`     | NEAR JSON-RPC client, account and token readers                                           |
| `packages/burrow-adapter`   | Burrow readers, risk maths, verified transaction builders                                 |
| `packages/rhea-adapter`     | Rhea v1 pool reader, swap quoter, swap and liquidity builders                             |
| `packages/rhea-dcl-adapter` | Rhea DCL (concentrated liquidity) client, tick maths, message builders                    |
| `packages/financial-engine` | Valuation, health factor, swap, IL and yield maths (bigint, no floats)                    |
| `packages/orchestrator`     | Multi-agent engine and pure decision engine; `LlmAgent` exists but is not wired           |
| `packages/agents`           | Older heuristic agents                                                                    |
| `packages/policy-engine`    | Policy rules and `ApprovedPlan` minting ([policy-verdicts.md](policy-verdicts.md))        |
| `packages/tx-execution`     | Planner registry, approval checks, dry-run executor                                       |
| `apps/api`                  | Collector, analytics API, wallet cascade builder; `src/wiring.ts` is the composition root |
| `apps/analytics`            | The site; speaks HTTP to the analytics API only                                           |

Dependency rules live in `boundaries.config.mjs` and are checked in CI (`scripts/check-boundaries.mjs`):

- adapters depend only on `core` and never import each other;
- `agents`, `policy-engine` and `orchestrator` depend only on `financial-engine` and `core`; the orchestrator reaches
  policy and execution through ports it defines;
- `apps/analytics` may import only `config` and `core`: no adapters, no DB;
- only `apps/api` binds concrete adapters to ports.

## Principles

- **No server signing.** No signer is wired anywhere; signing happens only in the user's wallet.
- **Fail closed.** Missing prices, stale data, unknown response shapes or unexpected receivers stop the action.
- **Exact amounts.** On-chain values are bigint / integer strings in base units; floats only for display.
- **Untrusted input.** Chain data, market data and agent or LLM output are validated with zod and re-derived before
  use; agent output goes through the same policy and cascade validation.
