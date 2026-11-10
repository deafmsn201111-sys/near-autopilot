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

| # | Decision |
|---|---|
| Core | **Architecture C**: central LLM + existing `packages/orchestrator` agents exposed as tools + deterministic engine. The LLM ranks and explains; code computes every number. Output goes zod → prepare → `validateCascade`. On LLM failure, fall back to heuristic recommendations (labelled). |
| Model | Default **Claude Haiku 5.5**; on 11 Nov compare against Sonnet 5.5 on both demo portfolios and pick. Pay-as-you-go API key (a Claude subscription cannot power a server). $20 deposit, spend limit set in the console. No open models for now: same price as Haiku, weaker tool use + strict JSON. Provider is swappable via the `LlmClient` port. |
| Strategy | Three presets change thresholds (health factor, min APR, concentration) and go into the LLM prompt. |
| 1Click | **Inbound deposit only**: server-side real quote, verified against the request, stored server-side; UI gets an id + read-only fields; user-entered refund address with per-chain format check; deposit address + chain + deadline + QR; status polling by quote id. No NEAR transaction is built, so the cascade allowlist is untouched. Keep `dryQuote` in `gateway/one-click.ts` exactly as is. Record in `DECISIONS.md`. Execution via EVM wallet connect → roadmap. Swaps stay on Rhea. |
| LLM access | LLM analysis only for a wallet that proved ownership with a **NEP-413** signed message. Any other account and the demo portfolios get heuristics + a cached LLM example. |
| Demo portfolios | Keep the $5k / $500 simulated portfolios as the "try without a wallet" path for judges; their LLM analysis is refreshed from cache every N minutes. |
| Removal | Delete autopilot entirely: `/autopilot` page, `/v1/control/*`, `/v1/runs`, `signer.ts`, autopilot-config, `config/autopilot*.json`, `apps/dashboard`. Delete all testnet code, scripts and docs. Delete `PUBLIC_DEMO`; signing is controlled only by `MAINNET_WALLET_SIGNING`. Keep the collector and the orchestrator agents. If a removal drags deeper than 2–3 h, stop and re-plan. |
| Signing | Enabled on the public site (`MAINNET_WALLET_SIGNING=1`). Cascade caps stay (0.15 NEAR per action, 0.3 per cascade). Record in `DECISIONS.md`. |
| Admin | `/admin` in `apps/analytics`, enabled only by `ADMIN_UI=1` on a second container bound to `127.0.0.1`; reached through an SSH tunnel. Public site returns 404 for `/admin`. No auth code. |
| Privacy | Store `accountId` (public on-chain). Never store IPs. LLM prompts/responses kept 7 days. README has a "what we log" line. |
| Hosting | VPS via existing `deploy/public/` + a real domain (in README and the X post). |
| Process | Code until the deadline. Every PR that changes behaviour updates the README in the same PR. Video and post are made at the end. |

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

### Day 1 — 11 Nov: foundation

- [ ] Buy domain; move the demo from Tailscale Funnel to a VPS (`deploy/public/`).
- [ ] Security items 1, 6, 7.
- [ ] Remove testnet code, scripts and docs.
- [ ] Remove autopilot, `apps/dashboard` and `PUBLIC_DEMO`; signing controlled by `MAINNET_WALLET_SIGNING`; entry in
      `DECISIONS.md`.
- [ ] Anthropic `LlmClient` adapter; compare Haiku vs Sonnet on both demo portfolios; pick the default.
- [ ] Create the mainnet demo wallet (~$30–50: NEAR, USDC, Burrow supply, a Rhea position, stNEAR).
- [ ] Create the API key, $20 deposit, spend limit in the console.
- [ ] Evening: test the live site with a real wallet, file bugs.

### Day 2 — 12 Nov: LLM core

- [ ] Tool-use loop: orchestrator agents as tools, on the connected-wallet path.
- [ ] Input sanitising, zod output validation, heuristic fallback (security item 3).
- [ ] NEP-413 ownership check for LLM analysis.
- [ ] `llm_calls` table (model, tokens, cost $, latency, tools called, outcome); daily spend cap; limits (security item 2).
- [ ] Pool allowlist for `add_liquidity`.
- [ ] Three strategy presets in UI and prompt.
- [ ] "Reasoning trace" in UI: which agents were called and what they returned.
- [ ] Evening: test the live site, file bugs.

### Day 3 — 13 Nov: 1Click + end-to-end

- [ ] 1Click inbound deposit: server quote client with verification, refund address, QR, status polling (security
      items 4, 5); entry in `DECISIONS.md`.
- [ ] Real signing on the mainnet wallet; full run connect → analyse → prepare → sign → portfolio refresh.
- [ ] Evening: `events` table (connect, analyse, prepare by intent, signed with tx hash verified by RPC, 1Click
      started/finished) and admin screens 1–3 + kill switch.
- [ ] Evening: test the live site, file bugs.

### Day 4 — 14 Nov: finish

- [ ] Bug fixes.
- [ ] Admin screen 4 (1Click), if time allows.
- [ ] Final README pass: remove every claim that does not match behaviour (testnet, autonomy, guard contract,
      "signing locked", dead branch links, old agent table); document architecture C, intents, 1Click, what we log,
      roadmap.
- [ ] README check "as a judge": click through every claim on the live site.
- [ ] Video script and recording — **by 18:00 UTC**.
- [ ] X post text; post + submit — **by 21:00 UTC**. ~3 h buffer.

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
