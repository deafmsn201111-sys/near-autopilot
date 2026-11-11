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

| #               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core            | **Architecture C**: central LLM + existing `packages/orchestrator` agents exposed as tools + deterministic engine. The LLM ranks and explains; code computes every number. Output goes zod → prepare → `validateCascade`. On LLM failure, fall back to heuristic recommendations (labelled).                                                                                                                                                                                                |
| Model           | Default **Claude Haiku 5.5**; on 11 Nov compare against Sonnet 5.5 on both demo portfolios and pick. Pay-as-you-go API key (a Claude subscription cannot power a server). $20 deposit, spend limit set in the console. No open models for now: same price as Haiku, weaker tool use + strict JSON. Provider is swappable via the `LlmClient` port.                                                                                                                                          |
| Strategy        | Three presets change thresholds (health factor, min APR, concentration) and go into the LLM prompt.                                                                                                                                                                                                                                                                                                                                                                                         |
| 1Click          | **Inbound deposit only**: server-side real quote, verified against the request, stored server-side; UI gets an id + read-only fields; user-entered refund address with per-chain format check; deposit address + chain + deadline + QR; status polling by quote id. No NEAR transaction is built, so the cascade allowlist is untouched. Keep `dryQuote` in `gateway/one-click.ts` exactly as is. Record in `DECISIONS.md`. Execution via EVM wallet connect → roadmap. Swaps stay on Rhea. |
| LLM access      | LLM analysis only for a wallet that proved ownership with a **NEP-413** signed message. Any other account and the demo portfolios get heuristics + a cached LLM example.                                                                                                                                                                                                                                                                                                                    |
| Demo portfolios | Keep the $5k / $500 simulated portfolios as the "try without a wallet" path for judges; their LLM analysis is refreshed from cache every N minutes.                                                                                                                                                                                                                                                                                                                                         |
| Removal         | Delete autopilot entirely: `/autopilot` page, `/v1/control/*`, `/v1/runs`, `signer.ts`, autopilot-config, `config/autopilot*.json`, `apps/dashboard`. Delete all testnet code, scripts and docs. Delete `PUBLIC_DEMO`; signing is controlled only by `MAINNET_WALLET_SIGNING`. Keep the collector and the orchestrator agents. If a removal drags deeper than 2–3 h, stop and re-plan.                                                                                                      |
| Signing         | Enabled on the public site (`MAINNET_WALLET_SIGNING=1`). Cascade caps stay (0.15 NEAR per action, 0.3 per cascade). Record in `DECISIONS.md`.                                                                                                                                                                                                                                                                                                                                               |
| Admin           | `/admin` in `apps/analytics`, enabled only by `ADMIN_UI=1` on a second container bound to `127.0.0.1`; reached through an SSH tunnel. Public site returns 404 for `/admin`. No auth code.                                                                                                                                                                                                                                                                                                   |
| Privacy         | Store `accountId` (public on-chain). Never store IPs. LLM prompts/responses kept 7 days. README has a "what we log" line.                                                                                                                                                                                                                                                                                                                                                                   |
| Hosting         | VPS via existing `deploy/public/` + a real domain (in README and the X post).                                                                                                                                                                                                                                                                                                                                                                                                               |
| Process         | Code until the deadline. Every PR that changes behaviour updates the README in the same PR. Video and post are made at the end.                                                                                                                                                                                                                                                                                                                                                             |

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

Status lives in GitHub issues (one issue = one branch = one PR, `Closes #N`), grouped by the Day 1–4 milestones, and
on the [board](https://github.com/users/derevyanko/projects/1). Bugs from the evening live-site tests are filed as
`bug` issues in that day's milestone.

### Day 1 — 11 Nov: foundation

#8 domain + VPS · #9, #10, #11 security 1, 6, 7 · #12 remove testnet · #13 remove autopilot, dashboard, `PUBLIC_DEMO`
· #14 API key · #15 `LlmClient` adapter · #16 Haiku vs Sonnet · #17 demo wallet

### Day 2 — 12 Nov: LLM core

#18 tool-use loop · #19 security 3 · #20 NEP-413 · #21, #22 security 2 · #23 pool allowlist · #24 demo portfolio cache
· #25 strategies · #26 reasoning trace

### Day 3 — 13 Nov: 1Click + end-to-end

#27, #28, #29 1Click deposit (security 4, 5) · #30 end-to-end signing · #31 admin spend + kill switch · #32 `events`
table · #33 admin funnel + LLM quality

### Day 4 — 14 Nov: finish

#34 admin 1Click · #35 README pass · #36 judge check · #45 secrets audit of history, then make repo public · #37 video **by 18:00 UTC** · #38 post + submit **by 21:00 UTC**

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

1. Admin screens (spend tracking and kill switch stay).
2. Reasoning trace → plain list of called agents.
3. 1Click deposit → README roadmap; keep the quote comparison on `/routes`.
4. Strategies 3 → 2.

Never cut: security items, LLM core with fallback, spend tracking + kill switch, an honest README.

## Roadmap (README, not this hackathon)

1Click execution through an EVM wallet connect, a backup LLM provider (e.g. Gemini) for Anthropic outages, LLM-backed
specialist agents, admin alerts.
