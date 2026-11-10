---
name: ticket
description: Run one GitHub issue of NEAR Autopilot end to end — pick and read it, open its worktree, grill the owner on open decisions, plan, test first, verify, review, open the PR, merge on green CI and report on the issue. Use when the user says "/ticket 15", "start issue #15", "take ticket 15", gives an issue number to do, or asks to take the next task.
argument-hint: "[issue number] (empty = next issue)"
---

# Ticket — one GitHub issue, start to finish

`CLAUDE.md` (safety rules, conventions, git workflow) and `docs/HACKATHON_PLAN.md` (decisions, security items, cut
order) are the source of truth; this skill is the order of steps. Talk to the owner in Russian, short; write code,
commits, PRs and issue comments in English.

## 1. Pick and read

- **No argument:** take the first open, unassigned issue in the earliest open milestone whose "Depends on" issues are
  all closed. Prefer `never-cut`, then `security`, then the rest; `cut-N` last. Say which one and why in one line, then
  go on.
- `gh issue view <N> --comments`. The "Done when" list is the acceptance criteria; comments may change them. The
  "Testing" list is the manual QA: steps a person does and what they see, each tagged `[local]`, `[local, owner]`,
  `[live]`, `[live, owner]` or `[owner]` (meaning and how to run locally: `docs/TESTING.md`).
- **Blocked:** if an issue in "Depends on" is still open, stop and say what blocks it and what could be done instead.
- **`ops` issue:** never do the human part (buying, accounts, keys, wallets, deposits, posting). If there is
  repo-side preparation, run the steps below for that part only and comment the exact owner steps on the issue. If
  there is none, comment the steps and stop.

## 2. Worktree

- Run `scripts/start-issue.sh <N>` from the main checkout. It creates `.claude/worktrees/<N>-<slug>` on branch
  `feat/<N>-<slug>` (`fix/` for `bug` issues) from fresh `origin/main`, copies `.worktreeinclude` files, runs
  `pnpm install`, assigns the issue and moves it to In Progress on the board. It reuses an existing worktree and
  branch, so a resumed issue continues from its last commit.
- Call `EnterWorktree` with `path` = the last stdout line it printed. All further work happens there, never in the
  main checkout (another session may be using it).

## 3. Context

- The sections of `docs/HACKATHON_PLAN.md` the issue touches (Decisions, Security items, Admin screens), plus
  `docs/DECISIONS.md` and `docs/KNOWN_ISSUES.md` where relevant. Trust code and `REWORK_PLAN.md` over older docs.
- Read the code the change touches before planning; check `boundaries.config.mjs` before adding a workspace import.
- Load the skills the area needs: `near-dapp` for wallet / RPC / transactions, `near-intents` for 1Click,
  `claude-api` for anything LLM, `superpowers:test-driven-development` before writing code.

## 4. Grill

- Call the Skill tool with `grilling`, scoped to this issue: only decisions the issue and the plan leave open and that
  change what gets built (API shape, data stored, limits, UX, what to cut). Find facts yourself; ask decisions.
- Four days to the deadline: keep the tree small. If nothing is open, say so in one line and go on without asking.
- **Testing:** check the issue's "Testing" list against the plan (draft one if missing) and confirm it with the
  owner here. Plain user steps with the expected result, no code words, each with a tag from `docs/TESTING.md`.
  Prefer `[local]` (checkable before merge); `[live]` only for what needs the real server (Caddy, firewall,
  public domain, load). Changed list → `gh issue edit`.
- Do not plan until the owner confirms shared understanding.

## 5. Plan

- A few lines: files, tests, README/DECISIONS changes, and what stays out of scope (anything owned by another issue
  stays there).
- Subagents only where they pay off: independent parts in parallel with `isolation: "worktree"` and a narrow brief;
  expected test values that must not come from our own code. Not for a lookup or a few calls.

## 6. Build

- Test first: write the failing test, run it (`pnpm --filter <pkg> exec vitest run <file>`), see it fail for the
  right reason, then the code. Every new transaction builder or intent gets a test.
- Keep the safety rules in `CLAUDE.md`: the server never signs, every cascade passes `validateCascade`, caps never
  loosen without a `DECISIONS.md` entry, mainnet only, LLM and on-chain data are untrusted (zod), amounts in base units,
  provenance on every displayed number.
- Past about two hours: commit and push work in progress, comment the state on the issue, and stop.

## 7. Verify and commit

- `pnpm verify` green (plus `test:db` when the schema changes and `DATABASE_TEST_URL` is set).
- Walk the "Done when" list item by item: done, not done, or needs the live site / a real wallet.
- Run the `[local]` steps on a local run of this branch (`./scripts/quickstart.sh`, site on
  http://127.0.0.1:3001), driving the browser with `claude-in-chrome`; screenshot each result. `owner` steps are not
  faked. A failing step is a bug in this branch: fix it before the PR.
- Behaviour changed → README in the same branch (plan, Process). Decision made → `docs/DECISIONS.md`. Notable work →
  `docs/IMPLEMENTATION_LOG.md`.
- Conventional commits (`feat(scope): …`, `fix(scope): …`).

## 8. Review

- `code-review` at `medium` on `main...HEAD`. Add `security-review` when the branch touches `apps/api/src/wallet/*`,
  cascade validation, an HTTP endpoint, LLM input/output, NEP-413, 1Click, secrets or `deploy/`.
- A fresh subagent with no context of the change verifies the findings and tries to break the code.
- Fix or answer each finding, re-run step 7, commit.

## 9. PR and merge

- `git push -u origin HEAD`, then `gh pr create`: title = the main commit's message, body = why (one or two
  sentences), what changed (facts from the diff), verification, the "Testing" list with each step marked passed /
  waiting for owner / after deploy, `Closes #<N>`.
- Watch CI in the background (`gh pr checks <pr> --watch`). Red: fix in the same branch.
- Green and no `[local, owner]` step: `gh pr merge --squash --delete-branch`, then `ExitWorktree` with `keep`,
  `git worktree remove <path>`, `git checkout main && git pull`.
- Green but `[local, owner]` steps remain: do not merge. Comment them on the PR with the PR number for
  `gh pr checkout` (`docs/TESTING.md`), tell the owner, and stop. Merge only after the owner confirms they pass; a
  failure is fixed in the same branch first. `[live]` steps never block the merge.

## 10. Report

- Comment on the issue: what changed, what was verified, what was not, which skills ran, and the `[live]` /
  `[live, owner]` / `[owner]` steps still open.
- Merge does not deploy. If the issue has `[live]` steps, say "needs a deploy: run `/deploy`"; the `deploy` skill
  runs and ticks the `[live]` steps after deploying.
- New work found on the way becomes a new issue (template: Goal / Done when / Testing / README / Depends on) in the right
  milestone with labels; never scope creep in this PR.
- Tell the owner: the PR link, whether a deploy is needed, their remaining `owner` steps, what comes next.
