---
name: start-issue
description: Start work on a GitHub issue of this repo — creates a worktree with a fresh branch from main and switches the session into it. Use when the user says "start issue #N", "take ticket N", "/start-issue N".
---

1. Run `scripts/start-issue.sh <N>` from the repo root. It creates `.claude/worktrees/<N>-<slug>` on branch
   `feat/<N>-<slug>` (`fix/` for `bug` issues) from fresh `origin/main`, copies `.worktreeinclude` files, runs
   `pnpm install`, assigns the issue and moves it to In Progress on the board. The last stdout line is the worktree
   path. Re-running for the same issue just prints the existing path.
2. Call `EnterWorktree` with `path` set to that path.
3. Read the issue (`gh issue view <N>`) and work from its "Done when" list.
4. The PR body must contain `Closes #<N>`.
