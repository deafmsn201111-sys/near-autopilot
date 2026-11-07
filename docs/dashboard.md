# Dashboard (analytics app, `:3001`)

## Principles

- **The product, not the plumbing.** Each page answers a user question first in plain words; numbers come second;
  codes, hashes, raw JSON and SQL-level details sit behind a "Technical details" disclosure or on the Audit pages.
- **Three levels of information.** Level 1: what is happening and what to do (Overview, status strip, warnings).
  Level 2: analytics (yield, risk, liquidity, history, simulation). Level 3: technical (reason codes, source timestamps,
  hashes, raw records). Levels are not mixed on one screen.
- **Nothing decorative.** Every button calls a real endpoint; every number names its source; a missing value is shown
  as missing ("not simulated", "—", an explained empty state), never as 0; out-of-date data is labelled.
- **No execution.** Shadow mode has no wallet and no execute button. The only state changes are the three audited
  operator controls.

## Information architecture

| Section                | Route(s)                                        | API                                                                                     |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Overview               | `/`                                             | `/v1/analytics/system`, `/opportunities`, `/v1/control`, `/activity`, `/overview`       |
| Opportunities          | `/opportunities`, `/opportunities/[id]`         | `/v1/analytics/opportunities[/:id]`                                                     |
| Autopilot              | `/autopilot`                                    | `/v1/control`, `POST /v1/control/collector/{run,pause,resume}`, `POST /v1/control/mode` |
| Portfolio & Simulation | `/portfolios`, `/strategies`, `/lp` (tabs)      | `/v1/analytics/portfolios`, `/risk`, `/strategies`                                      |
| Analytics & Thesis     | `/rhea`, `/burrow`, `/prices`, `/thesis` (tabs) | `/v1/analytics/rhea/*`, `/burrow/*`, `/prices/*`, `/series/*`, `/thesis`                |
| Activity & Audit       | `/activity`, `/policy`, `/routes`, `/audit`     | `/v1/analytics/activity`, `/policy/*`, `/routes`, `/audit`                              |
| System Health          | `/system`, `/collector` (tabs)                  | `/v1/analytics/system`, `/collector`                                                    |

Old URLs are unchanged; they became tabs of their section.

## Operator controls

| Control                           | Effect                                                                        | Safety                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Run market analysis now           | One collector cycle (mainnet view calls, re-ranking, demo-portfolio analysis) | Token-protected, internal network only, one cycle at a time (409 otherwise)                |
| Pause / resume scheduled analysis | Scheduled cycles are skipped while paused; manual runs still work             | `collector_control` row (migration 0014) + audit entry; needs a reason                     |
| Read-only / normal per portfolio  | Through the orchestrator's ModeController and `PgControlStore`                | Versioned; a stale change is a conflict, never a silent success; history row + audit entry |

All three run as Next.js server actions: the API token never reaches the browser. Each opens a confirmation dialog
that states what will and will not happen.

## Design system

Tokens in `app/globals.css`: one sans face; neutral surfaces; one accent; status colours (good / warning / serious /
critical) always with an icon and a label, never colour alone; chart palette validated for colour-vision deficiency
(dataviz method). Components: `PageHeader`, `Section`, `Tile`, `Status` (plain label, code in the tooltip), `Level`
(risk / confidence), `Facts`, `EmptyState`, `ErrorState` (with retry), loading skeleton (`app/loading.tsx`), error
boundary (`app/error.tsx`), `ConfirmAction` (dialog), `OpportunityRow`, charts (`LineChart`, `StressCurve`,
`Sparkline`). Plain-language labels for backend codes live in `lib/format.ts` (`statusOf`).

## Responsive behaviour

Desktop: sidebar + content. At 900 px the sidebar becomes a top bar with a horizontally scrolling section menu. At
640 px opportunity rows become cards and tiles go two-up. Wide tables scroll inside their frame; the page never scrolls
sideways. Checked by Chrome DevTools emulation at 390 px on all main pages (`scrollWidth == clientWidth`).
