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
- **A cut-off model call is booked at its worst case.** A call ended by the deadline or by the visitor leaving reports no
  usage, so the ledger books ~$0.010 (GLM 5.3 Flash) where a whole run costs ~$0.0003. Safe for the cap, but admin spend overstates. → #183.
- **A failed HOT bridge swap may refund to the HOT balance.** A deposit through HOT's popup (D42) between different
  tokens that fails can be refunded to the user's HOT intents balance. The portfolio shows that balance (#265) but
  cannot bring it to NEAR: the user withdraws it in HOT Wallet. 1:1 deposits arrive or refund on the origin chain.
- **Other-chain balances are read when a wallet connects.** HOT Kit fetches them on connect (and the bridge refreshes
  its own); after a deposit made elsewhere the "+ $X on other chains" line stays as it was until a reload. (#265)

- **The last good read lives in one web process.** A stale view after a failed read (#256) comes from memory: a
  restart or a second instance has nothing to show and falls back to the plain error. A shared store if we scale out.
- **The public demo account's AI analysis is its owner's last saved run** (#24). Everyone sees it, and it can be older
  than the account's current positions; the panel says when it was made.
- **Saved analyses are encrypted at rest only** (#278). The key lives on the same host as the database, so a
  compromised host can read them; rotating the key drops every saved analysis.

## Accepted after the security audit (#142)

Not exploitable today: the LLM only proposes, and its output goes through the same builders and `validateCascade`.

- **One actor can use up the daily LLM budget.** The cap holds and fails closed, but a few new NEAR accounts with
  rotating IPs can spend `LLM_DAILY_CAP_USD` for everyone; there is no per-account limit or account-age check.
- **The per-kind quota in `apps/analytics/lib/rate-limit.ts` is global.** About 20 IPs can use it up for everyone.
- **Dependencies:** `drizzle-orm` 0.38 (the advisory needs `sql.raw`, used only in tests) and `vitest` 2 (dev only)
  are not upgraded. `pnpm audit --prod` reports 15 high, through `@hot-labs/kit` (protobufjs, toml, zod), `next`
  (postcss, build time) and drizzle; none reaches a request path we found. Request bodies are capped by Fastify's 1 MiB default.

## Watch list (external)

- Burrow/Rhea schema drift: adapters parse strictly and fail to `degraded`, never to made-up data.
- Pyth staleness/confidence. NEAR RPC rate limits. DefiLlama yield staleness.
- The public server is small (one VM): heavy builds run in CI, not on the box.
- Migrations are additive only; the live database is never reset.
