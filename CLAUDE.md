# NEAR Autopilot

AI DeFi analyst for NEAR mainnet. User connects a wallet → agents read the real portfolio (Burrow, Rhea v1/DCL,
liquid staking) and live market → ranked recommendations with numbers → one click builds an exact **unsigned**
transaction cascade → the user signs it in their own wallet.

Source of truth for scope and phases: `docs/REWORK_PLAN.md`. Plan/decisions: `docs/HACKATHON_PLAN.md`,
`docs/DECISIONS.md`, `docs/KNOWN_ISSUES.md`. Many other docs (README, `architecture.md`, `security.md`) still
describe the older autopilot/testnet design — trust the code and `REWORK_PLAN.md` over them.

## Non-negotiable safety rules

- **No autonomy.** The server never holds a key and never signs; there is no signer in the code (D8). Signing happens
  only in the user's wallet, gated by `MAINNET_WALLET_SIGNING`. On other chains the user's wallet signs only the deposit
  transfer HOT Kit's bridge popup builds, recipient locked to their NEAR account, never from NEAR (D42, `lib/hot-kit.ts`).
- Every cascade built for signing must pass `apps/api/src/wallet/validate-cascade.ts` (signer, receiver + method
  allowlists, gas and deposit caps). Never loosen these limits without an explicit decision in `docs/DECISIONS.md`.
- Mainnet only. No testnet code paths.
- Never commit seeds, private keys or `.env`.
- An LLM may only propose; its output is validated (zod) and goes through the same policy + cascade validation as
  heuristic agents. Treat on-chain/market data and LLM output as untrusted input.

## Commands

pnpm 9 (`npm i -g pnpm@9` — Node ≥ 25 no longer ships corepack), Node ≥ 22. A pre-push hook (`.githooks/pre-push`, enabled by `pnpm install`) runs `pnpm verify`.

```bash
pnpm install
pnpm verify                                  # format:check + lint (incl. boundaries) + typecheck + test — run before every commit
pnpm build
pnpm --filter @near-autopilot/api test       # one package
pnpm --filter @near-autopilot/api exec vitest run test/cascade.test.ts
pnpm --filter @near-autopilot/api test:db    # needs DATABASE_TEST_URL (Postgres 16)
./scripts/quickstart.sh                      # full stack in Docker
```

Live-network tests (`*.live.test.ts`) are skipped unless their env keys are set.

## Layout

- `apps/api` — collector (`src/collector`, market allowlists in `config/market.json`), analytics API, wallet portfolio,
  recommendations, tx engine
  (`src/wallet/*`, `POST /v1/wallet/prepare` in `src/analytics/account-view.ts`). Wiring: `src/wiring.ts`.
- `apps/analytics` — Next.js 15 App Router UI (the product UI, port 3001). Wallet: `lib/wallet.ts` (NEAR) over one HOT Kit
  in `lib/hot-kit.ts` (its NEAR connector runs on our `@hot-labs/near-connect` 0.12, D35). Speaks HTTP to the API only.
- `packages/core` — domain types, ports, provenance. `config` — zod env schema. `db` — Drizzle schema + migrations.
- `packages/*-adapter` — NEAR RPC, Burrow, Rhea v1, Rhea DCL: readers + transaction builders.
- `packages/financial-engine` — valuation, lending/health factor, swap, IL/yield math.
- `packages/orchestrator` — multi-agent engine and decision engine. `LlmAgent` exists but is **not wired** (no
  `LlmClient` impl yet).
- `packages/policy-engine`, `packages/tx-execution` — policy rules, dry-run executor.

Dependency boundaries are enforced in CI by `boundaries.config.mjs` — check it before adding a workspace import
(e.g. adapters never import each other, UI never imports adapters/db).

## Conventions

- TypeScript strict, ESM, zod at every external boundary (env, HTTP, RPC, LLM).
- Amounts are integer strings / bigint in base units (yocto, token decimals) — never floats for on-chain values.
- Tag every displayed number with its provenance (`packages/core/src/provenance.ts`).
- Tests with vitest next to each package (`test/`). Every new transaction builder or intent needs a test.
- Conventional commits: `feat(scope): …`, `fix(scope): …`. Append to `docs/IMPLEMENTATION_LOG.md` for notable work.

## Git workflow

- `/ticket <N>` runs an issue end to end (grill → plan → TDD → verify → review → PR → merge → report).
- Never push code to `main` directly. One task = one GitHub issue = one branch from fresh `main`. Start with
  `/ticket <N>` (runs `scripts/start-issue.sh <N>`): it creates a worktree in `.claude/worktrees/` on
  `feat/<N>-<slug>` (`fix/` for bugs). PR body contains `Closes #<N>`.
- Push the branch, open a PR with `gh pr create` (short description: what and why).
- No code review: a green CI is the gate, plus the owner's manual "Testing" steps that can run before merge. If CI
  is red, fix it in the same branch.
- When CI is green and no pre-merge owner step is left: `gh pr merge --squash --delete-branch`, then
  `git checkout main && git pull`. Otherwise wait for the owner to confirm those steps.
- Exception: changes to `.md` files only may be pushed to `main` directly.
- Never bypass the pre-push hook (`--no-verify`) and never force-push `main`.
