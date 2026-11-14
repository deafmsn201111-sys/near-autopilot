# Hackathon plan — 11–14 Nov 2026

Deadline: **14 Nov 23:59 UTC**. Deliverables: public repo, live demo URL, X post with a video. AI judges compare the
README against the actual behaviour, so every claim in the README must be true and checkable.

Owners are assigned during the work; every task below is unassigned on purpose.

## Product in one paragraph

AI DeFi analyst for NEAR mainnet. The user connects a wallet and picks a strategy (conservative / balanced /
aggressive). A central LLM calls deterministic agents as tools, then returns ranked recommendations with numbers. One
click builds an exact unsigned transaction cascade, which the user signs in their own wallet. Through 1Click the user
can fund the portfolio from other chains. No autonomy: the server never holds a key and never signs.

## Decisions

| #               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core            | **Architecture C**: central LLM + existing `packages/orchestrator` agents exposed as tools + deterministic engine. The LLM ranks and explains; code computes every number. Output goes zod → prepare → `validateCascade`. On LLM failure, fall back to heuristic recommendations (labelled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Model           | **GLM 5.3 Flash on NEAR AI Cloud private inference (TEE)** (#232, D35; replaces Haiku 5.5 of D17). One allowlisted model, no fallback to a non-TEE model; at the daily cap or on any failure the analysis falls back to labelled heuristics. Prepaid NEAR AI Cloud credits. Each reply is signed in the enclave; verifying it is #233.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Strategy        | Three presets change thresholds in code (health-factor watch/target, concentration) in both the heuristics and the agent config, and go into the LLM prompt. No min-APR threshold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1Click          | **Inbound deposit only**: server-side real quote, verified against the request, stored server-side; UI gets an id + read-only fields; user-entered refund address with per-chain format check; deposit address + chain + deadline + QR; status polling (1Click keys status by deposit address; the server maps our id to it). Chains: EVM (ETH, Base, Arbitrum), Solana, BTC; no memo chains. Optional `ONE_CLICK_JWT` (without it 1Click adds 0.25%); the fee is shown in the UI. The refund address is entered before the quote and checked on the server too. No NEAR transaction is built, so the cascade allowlist is untouched. Keep `dryQuote` in `gateway/one-click.ts` exactly as is. Record in `DECISIONS.md`. Execution via EVM wallet connect → roadmap. Swaps stay on Rhea. |
| LLM access      | LLM analysis only for a wallet that proved ownership with a **NEP-413** signed message. Any other account and the demo portfolios get heuristics + a cached LLM example.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Demo portfolios | Keep the $5k / $500 simulated portfolios as the "try without a wallet" path for judges; how judges see the LLM without a wallet is decided by the owners by end of 12 Nov; default: a cached AI analysis of a real public demo wallet, refreshed every N minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Removal         | Delete autopilot entirely: `/autopilot` page, `/v1/control/*`, `/v1/runs`, `signer.ts`, autopilot-config, `config/autopilot*.json`, `apps/dashboard`. Delete all testnet code, scripts and docs. Delete `PUBLIC_DEMO`; signing is controlled only by `MAINNET_WALLET_SIGNING`. Keep the collector and the orchestrator agents. If a removal drags deeper than 2–3 h, stop and re-plan.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Signing         | Enabled on the public site (`MAINNET_WALLET_SIGNING=1`). Cascade caps stay (0.15 NEAR per action, 0.3 per cascade). Record in `DECISIONS.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Admin           | `/admin` in `apps/analytics`, enabled only by `ADMIN_UI=1` on a second container bound to `127.0.0.1`; reached through an SSH tunnel. Public site returns 404 for `/admin`. No auth code. Admin write endpoints accept only `ADMIN_API_TOKEN`, which only the admin container holds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Privacy         | Store `accountId` (public on-chain). Never store IPs. LLM prompts/responses kept 7 days. README has a "what we log" line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Hosting         | VPS via existing `deploy/public/` + a real domain (in README and the X post).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Process         | Code until the deadline. Every PR that changes behaviour updates the README in the same PR. Video and post are made at the end.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Security — mandatory before the public link is posted

1. Rate-limit `/api/prepare`; require `content-type: application/json`.
2. LLM cost: NEP-413 gate, per-IP and global limits, hard daily spend cap that fails closed (falls back to Haiku, then
   heuristics), `max_tokens`, cache keyed by the server-computed portfolio hash.
3. LLM injection: send only numbers and allowlisted token ids (symbols from our own list), zod on output, allowlist
   tokens and pools, and restrict `add_liquidity` to allowlisted pools.
4. 1Click: server-only real quotes over a hard-coded base URL; verify `amountIn`, assets, `recipient`, `refundTo`
   against the request; JWT stays server-side and is never logged.
5. 1Click: user-entered refund address, format-checked per chain, shown before the deposit address.
6. Real domain, strict CSP (Next + Caddy), generic error messages (log details, don't return them).
7. Bounded in-memory caches (account cache, limiter map), polling limits and stop at deadline, firewall (SSH +
   80/443), `chmod 600 .env`, container restart policy. New secrets only go to the containers that need them.

## Schedule

Status lives in GitHub issues (one issue = one branch = one PR, `Closes #N`), written to
`.github/ISSUE_TEMPLATE/task.md`. The order of work is the `Order:` line in each milestone's description; the
milestone page shows the same order. `/ticket` with no argument takes the next one from there.

