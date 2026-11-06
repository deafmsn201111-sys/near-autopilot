# Demo script

A 3–4 minute walkthrough of NEAR Autopilot. **Main point: the autopilot decides on its own, and anyone can check each
decision.** Every action passes a 12-check policy and a gateway that re-checks the stored verdict. Each step lands in a
hash-chained audit trail, and every stored verdict can be recomputed. Mainnet is only ever read.

Everything below runs on a local stack started by `./scripts/quickstart.sh`. Nothing is signed or sent.

## Before recording

- Start the stack 10–15 minutes ahead, so the mainnet collector has run a few cycles and the market pages are fresh.
- One theme (light or dark), browser zoom 125%, notifications off, unrelated tabs closed.
- Never show `.env`, shell history, or a `curl` with an `Authorization` header. The commands below run inside the
  containers, so no token appears on screen.
- Speed up the image build and the wait for `healthy` in editing.

## Scenes

| #   | Time      | Screen                                    | Show                                                                                          |
| --- | --------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | 0:00–0:15 | title card                                | The problem                                                                                   |
| 2   | 0:15–0:35 | terminal                                  | `git clone …`, `./scripts/quickstart.sh`, the "Ready" banner                                  |
| 3   | 0:35–1:05 | `:3001` Overview → Rhea → Burrow → Prices | Live mainnet data; hover a token symbol (contract, NearBlocks link); price sources and quorum |
| 4   | 1:05–1:40 | `:3004` Activity                          | Run a cycle on the simulated demo portfolio; the repay proposal is `dry_run`, no tx hash      |
| 5   | 1:40–2:20 | `:3001` Policy decisions + terminal       | The 12 checks of one verdict; real BLOCKs on shadow mainnet; the attack demo                  |
| 6   | 2:20–2:40 | `:3001` Execution routes                  | Rhea vs 1Click quotes for an allowed plan, `executed: false`                                  |
| 7   | 2:40–3:05 | `:3001` Audit trail + terminal            | Chains intact (`verify`), verdicts recomputed (`replay`)                                      |
| 8   | 3:05–3:30 | `:3001` Investment thesis                 | Verdict, the falsification rules, the weakest hypothesis                                      |
| 9   | 3:30–3:45 | title card                                | The security model, link to the repo                                                          |

### 1. The problem

> "An autonomous DeFi agent that holds your keys is a single point of failure: one prompt injection, one bad price,
> and the funds are gone. NEAR Autopilot makes every decision of its agent checkable."

### 2. From a fresh clone

```bash
git clone <repository> near-autopilot && cd near-autopilot
./scripts/quickstart.sh
```

> "Docker only. No API key, no wallet. Under four minutes from a clean clone to running dashboards."

### 3. Real mainnet data, read-only

Open `http://127.0.0.1:3001`. Click through Overview, Rhea pools, Burrow markets and Prices. Hover a token symbol to
show its contract, and open one NearBlocks link.

> "This is live NEAR mainnet: Rhea pools, Burrow markets, prices from several sources with a quorum. Mainnet is read
> with view calls only. A price older than 180 seconds is not used."

### 4. One autopilot cycle

Open `http://127.0.0.1:3004/activity` and press **Run a check now**. Show the `lending.repay` proposal with status `dry_run` and no
transaction hash. **Point at the provenance banner (simulation, demo portfolio) and say it:**

> "This portfolio is simulated: synthetic balances on a simulated chain. The health guardian sees the health factor
> near its threshold and proposes a repayment. The plan passed policy, and it is a dry run: no transaction exists."

### 5. Policy: what is allowed, what is blocked

On `:3001/policy`, open one verdict and show its 12 checks. Then filter to **BLOCK** and show a row labelled **Shadow mainnet**: the
simulated portfolio analysed on real mainnet prices proposes actions of $128–290, and `value_limits` (max $100) blocks
them.

Then the attack demo, in a terminal:

```bash
docker compose exec api node --import tsx src/demo/attack-main.ts --out /tmp/demo-attack.log.jsonl
```

Results (also committed in [`docs/evidence/demo-attack.log.jsonl`](docs/evidence/demo-attack.log.jsonl)):

| Attack                              | Stopped by              | Result    |
| ----------------------------------- | ----------------------- | --------- |
| Legitimate $40 repay, fair $30 swap | (controls)              | ALLOWED   |
| Prompt injection: transfer          | agent-output parser     | DISCARDED |
| Prompt injection: impersonation     | agent-output parser     | DISCARDED |
| Foreign recipient                   | policy                  | BLOCKED   |
| Extra Withdraw in the Burrow msg    | policy                  | BLOCKED   |
| Stale oracle price                  | policy                  | BLOCKED   |
| Thin pool                           | policy                  | BLOCKED   |
| Forged approval                     | Shadow Gateway          | REFUSED   |
| Full-access signing key             | live executor key guard | REFUSED   |

> "These are labelled fixtures, not market data. Each attack fails exactly the check it targets, and the two
> legitimate actions pass. So the policy does not simply block everything. The agent was fooled, and the money did
> not move."

Do **not** add `--persist`: it would write the fixtures into the permanent audit chain.

### 6. Execution routes

On `:3001/routes`, show a recorded route: the gateway compares a Rhea quote with a 1Click quote for an allowed plan.

> "The gateway only acts on a stored ALLOW whose plan hash matches. It picks a route and records it. `executed: false`:
> nothing was sent."

### 7. Audit trail

On `:3001/audit`, show the chains and their verification status. Then in a terminal:

```bash
docker compose exec api node --import tsx src/evidence/cli.ts verify
docker compose exec api node --import tsx src/evidence/cli.ts replay
```

> "Every entry is hash-chained to the previous one, and the table is append-only. Changing a single entry breaks the
> chain at that entry. Replay recomputes each stored verdict from its stored inputs and gets the same answer."

Do not tamper with the running database for the video. The end-to-end test does it on a throwaway database
(`apps/api/test/e2e.integration.test.ts`): if needed, show its passing output.

### 8. Investment thesis

On `:3001/thesis`, show the verdict, the falsification rules and the weakest hypothesis (H3).

> "The thesis states in advance what would prove it wrong, and is tested against collected mainnet data. Here is its
> weakest part."

### 9. Security model

> "Mainnet is read-only, and there is no mainnet signer. Live execution on mainnet refuses to start. A full-access key
> is refused. Everything you saw is reproducible from the repository."

## What not to claim

- No transaction has been sent from this project on any network. Do not say or imply otherwise.
- The demo portfolio is simulated. There are no real funds, and the project has earned no yield.
- 1Click is used for quotes only.
- Without API keys, Pyth is skipped and cycles are marked `partial` (see README).

See [docs/security.md](docs/security.md), [docs/shadow-gateway.md](docs/shadow-gateway.md),
[docs/audit-evidence.md](docs/audit-evidence.md) and [THESIS.md](THESIS.md) for the details behind each scene.
