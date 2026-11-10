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

## When code reaches near-autopilot.tech

Only after a manual deploy by the owner: merge alone changes nothing on the site. Steps: `deploy/public/README.md`,
section "Update" (build a new bundle from `main`, copy it to the server, carry `.env` and `checkpoints/` over, run
`./setup.sh`). `[live]` steps are checked after that.
