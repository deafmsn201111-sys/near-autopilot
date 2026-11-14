# KNOWN_ISSUES

_Known limitations and defects, honestly stated (brief §3.3, §23). Not a roadmap — see `HACKATHON_PLAN.md` for planned work._

## Honest limitations (not bugs, by design today)

- **LLM only ranks and explains.** On a connected wallet the central LLM calls the deterministic agents as tools (architecture C, D13); it computes nothing. `LlmAgent` (an LLM as a proposal agent) is still not wired. No "AI confidence" exists.
- **The LLM spend cap is per UTC day and held in one process.** Each model call in flight holds one worst-case call (≈ $0.012 on Haiku 5.5) against the cap in memory, which works because the analytics API runs as one process; a second replica would need a reservation row. A call aborted on the deadline is recorded at its worst case, and a request that could pass 100K input tokens is never sent. `ANTHROPIC_API_KEY` is on the public server (only in `analytics-api`), capped by `LLM_DAILY_CAP_USD`; live since `85f628b` (#72).
- **No autonomous execution.** `loadSigner()` is null; dry-run only. Mainnet execution requires the (unbuilt) Guard contract + review.
- **Owner-signs path is branch-only.** `feat/mainnet-wallet-confirm` is local, never pushed/merged.
- **Single-operator model.** No per-user accounts/policies/sessions yet.
- **Demo portfolios are simulated** (balances), valued at live prices; labelled as such.

## Defects / tech debt to address

- **A demo portfolio's read-only mode has no switch back** (#13 removed `/v1/control/mode`). The orchestrator tightens
  a demo scope to `read_only` on its own (an in-doubt execution after a crash, 3 rejected dry runs in a row, an audit
  write failure) and the mode survives restarts. Rare; undo by hand:
  `UPDATE orchestrator_control SET mode = 'normal' WHERE scope = '<scope>';` (scope = `demo-500` or `demo-5000`).
- **The strategy preset is remembered per browser only** (one cookie for the last 20 accounts, #25). Another device or a cleared
  browser falls back to Balanced. → #100 (server-side per-account settings, written by the proven owner).
- **Duplicated risk logic:** 3 health-factor implementations (`financial-engine/lending.ts` float, `financial-engine/risk.ts` WAD, `burrow-adapter/risk.ts` USD18) + 2 guardians/2 rebalancers. Risk of divergence. → `T2.1`.
- **No uniform provenance tagging** across all financial values. → `T1.1/T1.2`.
- **Opportunity comparison** lacks a formal, documented, configurable score. → `T2.3`.
- **UX flows** flagged by owner as "not usable" (beyond theme). → `T4.1`.
- **Guard/contract absent** → autonomy hard-blocked. → `T5.1`.
- **CI has no Rust/contract job** (will be needed once `contracts/` lands). → `T5.2`.
- **A cut-off model call is booked at its worst case.** A call ended by the deadline or by the visitor leaving reports no
  usage, so the ledger books ~$0.012 (Haiku) where a whole run costs ~$0.0006. Safe for the cap, but admin spend overstates. → #183.

## Watch list (external)

- Burrow/Rhea schema drift. Pyth staleness/confidence. NEAR RPC rate limits. DefiLlama yield staleness.