| Milestone           | Target (UTC)        | What                                                                                                             |
| ------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **M1 Safe to open** | end of 12 Nov       | Everything needed before the link is shared and the LLM key goes to production                                   |
| **M2 Demo works**   | end of 13 Nov       | Everything a judge walks through by hand                                                                         |
| **M3 Full scope**   | 13–14 Nov           | 1Click, admin screens 2–4, events, LP re-centre, cross-token unwind; parallel with M2 where files do not overlap |
| **M4 Submission**   | 14 Nov, fixed hours | Docs and README from 12:00, video by 18:00, post and submission by 21:00. Starts on the clock even if M3 is open |

Bugs found on the live site go into M1 (safety, wrong numbers shown to everyone) or M2 (demo flow), at the right place
in the `Order:` line.

## Admin screens

1. **Spend**: $ today vs daily cap, $ per day for 7 days, Haiku/Sonnet split, average cost per analysis, deposit
   run-out forecast.
2. **Funnel**: connects → analyses → cascades built → transactions signed, per day; unique wallets.
3. **LLM quality**: fallback and validation-error rate, p50/p95 latency, top recommendation types, last 20 analyses
   (input, output, agents called).
4. **1Click**: quotes, started deposits and their statuses.
5. **Controls**: kill switch (LLM off → everyone gets heuristics), daily cap field.

Later: Telegram alerts, per-protocol charts, export.

## Cut order if late

Only M3 items are cut, in this order (labels `cut-1` … `cut-4`):

1. Admin screens 2–4 (`cut-1`). Spend tracking and the kill switch (M1) stay.
2. LP re-centre (`cut-2`).
3. 1Click deposit (`cut-3`) → README roadmap; keep the quote comparison on `/routes`.
4. Cross-token loop unwind (`cut-4`).

Never cut (`never-cut`): security items, LLM core with fallback, spend tracking + kill switch, an honest README.

## Roadmap (README, not this hackathon)

1Click execution through an EVM wallet connect, a backup LLM provider (e.g. Gemini) for Anthropic outages, LLM-backed
specialist agents, admin alerts.

From the teammate's review on 12 Nov (issues filed without a milestone): positive-carry looping as a signable
recommendation (#88), the NEAR / CONTROL design handoff (#89), swapping unverified wallet tokens into stablecoins with
the real swap loss and a rule-based wider token allowlist (#90). In M2 from the same review: loan cards show the loan
cost against what the position earns and repay only to the safe health factor (#86), a mode label on the Portfolio
page (#87), verified / unverified split and top rows first in the full portfolio (#73 comment).
