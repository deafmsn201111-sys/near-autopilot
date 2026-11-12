# Design Brief: NEAR Autopilot product-wide redesign

## Problem

People exploring NEAR DeFi need to understand what is happening to a portfolio and what an agent recommends without mistaking analysis for an instruction or simulated data for their own funds. New users need a safe way to learn the product; experienced DeFi users need precise balances, sources, risks, and transaction details; reviewers need to understand the product's real capabilities quickly.

The current product has three distinct account contexts—demo, a mainnet account viewed read-only, and a connected wallet. If those contexts look alike, users may misread data freshness, ownership, or whether an action can be signed. The interface must make those distinctions explicit throughout the product.

## Solution

Present NEAR Autopilot as a calm, premium DeFi control terminal. Keep every existing product route, organize it in a consistent left navigation rail, and make the page's purpose and data state clear before showing detail. Put recommendations in a browsable, user-controlled horizontal rail. Show the exact transaction cascade and its risks before the user signs in their own wallet. Keep demo data, read-only mainnet data, and wallet-connected actions visibly distinct.

## Experience Principles

1. **Clarity before density** — Show the decision-relevant facts first; reveal technical and supporting detail when the user asks for it.
2. **Evidence before persuasion** — Use only actual API or on-chain data. Label its source, freshness, simulation status, and uncertainty; do not imply forecast returns or savings that the product cannot substantiate.
3. **User control before automation** — Recommendations are advice. Preparation never sends a transaction; the user's wallet presents and signs each action. Make partial submission, failure, and confirmation states explicit.

## Aesthetic Direction

- **Philosophy**: Premium DeFi Terminal: restrained control surface with precise financial information and one clear interactive focal point—the recommendation rail.
- **Tone**: Calm, exact, transparent, and technically confident. Avoid urgency except when a real risk level requires it.
- **Reference points**: The supplied NEAR / CONTROL design handoff and the conventions of a premium trading terminal. Treat prototype values and unsupported screens in the handoff as visual references only.
- **Anti-references**: Generic SaaS card grids, bright neon-green crypto styling, decorative gradients, information-dense trading screens, gamified claims, invented statistics, and navigation that implies features the API does not provide.
- **Brand and language**: Keep the public product name and logo as NEAR Autopilot. The interface is English-first. NEAR / CONTROL is a visual direction, not a replacement brand.
- **Color direction**: Dark-first with a persistent light-theme option. Core dark tokens: page `#111411`, panel `#191E19`, raised surface `#222922`, primary text `#EDF1E9`, secondary text `#A0ADA0`, dividers `#303930`; use muted sage `#81947A` for portfolio allocation and restrained warm tones for risk. Green is not a universal success signal; semantic status colors must remain distinct.
- **Typography**: IBM Plex Sans for interface and financial values, IBM Plex Mono for addresses and raw technical identifiers. Use tabular numerals for comparable amounts. Do not load decorative display fonts.
- **Alignment and layout**: Left-align page content and reading order. Use a persistent 232px desktop navigation rail and a compact top navigation on mobile. Keep long-form text under roughly 70 characters per line where practical. Use a narrow hierarchy of page heading, state/source, primary content, and optional detail.

## Existing Patterns

- **Typography**: IBM Plex Sans and IBM Plex Mono are loaded in `apps/analytics/app/layout.tsx`; `apps/analytics/app/terminal.css` assigns body, numeric, and mono roles.
- **Colors and themes**: `apps/analytics/app/terminal.css` is imported after `globals.css` and currently owns the final design tokens. Legacy values still exist in `globals.css`; do not add more competing token definitions. Consolidate only if a later implementation task explicitly includes that cleanup.
- **Spacing**: Existing CSS uses a compact terminal rhythm, 16–24px panel gutters, 232px desktop rail, and 40px desktop page gutters. Keep mobile gutters near 16px.
- **Components**: Reuse `TopNav`, `SubNav`, `ThemeToggle`, `WalletButton`, `PortfolioSwitch`, `Recommendations`, `PrepareDialog`, `OwnershipCheck`, `AccountForm`, `FreshnessNote`, chart components, `OpportunityRow`, and shared empty/error states. Extend these patterns instead of introducing a second UI kit.
- **Application behavior**: Next.js App Router, React 19, plain CSS, no installed component framework. Pages are dynamic and refresh periodically. Follow existing semantic HTML and `:focus-visible` rules.
- **Routes in scope**: `/`, `/activity`, `/audit`, `/burrow`, `/burrow/[token]`, `/collector`, `/lp`, `/opportunities`, `/opportunities/[id]`, `/policy`, `/portfolios`, `/prices`, `/prices/[asset]`, `/research`, `/reviewers`, `/rhea`, `/rhea/[key]`, `/routes`, `/strategies`, `/system`, and `/thesis`. Existing API routes and `/healthz` are functional endpoints, not visual redesign screens.

## Component Inventory

