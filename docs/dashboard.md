# Dashboard (`:3001`)

## Principle

The product pages answer the questions of a person who wants to use the autopilot; the technical evidence is one click
away for reviewers, not in the way. Before a screen ships: would a non-developer understand it in five seconds? Codes,
hashes, source names and record counts never appear on a product page. Every number on a product page has a source on a
reviewer page.

## Pages

| Page          | Route                                   | API                                                                                                |
| ------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Portfolio     | `/?p=demo-5000` (or `demo-500`)         | `/v1/analytics/portfolio/:id`                                                                      |
| Opportunities | `/opportunities`, `/opportunities/[id]` | `/v1/analytics/opportunities[/:id]`                                                                |
| Activity      | `/activity?p=…`                         | `/v1/analytics/agent-activity?portfolio=…`                                                         |
| Research      | `/research`                             | `/v1/analytics/thesis`                                                                             |
| For reviewers | `/reviewers` and its tabs               | policy, audit (with checkpoints), routes, control, system, markets, prices, simulations, collector |

**Portfolio** (`apps/api/src/analytics/portfolio-view.ts`): holdings are the simulated demo amounts valued at the latest
mainnet prices; loan safety from the stored health factor ("safe unless NEAR falls X%"); the monthly result of the
current structure; the actions, each with plan, cost breakdown, risks and the autopilot's view (`worth_it`,
`not_worth_it` against the hurdle, `not_allowed` when the autopilot has no such action, e.g. borrowing or opening LP).

**Activity** narrates each stored analysis: per-agent observations, rejected proposals with the reason in words, the
policy verdicts of the run. Consecutive analyses with the same meaning are folded into one entry with a count.

**Looping** (`looping.ts`): same-asset loops only. With Burrow's health factor `Σ collateral·vr / Σ debt/vr` and the
same asset on both sides, HF = L·vr²/(L−1), so a target HF h gives L = h/(h−vr²) exactly. Net = L·supply − (L−1)·borrow
− gas for every round in and out. Reports the break-even borrow rate and the days until rate drift alone would bring
the health factor to 1.0.

## Operator controls

Only on the reviewers' Controls page and the Portfolio "Refresh with live data" button: run an analysis now,
pause/resume scheduled analysis, read-only/normal per portfolio. Server actions (the token never reaches the browser),
each behind a confirmation dialog, audited. Nothing can sign, send or change a limit.

## Design and responsiveness

Top navigation, one column of content up to 1,120 px, large numbers with one sentence each, cards for actions with the
details behind a disclosure. At 760 px the navigation wraps and the hero stacks; checked at 390 px with Chrome DevTools
emulation on every product page (no sideways scrolling).
