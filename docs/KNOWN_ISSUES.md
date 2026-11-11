# KNOWN_ISSUES

_Known limitations and defects, honestly stated (brief §3.3, §23). Not a roadmap — see `HACKATHON_PLAN.md` for planned work._

## Honest limitations (not bugs, by design today)

- **LLM only ranks and explains.** On a connected wallet the central LLM calls the deterministic agents as tools (architecture C, D12); it computes nothing. `LlmAgent` (an LLM as a proposal agent) is still not wired. No "AI confidence" exists.
- **LLM analysis has no ownership check or spend cap yet.** Until #20 (NEP-413) and #21 (daily spend cap) are merged, `ANTHROPIC_API_KEY` stays off the public server.
- **No autonomous execution.** `loadSigner()` is null; dry-run only. Mainnet execution requires the (unbuilt) Guard contract + review.
- **Owner-signs path is branch-only.** `feat/mainnet-wallet-confirm` is local, never pushed/merged.
- **Single-operator model.** No per-user accounts/policies/sessions yet.
- **Demo portfolios are simulated** (balances), valued at live prices; labelled as such.

## Defects / tech debt to address

- **A demo portfolio's read-only mode has no switch back** (#13 removed `/v1/control/mode`). The orchestrator tightens
  a demo scope to `read_only` on its own (an in-doubt execution after a crash, 3 rejected dry runs in a row, an audit
  write failure) and the mode survives restarts. Rare; undo by hand:
  `UPDATE orchestrator_control SET mode = 'normal' WHERE scope = '<scope>';` (scope shown on `/activity`).
- **Duplicated risk logic:** 3 health-factor implementations (`financial-engine/lending.ts` float, `financial-engine/risk.ts` WAD, `burrow-adapter/risk.ts` USD18) + 2 guardians/2 rebalancers. Risk of divergence. → `T2.1`.
- **No uniform provenance tagging** across all financial values. → `T1.1/T1.2`.
- **Opportunity comparison** lacks a formal, documented, configurable score. → `T2.3`.
- **UX flows** flagged by owner as "not usable" (beyond theme). → `T4.1`.
- **Guard/contract absent** → autonomy hard-blocked. → `T5.1`.
- **CI has no Rust/contract job** (will be needed once `contracts/` lands). → `T5.2`.

## Watch list (external)

- Burrow/Rhea schema drift. Pyth staleness/confidence. NEAR RPC rate limits. DefiLlama yield staleness.
