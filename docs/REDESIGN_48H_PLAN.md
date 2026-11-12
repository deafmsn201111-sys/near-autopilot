# 48-hour redesign plan

Start: 2026-11-12, about 20:45 Asia/Yekaterinburg. Target: 2026-11-14, about 20:45.

## Brief

- Redesign all 21 Next.js page routes in `apps/analytics/app` and publish an isolated beta at `beta.near-autopilot.tech`.
- Keep the NEAR Autopilot name. English UI. Dark theme first; retain a complete light theme.
- Serve newcomers, experienced DeFi users, and reviewers with progressive disclosure: a clear summary first, exact figures, provenance, risks, and transaction details one step deeper.
- The server never signs or holds keys. The user signs in their wallet. Demo, read-only account data, prepared transactions, and signing availability must be visually distinct.

## Visual direction

Premium DeFi Terminal, expressed through the path from observation to decision to user-signed transaction. Use one memorable route/step treatment for recommendations and prepared transactions. Keep surrounding layouts restrained; remove decorative glow and repeated gradient-card treatments.

Working dark palette: canvas `#0B1116`, surface `#17232A`, raised surface `#223139`, text `#ECF2EF`, secondary text `#A6B6B1`, action `#76CEB2`. Add tested semantic colors for warning, loss, and success. Use IBM Plex Sans for UI and tabular figures, IBM Plex Mono only for addresses and contract methods. Validate contrast and tune values before shipping.

```text
Brand / navigation                                      Wallet
Demo or connected account                     Source / updated time

Portfolio and allocation                       Best next move
                                               Effect / costs / risk

Holdings                                       Why this move
                                               Exact steps / wallet sign
```

## Schedule and acceptance gates

| Time from start | Work                                                                                                                                                     | Gate                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 0–4 h           | Capture baseline of all routes and states; inspect shared components and deploy topology; prepare design tokens and two compact layout options.          | Owner selects a direction from reviewable visuals.                                                       |
| 4–16 h          | Build shell, navigation, typography, colors, portfolio, recommendations, preparation and result states.                                                  | Main desktop and mobile paths work; demo and connected modes read distinctly.                            |
| 16–30 h         | Apply shared page patterns to opportunities and details, activity, reviewer hub, and the remaining research, market, policy, audit and system routes.    | Every route has a coherent layout; deep tables and charts remain usable.                                 |
| 30–38 h         | Refine responsive layouts, light theme, empty/loading/error states, keyboard focus and reduced motion; consolidate CSS overrides.                        | No horizontal page overflow at 360, 768, and 1440 px; keyboard path works.                               |
| 38–44 h         | Run `pnpm verify` and `pnpm build`; inspect screenshots and fix defects. Prepare isolated beta configuration and check server capacity, DNS and routing. | Code gates pass and beta stack cannot share main's database, volumes, internal ports or Compose project. |
| 44–48 h         | Deploy beta, smoke test all page families, wallet connection and safe prepare flow; record owner-only live signing check.                                | Beta serves HTTPS, main health remains unchanged, rollback is available.                                 |

## Route coverage

- Product: `/`, `/opportunities`, `/opportunities/[id]`, `/activity`.
- Reviewer and analysis: `/reviewers`, `/research`, `/policy`, `/audit`, `/routes`, `/system`, `/rhea`, `/rhea/[key]`, `/burrow`, `/burrow/[token]`, `/prices`, `/prices/[asset]`, `/portfolios`, `/strategies`, `/lp`, `/thesis`, `/collector`.

## Constraints and dependencies

- Do not change financial calculations, displayed data provenance, signing gates, or cascade validation as part of visual work. Show exact prepared actions and amounts before wallet handoff.
- The current deploy skill is for main only. Beta needs a separate deployment path with its own Compose project, database, volumes, secrets, collector cadence, loopback port and host-based reverse proxy route. Inspect the VPS before choosing details.
- VPS SSH access and a `beta` DNS record are external dependencies. The local `near-autopilot` SSH alias was absent when this plan was written.
- Keep main live throughout the beta release. If server headroom is insufficient, choose another beta host rather than sharing state with main.
