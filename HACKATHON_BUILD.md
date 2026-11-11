# NEAR HACKATHON 2026: how this was built

NEAR Autopilot was built for NEAR HACKATHON 2026 (tracks: **security**, **defi**, **thesis**). This file says when the
code was written, how, with what, and how a judge can tell the hackathon work apart.

## What to review

| Link                                                                                                                                           | What                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`hackathon-submission`](https://github.com/deafmsn201111-sys/near-autopilot/tree/hackathon-submission)                                        | The submitted project. **All of it** was written in the hackathon window: there is no pre-hackathon code.                                          |
| [`hackathon-start...hackathon-submission`](https://github.com/deafmsn201111-sys/near-autopilot/compare/hackathon-start...hackathon-submission) | Everything changed after the work was imported into git (see below). It does **not** show the first commit's content, which is hackathon work too. |

Tags (FAQ Q-003):

- `hackathon-start` is `232bfb7`, the first commit (2026-11-04).
- `hackathon-submission` is the submitted commit.
- There is no `pre-hackathon` tag, because nothing predates the window.
- The earlier tags `v0.1.0-testnet-readonly` and `v0.2.0-testnet-market-data` are checkpoints from 2026-11-04, inside
  the window.

## Timeline

| Date (UTC)               | What                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| 2026-11-02               | Work starts in a local browser session of Claude, with no repository connected.                 |
| 2026-11-04               | The result is imported into git as commit `232bfb7`.                                            |
| 2026-11-04 to submission | All further work happens in git on branch `fix/audit`. Each change is pushed and checked by CI. |

The hackathon window for code opens 2026-10-19 (FAQ Q-001). The first commit in this repository is dated 2026-11-04,
and `git log --all --until=2026-10-19` is empty.

**About the first commit (`232bfb7`, "Baseline: project state as found before audit fixes").** This is not
pre-hackathon code. NEAR Autopilot was started on 2026-11-02 in a local browser session of Claude, with no repository
connected. On 2026-11-04 that work was imported into git as the first commit. The next commits audit and fix it,
which is why the message says "as found before audit fixes".

**What git does and does not prove.** Git history starts on 2026-11-04. The work from 2026-11-02 to 2026-11-04
happened outside git, so git cannot prove those dates; for that period the basis is the author's statement.
Everything from `232bfb7` on is in the commit history.

## AI-assisted

The code, tests and documentation were written with AI:

- the browser version of Claude, 2026-11-02 to 2026-11-04, before the git import;
- Claude Code, from 2026-11-04.

The author set the requirements, the safety constraints and the limits, and reviewed the results. Every real
transaction was the author's decision: each was confirmed by its preview hash, and the Burrow registration was sent
by the author personally.

## Libraries and services (FAQ Q-005)

**Own pre-hackathon libraries:** none. **Templates or boilerplate repositories:** none.

Open-source dependencies, as declared in the workspace's `package.json` files and pinned in `pnpm-lock.yaml`:

| Area                 | Libraries                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language and tooling | TypeScript ^5.7, pnpm workspaces, Turborepo ^2.3, ESLint ^9 (with typescript-eslint and eslint-config-prettier), Prettier ^3.4, Vitest ^2.1, tsx ^4.19, drizzle-kit ^0.30                                                        |
| API and data         | Fastify ^5.2 (with its built-in pino logger), Zod ^3.24, Drizzle ORM ^0.38, `pg` ^8.13 (PostgreSQL)                                                                                                                              |
| Dashboards           | Next.js ^15.1, React ^19                                                                                                                                                                                                         |
| NEAR                 | `@near-js/crypto`, `@near-js/transactions`, `@near-js/utils` 2.5.1 (key handling and transaction encoding); `@hot-labs/near-connect` 0.12.0 (HOT Connector, wallet sign-in only); NEAR JSON-RPC called by our own `near-adapter` |
| Audit checkpoints    | Node.js `crypto` (ed25519)                                                                                                                                                                                                       |

Besides these, the workspace declares only type packages (`@types/*`), `globals` and `server-only`.

External services:

| Service                                                | Used for                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| NEAR mainnet RPC (FastNEAR, public near.org, archival) | Chain state, view calls only.                                                      |
| Rhea (Ref v1, DCL) and Burrow contracts                | Reading pools and markets.                                                         |
| Pyth, DefiLlama, exchange tickers                      | Reference prices, cross-checked against each other.                                |
| NEAR Intents 1Click API                                | **Dry quotes only.** `dry: true` is a constant in the client; no swap is executed. |

The data collector makes no LLM API calls.

## Evidence a judge can re-run

| Claim                              | How to check                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Builds and runs from a fresh clone | `./scripts/quickstart.sh`. On 2026-11-08 it took 6 min 13 s, with no manual edits.                                         |
| Tests pass                         | `pnpm verify` (format, lint, boundaries, types, tests); CI runs it on every push.                                          |
| Attacks are stopped                | `pnpm demo:attack`: 8 of 8 stopped, 2 controls allowed, `signed 0, broadcast 0`.                                           |
| Audit trail is intact              | `docker compose exec analytics-api node --import tsx src/evidence/cli.ts verify`: hash chains and ed25519 checkpoints `ok` |
| Thesis is reproducible             | `pnpm thesis:rebuild && git diff --stat`: no changes.                                                                      |
