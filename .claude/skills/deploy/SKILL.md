---
name: deploy
description: Deploy the current main of NEAR Autopilot to near-autopilot.tech — build the bundle, upload it, carry .env and checkpoints over, restart, check health, then run the open [live] Testing steps. Use when the user says "/deploy", "deploy", "выкати", "задеплой" or asks to update the live site.
---

# Deploy — main to near-autopilot.tech

Automates "Update" in `deploy/public/README.md`. Invoking `/deploy` is the owner's go-ahead; do not ask again. Talk
to the owner in Russian, short. Never print, cat or copy `.env` anywhere except server-side `cp`.

## 1. Preconditions — stop and say what is missing

- Run from the main checkout: on `main`, clean tree, `git pull` done. Never deploy a branch.
- CI green on that commit: `gh run list --branch main --workflow ci.yml --limit 1` shows `success` for `HEAD`.
- Docker is running locally (`docker info`).
- `ssh near-autopilot true` works. The host alias lives only in the owner's `~/.ssh/config`, never in the repo. If it
  fails, give the owner this and stop:
  ```
  Host near-autopilot
    HostName <server IP>
    User <ssh user>
  ```

## 2. What changes

- Current deploy dir on the server: `ssh near-autopilot docker compose ls --format json` → the `ConfigFiles` path of
  project `near-autopilot-public`; its directory is `OLD`. Deployed commit: `ssh near-autopilot cat OLD/VERSION`.
- Same commit as `HEAD` → say "already deployed" and stop.
- Show `git log --oneline <deployed>..HEAD` in one block, then go on.

## 3. Build and upload

- Platform from `ssh near-autopilot uname -m`: `x86_64` → `linux/amd64`, `aarch64` → `linux/arm64`.
- `deploy/public/build-bundle.sh <platform>` (several minutes; run in background). It refuses images with secrets in
  them: if it does, stop and report.
- `scp deploy/public/dist/near-autopilot-public-<sha>.tar.gz near-autopilot:`

## 4. Switch

One `ssh near-autopilot` with `set -e`:

```bash
tar xzf near-autopilot-public-<sha>.tar.gz
cp -p OLD/.env near-autopilot-public-<sha>/.env
cp -a OLD/checkpoints near-autopilot-public-<sha>/ 2>/dev/null || true
cd near-autopilot-public-<sha> && ./setup.sh
```

`.env` must be copied before `setup.sh`: without it, `setup.sh` creates a new database password that does not match
the kept database. The compose project name is fixed, so the database volume carries over.

## 5. Check — roll back on failure

- Within 5 minutes `docker compose ps` in the new dir shows every service `healthy`.
- `curl -fsS -o /dev/null -w '%{http_code}' https://near-autopilot.tech` is `200`.
- Failure: roll back with `ssh near-autopilot 'cd OLD && ./setup.sh'` (it reloads the old images), show the failing
  service's last 50 log lines (`docker compose logs --tail 50 <service>`), and stop.
- Success: keep `OLD` for rollback; delete older `near-autopilot-public-*` dirs and all `*.tar.gz` on the server, and
  `deploy/public/dist/*` locally.

## 6. Live Testing steps

- Find closed issues with unticked live steps: `gh issue list --state closed --limit 50 --json number,body` and keep
  those whose body has `- [ ] [live`.
- Run each `[live]` step on https://near-autopilot.tech with `claude-in-chrome`, screenshot the result, tick it with
  `gh issue edit`. A failing step becomes a new `bug` issue linked to the original.
- `[live, owner]` steps: list them for the owner by issue.

## 7. Report

Deployed commit, what changed (one line per merged PR), health result, `[live]` steps passed / failed, and the
`[live, owner]` steps left for the owner.
