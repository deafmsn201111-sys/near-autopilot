# Manual testing

Every issue has a **Testing** list: steps a person does and what they see. Each step starts with a tag that says
where it runs and who runs it.

| Tag              | Where                                          | When                          | Who                    |
| ---------------- | ---------------------------------------------- | ----------------------------- | ---------------------- |
| `[local]`        | the PR branch running on your computer         | before merge                  | Claude, in the browser |
| `[local, owner]` | the PR branch running on your computer         | before merge, blocks merge    | the owner              |
| `[live]`         | https://near-autopilot.tech                    | after merge and deploy        | Claude                 |
| `[live, owner]`  | https://near-autopilot.tech                    | after merge and deploy        | the owner              |
| `[owner]`        | outside the site: wallet app, consoles, server | whenever the step makes sense | the owner              |

`owner` steps need a person: a real wallet, signing, a phone, a paid console, the server.

## Run a PR branch locally

Needs Docker Desktop running and the GitHub CLI (`gh`).

```bash
cd near-autopilot
gh pr checkout <PR number>      # switches to the PR's code
./scripts/quickstart.sh         # builds and starts everything; first run takes ~6 minutes
```

Open http://127.0.0.1:3001: this is the same site as near-autopilot.tech, running on your machine with the PR's
code. Mainnet is read for real; nothing is signed unless you sign it in your wallet.

When done:

```bash
docker compose down             # stops the local site
git checkout main && git pull   # back to main
```

### Two local stacks at once (parallel worktrees)

Each checkout gets its own containers, data and images: Compose names them after the folder, and
`quickstart.sh` tags the images with the folder name too, so a rebuild in one worktree never changes what another
runs. Give the second stack free ports in its `.env` (or the shell):

```bash
ANALYTICS_DASHBOARD_PORT=3011 ANALYTICS_ADMIN_PORT=3012 ANALYTICS_API_HOST_PORT=4013 POSTGRES_HOST_PORT=5442 \
  ./scripts/quickstart.sh
```

- Plain `docker compose up` (without `quickstart.sh`) uses the shared `:local` tag; run it with
  `IMAGE_TAG=<folder name>` to keep the stack's own images.
- Cookies for `127.0.0.1` are shared across ports: a wallet connection and ownership proof made on one local stack
  show up on every other. Disconnect, or use a separate browser profile, when that matters.

## When code reaches near-autopilot.tech

Only after a deploy: merge alone changes nothing on the site. Deploy with `/deploy` in Claude Code (from the main
checkout, needs SSH access to the server as host `near-autopilot`). It builds the bundle from `main`, uploads it,
carries `.env` over, restarts, checks health, rolls back on failure, and then runs the open `[live]` steps. Manual
steps: `deploy/public/README.md`, section "Update".