| Component                                                    | Status          | Notes                                                                                                         |
| ------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------- |
| Global navigation rail / mobile navigation                   | Modify          | Shared across routes; keep current route visible and make reviewer navigation usable on small screens.        |
| Theme toggle                                                 | Exists          | Dark is the first-visit default; preserve the explicit light-theme option.                                    |
| Wallet button                                                | Exists          | Distinguish connect, connecting, connected, opening, and disconnected states.                                 |
| Portfolio mode switch                                        | Modify          | Identify demo, read-only mainnet lookup, and connected wallet. Do not label a looked-up account as connected. |
| Portfolio overview                                           | Exists / modify | Real holdings and risk state; keep source and freshness visible.                                              |
| Recommendation rail                                          | Modify          | Horizontal browse by wheel, trackpad, arrows, keyboard, and touch swipe; no autoplay.                         |
| Prepare transaction dialog                                   | Exists / modify | Show exact receiver, methods, deposits, gas, step count, signing state, errors, and partial submission.       |
| Ownership proof                                              | Exists          | Keep proof of wallet ownership separate from wallet connection.                                               |
| Charts and financial tables                                  | Exists / modify | Preserve real values, labels, units, source, and responsive behavior.                                         |
| Loading, empty, error, and not-found states                  | Exists / modify | Explain what is happening and what the user can do next.                                                      |
| Detail pages for Burrow, Rhea, prices, and opportunities     | Exists / modify | Use shared page hierarchy while keeping each domain's actual data and actions intact.                         |
| Settings, all-recommendations page, live transaction history | Out of scope    | No route or supporting API exists for these features.                                                         |

## Key Interactions

- **Choose a portfolio context**: Demo uses simulated balances. Mainnet lookup displays account data as read-only. A matching active wallet session displays connected-wallet state. Never infer wallet ownership from a URL alone.
- **Browse recommendations**: Mouse wheel and vertical trackpad input move the rail horizontally when it can advance; at either edge, the page keeps its normal vertical scroll. Horizontal trackpad gestures remain horizontal. Previous/next buttons, left/right arrows, Home/End, and native touch swiping are supported. No automatic movement.
- **Run analysis**: The user requests ranking; show loading, result provenance (AI or heuristic), and failure feedback. Do not present an unavailable AI result as model output.
- **Prepare an action**: The app assembles and displays the exact transaction details. Preparation does not broadcast or sign.
- **Sign a cascade**: The user explicitly approves in their wallet. Show submitted hashes. If a later step fails after earlier steps were submitted, identify partial submission and discard the old cascade to prevent accidental resubmission.
- **Refresh data**: Periodic refresh may change balances and recommendations. Keep freshness legible and avoid disruptive visual movement.
- **Navigate reviewer material**: Preserve the existing reviewer directory and page routes; do not imply a reviewer-only product mode.

## Responsive Behavior

- **Desktop**: Fixed 232px left rail; main content fills the remaining viewport with consistent gutters. Tables retain their semantic column structure.
- **Tablet**: Reduce main gutters and collapse two-column analytical sections when values become cramped. Keep navigation discoverable.
- **Mobile (390px and above, with smaller-width fallback)**: Replace the rail with compact top navigation; stack portfolio summary and risk panels; allow tables and recommendation cards to scroll horizontally within their own region. Headings and account names wrap or truncate intentionally, never expand the page width. Touch users can swipe the recommendation rail.
- Respect `prefers-reduced-motion`; focus remains visible during keyboard navigation. Do not rely on hover for essential actions.

## Accessibility Requirements

- Maintain WCAG 2.2 AA contrast for body text, controls, and state indicators in both themes. Do not encode risk, connection, or simulation status by color alone.
- Preserve visible keyboard focus and logical tab order. Recommendation controls and rail must be keyboard operable and labelled for assistive technology.
- Use semantic headings, navigation landmarks, tables, buttons, and links. Announce analysis, transaction, and partial-submission outcomes with appropriate live status regions.
- Provide accessible names for icon-only controls, meaningful chart summaries, and text equivalents for risk and allocation visuals.
- Respect reduced-motion preferences and ensure horizontal scrolling does not trap keyboard or touch users.

## Success Criteria

- A first-time user can identify whether they are viewing a demo, a read-only mainnet account, or a connected wallet without interpreting color alone.
- A user can find the portfolio, recommendations, activity, and reviewer sections from every route and can operate the recommendation rail with pointer, keyboard, and touch.
- Before wallet approval, a user can inspect each transaction's receiver, methods, deposits, gas, and total steps; partial submission is distinguishable from complete failure.
- All displayed financial values, market states, and recommendation claims trace to real product data or are clearly labelled as simulated, heuristic, or unavailable.
- Existing routes continue to render at desktop and mobile widths without horizontal page overflow; loading, empty, error, and not-found states remain understandable.

## Out of Scope

- Rebranding or renaming NEAR Autopilot.
- Adding Settings, a separate all-recommendations route, or live wallet transaction history.
- Adding APIs, market data, analytics claims, forecast savings, or invented example values to make prototypes look complete.
- Automatic transaction signing, custody, or execution without the user's wallet approval.
- Changing product strategy or altering the behavior of `main` as part of this brief.
