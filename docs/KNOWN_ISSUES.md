# KNOWN_ISSUES

_Known limitations and defects, honestly stated (brief §3.3, §23). Not a roadmap — see `HACKATHON_PLAN.md` for planned work._

## Honest limitations (not bugs, by design today)

- **LLM only ranks and explains.** On a connected wallet the central LLM calls the deterministic agents as tools (architecture C, D13); it computes nothing. `LlmAgent` (an LLM as a proposal agent) is still not wired. No "AI confidence" exists.
- **The LLM spend cap is per UTC day and held in one process.** Each model call in flight holds one worst-case call (≈ $0.010 on GLM 5.3 Flash) against the cap in memory, which works because the analytics API runs as one process; a second replica would need a reservation row. A call aborted on the deadline is recorded at its worst case, and a request that could pass 100K input tokens is never sent. `NEAR_AI_API_KEY` is on the public server (only in `analytics-api`), capped by `LLM_DAILY_CAP_USD` (#72, #232).
- **The TEE hardware quote is not checked in our code.** Every reply's signature is checked against the attested key (D43, #233), but the Intel TDX quote (DCAP), the RTMR3 event-log replay, MRCONFIGID and the NVIDIA evidence are left to the official `nearai/nearai-cloud-verifier`. Instances of a model share one key, so a matching signer does not prove the same serving instance. The mark opens each reply in NEAR AI's Verification Center, which does check the hardware evidence, but that runs in the user's browser, not on our server.
- **No autonomous execution, by design.** The server holds no key and never signs (D8, D9). Every real transaction is
  an unsigned cascade that passes `validateCascade` and is signed by the user in their own wallet.
- **Single-operator model.** No per-user accounts/policies/sessions yet.
- **Demo portfolios are simulated** (balances), valued at live prices; labelled as such.
- **Rhea limit orders are shown, not managed.** Open DCL limit orders are portfolio rows with their price; there is no
  advice and no cancel button (it would add `cancel_order` to the cascade allowlist). → #223.
- **A multi-step cascade is one wallet prompt per step.** Each step is confirmed on NEAR before the next is offered,
  so a failed step stops the rest. One approval for the whole cascade (`signAndSendTransactions`) is after the
  hackathon. An all-or-nothing cascade across contracts is not possible on NEAR. → #230.

## Defects / tech debt to address

- **A demo portfolio's read-only mode has no switch back** (#13 removed `/v1/control/mode`). The orchestrator tightens
  a demo scope to `read_only` on its own (an in-doubt execution after a crash, 3 rejected dry runs in a row, an audit
  write failure) and the mode survives restarts. Rare; undo by hand:
  `UPDATE orchestrator_control SET mode = 'normal' WHERE scope = '<scope>';` (scope = `demo-500` or `demo-5000`).
- **The strategy preset is remembered per browser only** (one cookie for the last 20 accounts, #25). Another device or a cleared
  browser falls back to Balanced. → #100 (server-side per-account settings, written by the proven owner).
- **Fee-on-transfer is checked on Solana only** (#185, D32): an EVM token that takes a fee on transfer is still offered.
  Solana mints are read from `SOLANA_RPC_URL` (public mainnet RPC by default); while it has never answered, Solana
  tokens other than SOL are not offered.
- **Duplicated risk logic:** 3 health-factor implementations (`financial-engine/lending.ts` float, `financial-engine/risk.ts` WAD, `burrow-adapter/risk.ts` USD18) + 2 guardians/2 rebalancers. Risk of divergence.
- **Opportunity comparison** lacks a formal, documented, configurable score.
- **Wallet button after a cancelled sign-in.** A cancelled NEAR sign-in leaves near-connect's `selected-wallet`, so
  the kit loads on every later page; a sign-in finished after the kit's list was closed shows the account but does not
  open the portfolio. → #236.
- **A cut-off model call is booked at its worst case.** A call ended by the deadline or by the visitor leaving reports no
  usage, so the ledger books ~$0.012 (Haiku) where a whole run costs ~$0.0006. Safe for the cap, but admin spend overstates. → #183.
- **A failed HOT bridge swap may refund to the HOT balance.** A deposit through HOT's popup (D42) between different
  tokens that fails can be refunded to the user's HOT intents balance. The portfolio shows that balance (#265) but
  cannot bring it to NEAR: the user withdraws it in HOT Wallet. 1:1 deposits arrive or refund on the origin chain.
- **Other-chain balances are read when a wallet connects.** HOT Kit fetches them on connect (and the bridge refreshes
  its own); after a deposit made elsewhere the "+ $X on other chains" line stays as it was until a reload. (#265)

- **The last good read lives in one web process.** A stale view after a failed read (#256) comes from memory: a
  restart or a second instance has nothing to show and falls back to the plain error. A shared store if we scale out.

## Watch list (external)

- Burrow/Rhea schema drift: adapters parse strictly and fail to `degraded`, never to made-up data.
- Pyth staleness/confidence. NEAR RPC rate limits. DefiLlama yield staleness.
- The public server is small (one VM): heavy builds run in CI, not on the box.
- Migrations are additive only; the live database is never reset.
