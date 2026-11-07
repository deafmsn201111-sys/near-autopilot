# Roadmap

**Goal: a user should not have to trust their agent. They trust the rules they set for it, and the agent cannot
break those rules.**

Today those rules are enforced by the autopilot's own code: a 12-check policy, a gateway that re-checks the stored
verdict, and a hash-chained audit trail that can be replayed. The roadmap moves enforcement step by step out of the
agent: first into the user's wallet, then onto the chain. The end goal is a trust layer that any agent can use.

## Where the project is now

- Mainnet is read-only. There is no mainnet signer, and no transaction has been sent from this repository on any
  network.
- Each cycle runs: snapshot → agents → plan → policy verdict (stored) → Shadow Gateway (dry run, route recorded) →
  audit chain.
- Evidence anyone can check: `audit:verify`, `audit:replay`, the attack demo, and the thesis tested against
  collected mainnet data.
- Known gaps are listed in [README.md § Honest limitations](README.md#honest-limitations) and
  [docs/orchestrator.md §13](docs/orchestrator.md).

**One constraint shapes the plan.** On NEAR, a function-call access key cannot attach a deposit. Every token action
(`ft_transfer_call`: swap, repay, supply) attaches 1 yoctoNEAR. So an agent holding a restricted key cannot perform
them, and the key guard (`packages/tx-execution/src/key-guard.ts`) states this outright. That leaves two honest routes
to execution: the user approves each action in their own wallet, or a guard contract owned by the user enforces the
rules on-chain.

## Phase 1: hardening

Close the gaps that block any real use.

- ~~Durable orchestrator stores (idempotency, control) in Postgres~~ **done** (migration 0013: restart- and race-safe,
  audited mode changes; see docs/orchestrator.md §13).
- ~~Portfolio-first dashboard: actions with costs, plain-language activity, research~~ **done** (docs/dashboard.md).
- ~~Net yield for Burrow supply~~ **done**; ~~a looping strategy~~ **done** (simulation; the autopilot cannot borrow).
- DCL pools in the analytics and the LP simulation, once the fee and position data are sufficient (`UNSUPPORTED`
  today).
- ~~Thesis survivorship correction, split by pool type, gross vs net~~ **done** (union of start and end rankings).
- ~~Signed audit checkpoints outside the database~~ **done** (docs/audit-evidence.md); on-chain anchoring stays in Phase 3.
- An approval UI for `requires_approval` proposals. Reconciliation for actions that never resolved.
- The pre-mainnet checklist in [docs/security.md](docs/security.md#pre-mainnet-checklist).
- First real testnet transactions, each one approved separately, to confirm the on-chain effect of the Burrow and Rhea
  payloads (unverified today).
- An LP position reader and DCL fee APRs, so the LP Optimizer has data to work with.
- An external security review.

## Phase 2: a personal autopilot where the agent holds no key

The safest product, and the quickest to put in front of users.

- The agent proposes an action. The user sees the verdict with all 12 checks and the reasons, then signs in their own
  wallet (HOT Connector (@hot-labs/near-connect)). The autopilot never holds a key.
- Notifications (Telegram, push) carry the proposal and the reasons behind it, for example: "health factor 1.32 and
  falling; proposing a $40 repay".
- The user edits their policy (limits, budget, allowlists, minimum balance) in the UI. Every change is audited.
- Several accounts per user.

## Phase 3: limited autonomy, with the rules on-chain

- A guard contract per user. It holds the policy (per-action and daily limits, allowlisted protocols and recipients,
  minimum balance) and executes only what fits it. The agent's restricted key can call only the guard.
- A compromised agent then cannot step outside rules the user wrote on-chain.
- Periodically anchor the audit chain head hash on NEAR. This closes a known gap: today, deleting the latest audit
  entries cannot be detected (docs/orchestrator.md §13, item 12).
- Requires its own audit and a testnet period before mainnet. The contract design (deposits, token callbacks,
  upgrades) has to be validated against NEAR's account and access-key model first.

## Phase 4: a trust layer for any agent

Turn the policy and evidence core into a service that any agent can call: an MCP server or an agent skill.

- Tools such as `evaluate_plan`, `explain_verdict`, `verify_audit` and `replay_verdict`.
- Any agent can use them: a general assistant, an agent on NEAR AI, a custom bot. The user owns the policy, and the
  agent can only read it.
- The same guarantees as today: a stored verdict, a matching plan hash, an append-only chain.
- This turns the project from one more autopilot into infrastructure for other agents.

## Phase 5: wider coverage

- More protocols, multi-hop routing, and execution through NEAR Intents (used for quotes today).
- Cross-protocol risk: today, risk is computed for the Burrow position only.
- Running the agent in a trusted execution environment (e.g. NEAR AI Shade Agents), so a user can verify which code
  made a decision. Feasibility to be evaluated.

## What does not change

- Every action needs a stored verdict, and the plan must match it by hash.
- Every decision is audited, and every verdict can be replayed.
- Synthetic data is always labelled; a fixture is never presented as market or chain data.
- Mainnet stays read-only until the phase that changes this has passed review. A change to the default limits is
  made openly and recorded in the audit trail.
