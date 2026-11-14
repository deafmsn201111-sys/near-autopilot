---
name: NEAR Autopilot
description: A dark, quiet ledger of your DeFi position, lit only where a decision is needed.
colors:
  bg-inset: 'oklch(.135 .005 275)'
  bg-page: 'oklch(.160 .005 275)'
  bg-surface: 'oklch(.192 .006 275)'
  bg-raised: 'oklch(.228 .007 275)'
  bg-overlay: 'oklch(.255 .007 275)'
  text-1: 'oklch(.985 .002 275)'
  text-2: 'oklch(.80 .008 275)'
  text-3: 'oklch(.66 .010 275)'
  text-disabled: 'oklch(.48 .008 275)'
  line-subtle: 'rgb(255 255 255 / .06)'
  line: 'rgb(255 255 255 / .085)'
  line-strong: 'rgb(255 255 255 / .15)'
  line-control: 'rgb(255 255 255 / .22)'
  line-input: 'rgb(255 255 255 / .36)'
  neutral-solid: 'oklch(.985 .002 275)'
  neutral-ink: 'oklch(.16 .005 275)'
  accent: 'oklch(.74 .15 282)'
  accent-muted: 'oklch(.74 .15 282 / .13)'
  accent-line: 'oklch(.74 .15 282 / .60)'
  sign: 'oklch(.57 .22 282)'
  sign-hover: 'oklch(.62 .22 282)'
  sign-ink: 'oklch(1 0 0)'
  safe: 'oklch(.79 .12 160)'
  watch: 'oklch(.83 .13 82)'
  act: 'oklch(.76 .15 48)'
  liq: 'oklch(.72 .18 25)'
  safe-bg: 'oklch(.79 .12 160 / .12)'
  watch-bg: 'oklch(.83 .13 82 / .12)'
  act-bg: 'oklch(.76 .15 48 / .13)'
  liq-bg: 'oklch(.72 .18 25 / .14)'
  zone-liq: 'oklch(.66 .19 25 / .75)'
  zone-watch: 'oklch(.80 .14 75 / .55)'
  zone-safe: 'oklch(.74 .13 160 / .45)'
  light-bg-inset: 'oklch(.962 .004 275)'
  light-bg-page: 'oklch(.982 .003 275)'
  light-bg-surface: 'oklch(1 0 0)'
  light-text-1: 'oklch(.19 .010 275)'
  light-text-2: 'oklch(.42 .014 275)'
  light-text-3: 'oklch(.52 .014 275)'
  light-line: 'rgb(15 20 30 / .10)'
  light-line-input: 'rgb(15 20 30 / .50)'
  light-accent: 'oklch(.52 .20 282)'
  light-sign: 'oklch(.52 .22 282)'
  light-safe: 'oklch(.50 .12 160)'
  light-watch: 'oklch(.50 .12 70)'
  light-act: 'oklch(.50 .16 45)'
  light-liq: 'oklch(.52 .19 25)'
typography:
  hero:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '56px'
    fontWeight: 500
    lineHeight: 1
    letterSpacing: '-0.035em'
    fontFeature: '"tnum", "zero", "ss01"'
  kpi:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '30px'
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: '-0.025em'
    fontFeature: '"tnum", "zero"'
  headline:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '24px'
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '-0.02em'
  title:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '19px'
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.015em'
  body-lg:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '17px'
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '15px'
    fontWeight: 400
    lineHeight: 1.5
  secondary:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '13px'
    fontWeight: 500
    lineHeight: 1.4
  meta:
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif'
    fontSize: '12px'
    fontWeight: 500
    lineHeight: 1.3
  mono:
    fontFamily: 'Geist Mono, ui-monospace, SF Mono, Menlo, monospace'
    fontSize: '12px'
    fontWeight: 400
    lineHeight: 1.4
rounded:
  xs: '6px'
  sm: '8px'
  md: '12px'
  lg: '16px'
  xl: '20px'
spacing:
  '1': '4px'
  '2': '8px'
  '3': '12px'
  '4': '16px'
  '5': '20px'
  '6': '24px'
  '8': '32px'
  '10': '40px'
components:
  button-secondary:
    backgroundColor: '{colors.bg-raised}'
    textColor: '{colors.text-1}'
    rounded: '{rounded.sm}'
    padding: '0 14px'
    height: '36px'
  button-primary:
    backgroundColor: '{colors.neutral-solid}'
    textColor: '{colors.neutral-ink}'
    rounded: '{rounded.sm}'
    padding: '0 14px'
    height: '36px'
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.text-2}'
    rounded: '{rounded.sm}'
    padding: '0 14px'
    height: '36px'
  button-sign:
    backgroundColor: '{colors.sign}'
    textColor: '{colors.sign-ink}'
    typography: '{typography.body-lg}'
    rounded: '{rounded.sm}'
    height: '52px'
    width: '100%'
  button-sign-hover:
    backgroundColor: '{colors.sign-hover}'
  button-disabled:
    backgroundColor: '{colors.bg-raised}'
    textColor: '{colors.text-disabled}'
  chip:
    backgroundColor: 'transparent'
    textColor: '{colors.text-2}'
    typography: '{typography.meta}'
    rounded: '{rounded.xs}'
    padding: '0 8px'
    height: '24px'
  chip-ai:
    backgroundColor: '{colors.accent-muted}'
    textColor: '{colors.accent}'
  chip-act:
    backgroundColor: '{colors.act-bg}'
    textColor: '{colors.act}'
  chip-watch:
    backgroundColor: '{colors.watch-bg}'
    textColor: '{colors.watch}'
  chip-safe:
    backgroundColor: '{colors.safe-bg}'
    textColor: '{colors.safe}'
  panel:
    backgroundColor: '{colors.bg-surface}'
    rounded: '{rounded.lg}'
    padding: '20px 24px'
  card-top:
    backgroundColor: '{colors.bg-raised}'
    rounded: '{rounded.lg}'
    padding: '20px 24px'
  sheet:
    backgroundColor: '{colors.bg-overlay}'
    rounded: '{rounded.xl}'
    width: '620px'
  input-amount:
    backgroundColor: '{colors.bg-inset}'
    textColor: '{colors.text-1}'
    typography: '{typography.headline}'
    rounded: '{rounded.sm}'
    padding: '10px 12px'
---

# Design System: NEAR Autopilot

Reference implementation: `docs/design/portfolio-ux-prototype.html` (v5.3, published as page version 8). Every value here was measured in that file in Chrome at 1440×900 and 390 in both themes. If this file and the prototype disagree, this file wins and the prototype is updated.

## Overview

**Creative North Star: "The Lit Ledger"**

A dark, quiet room with one lamp. The ledger of the user's money lies open on a near-black page; every number is legible and labelled with where it came from. Light — the single violet voice — falls only where a decision is needed: what the AI chose, the #1 suggestion, and the button that signs. Status colour appears only where there is risk. Nothing glows for decoration.

The product is an Operate surface for a person checking "am I safe, is my money working, what should I do". Density is calm, not sparse: explanations are never hidden to save space, and the layout grows rather than truncating. Trust is carried by visible machinery — provenance marks, the decision pipeline, the exact calls before signing — not by badges.

Dark is the primary theme; light is built from the same roles. The brand is chain-neutral: no chain's brand colour is used as the product colour, so the product can go multichain.

**Key Characteristics:**

- Near-black page (L .160) with panels only where content groups; the summary sits directly on the page.
- One violet accent (H282) that means "the AI / your decision", used on ≈1–3% of a screen.
- Status colours (safe / watch / act / liquidation) only on risk states and outcomes.
- Values, amounts and conclusions in the primary text colour; details and labels in grey. Every block has one thing the eye lands on first.
- Every number carries a provenance mark: dot = on-chain, dashed ring = estimate, hatched = simulated.
- Motion confirms what changed: numbers count up, changed rows flash, the card becomes its receipt.

## Colors

A neutral blue-violet-tinted dark ramp (H275, chroma ≤ .007), one violet voice, and four risk colours.

### Primary

- **Lamp Violet** (`accent`): the AI's voice. Selected strategy, decision-pipeline progress, the "#1 · AI pick" marker and the 2px rule on the top card, AI chips, focus rings, links inside sheets. Never a fill larger than a chip.
- **Signing Violet** (`sign`, white ink): the only solid chromatic fill in the product, reserved for the button that opens the user's wallet (Sign, Send with a connected wallet). Its rarity is what makes it findable.

### Secondary (risk scale)

- **Safe Mint** (`safe`): positive outcomes and deltas (+$6.67, received amounts), "Safe" loan state, success receipts.
- **Watch Amber** (`watch`): "Watch" loan state, idle money, read-only context.
- **Act Orange** (`act`): "Act now", costly positions (Costs 13.6%), price-impact warnings, the acknowledgement checkbox.
- **Liquidation Red** (`liq`): liquidation, negative monthly result, failed transactions, wrong-network warnings.
  Each has a `-bg` tint (12–14%) for chips and alerts and a `-line` for borders. The loan gauge uses stronger dedicated `zone-*` fills so the three zones read at a glance.

### Neutral

- **Ledger Black** (`bg-page`): the page and the hero summary.
- **Inset** (`bg-inset`): input wells, the gauge track.
- **Surface** (`bg-surface`): panels (analysis, holdings, ordinary cards).
- **Raised** (`bg-raised`): the #1 card, secondary buttons, the "Why you can trust it" column, code-check strip.
- **Overlay** (`bg-overlay`): sheets, popovers, toasts.
- **Paper White / Ash / Smoke** (`text-1` / `text-2` / `text-3`): values and explanations / labels and supporting copy / provenance and timestamps only, never below 13px except 12px meta tags.
- Lines are white-alpha hairlines: `line-subtle` inside panels, `line` for panel borders, `line-strong` for chips and group heads, `line-control` for controls, `line-input` (≥3:1) for input boundaries.

Token colours (USDC blue, Tether green, NEAR mint, ETH periwinkle) appear only in the allocation bar, always paired with the token's icon in the legend, never as UI colour.

### Named Rules

**The One Lamp Rule.** Violet means the AI or your decision. If an element is violet and is neither, it is wrong.
**The Risk-Only Colour Rule.** Neutral states ("Earning", "Collateral", "Kept for fees", agent passed) are neutral chips with an icon; only Idle / Costs / Watch / Act / Liquidation get tinted chips.
**The Ink-Over-Grey Rule.** Data and conclusions are text-1. If more than a third of a screen's characters are text-2/text-3, the hierarchy is inverted.
**The Lead-and-Detail Rule.** Every explanation leads with its conclusion in text-1 at 600 and continues in text-2. A block that is uniformly white is as flat as one that is uniformly grey: v5.1's analysis read as "a sheet of paper" for exactly this reason.

## Typography

**Body and display:** Geist (ui-sans-serif, system-ui fallback), loaded via `next/font`, weights 400/500/600.
**Mono:** Geist Mono, only for contract ids, methods and raw call tables.

**Character:** one neutral grotesque, hierarchy from size and weight, never from a second display face. All numbers use tabular, slashed-zero figures.

### Hierarchy

- **Hero** (500, 56px / 44px on phone, lh 1, −0.035em): net worth only; cents in text-3 at .6em.
- **KPI** (500, 30px, −0.025em): monthly result; the number takes the risk colour with a sign and trend arrow.
- **Headline** (600, 24px, lh 1.25): the analysis verdict, sheet titles, the intro h1.
- **Title** (600, 19px): section heads, card titles, fact values.
- **Body large** (17px): agent results, balance-change amounts, Sign label.
- **Body** (400, 15px, lh 1.5): explanations ("why") in text-2 with the conclusion bold text-1; verdict sub-line; max 76ch.
- **Secondary** (14px): labels, sub-lines, legends, table secondary text.
- **Label** (500, 13px): small labels, fact keys, footers.
- **Meta** (500, 12px): chips, provenance tags, table column heads, mono. Nothing else is 12px.

### Named Rules

**The Uniswap Floor Rule.** The page reads at 14–15px. 12px stays under ~8% of rendered characters (v5.1: 7.6%).
**The No-Synthetic-Bold Rule.** `b, strong` are 600; the font is never asked for 700.

## Layout

Single column, max 1180px, 16px side gutter (safe-area aware), 32px between sections. The hero summary is a 1.6fr / 1fr / 1fr grid on the page with hairline dividers; at ≤900px it becomes net worth over a 2-column row, at ≤640px a stack. Panels use 24px horizontal padding (16px on phone). Holdings rows are 56px on desktop and two-line on phone. A fixed 3-tab bar replaces the top nav at ≤640px.

The review/sign sheet is one column, 620px wide, and must fit a 900px-tall window without scrolling for the largest action (measured: 830px). On phones it is a bottom sheet at 92dvh. Never split it into two columns.

## Elevation & Depth

Depth is tonal first: each surface step is ΔL ≈ .03 (inset .135 → page .160 → surface .192 → raised .228 → overlay .255). Shadows are reserved for things that float or that the AI put first.

### Shadow Vocabulary

- **elev-1** (`0 0 0 1px rgb(255 255 255/.09), 0 1px 2px rgb(0 0 0/.4), 0 10px 30px -6px rgb(0 0 0/.5)`): the #1 suggestion card only.
- **pop** (`0 0 0 1px rgb(255 255 255/.10), 0 16px 48px rgb(0 0 0/.55)`): sheets, popovers, toasts.
- **hero glow** (radial `oklch(.74 .15 282 / .07)`): one soft lamp behind the net worth. Not a shadow, not repeated.

### Named Rules

**The Flat-In-Flow Rule.** Panels in the page flow have a border and no shadow. Only the #1 card and overlays lift.
**The No-Halo Rule.** No coloured box-shadows, including on Sign.

## Shapes

Soft rectangles. Panels and cards 16px, sheets 20px (top corners only on phone), controls and fact strips 8px, chips 6px, avatars and token icons round. The top card carries a 2px vertical rule inset 24px from its top and bottom edges: violet for an AI pick, orange when the action is urgent. Dashed borders mean "not your money or not analysed" (demo, read-only, other-chain groups); hatching means simulated.

## Components

### Buttons

- **Shape:** gently rounded (8px); 36px desktop, 44px on phone; small 32/40px.
- **Primary** (neutral solid, near-white on dark): one per screen — the #1 card's action, Connect wallet.
- **Secondary:** raised fill with a `line-strong` border. **Ghost:** text-2, no border.
- **Sign:** full-width, 52px, Signing Violet, white 17px/600, lock icon when gated, pen icon when ready. Disabled state is raised + text-disabled with a reason line under it ("Tick "I understand" above to unlock signing."); clicking it while disabled nudges and scrolls to the gate.
- **States:** press `scale(.97)` 160ms `cubic-bezier(.23,1,.32,1)`; hover only under `(hover:hover) and (pointer:fine)`, as a colour-mix toward text-1 (never opacity); focus is `outline: 2px solid accent; offset 2px`.

### Chips

- **Neutral:** transparent with `line-strong` border, text-2, optional icon (trend-up in Safe Mint for "Earning").
- **Risk:** tinted bg + line + colour (Idle = watch, Costs/Act = act, Liquidation = liq). Large status chip (28px) in the hero; in dark its tint is 20%.
- **AI:** accent-muted / accent ("AI-ranked", "#1 · ranked by AI"). **Demo:** overlay fill, text-1, hatched mark.

### Provenance mark

A 7px glyph before the source label in Meta type, text-3: filled dot = on-chain (with age), dashed ring = estimate, hatched square = simulated. Every displayed number has one on its section label.

### Cards / Containers

- **Panel:** surface, 1px `line`, 16px radius, 20×24 padding.
- **Top card (#1):** raised, no border, elev-1, 2px rule, "#1 · AI pick" in accent. Exactly one per list, the first not-done suggestion.
- **Act card:** `act-line` border; no gradient wash.
- **Facts strip:** 8px radius, surface mixed 3% toward text-1, hairline dividers; values 19/600, gains in Safe Mint.
- **Receipt:** safe-bg block that replaces the card body after a confirmed transaction, with the tx link.

### Inputs / Fields

- **Amount input:** inset well, `line-input` border (≥3:1), 24px/500 tabular value, token picker pill on the right. Focus: border becomes accent.
- Build requirements: `type=text inputMode=decimal`, Max, inline `aria-invalid` errors, integer base units, quote as `<output>` with updating and error states.

### Navigation

- **Top bar:** sticky, page at 90% with blur, 60px. Nav links text-2, active = text-1 on `active` fill. Wallet button: token stack + account, chevron rotates when the popover is open.
- **Wallet popover:** overlay, origin top-right, pop-in 160ms; Escape closes and returns focus.
- **Phone:** 3-tab bar with `aria-current`; active icon in accent. "For reviewers" leaves the top bar for a footer link.
- **Context strip:** first on the portfolio. Demo, read-only and your wallet each have their own chip; every strip has a "Switch view" menu (your wallet, both demos, look up an account). The deposit entry point is "Add funds" everywhere.

### Loan safety gauge (signature)

8px track with three zones (liquidation / watch / safe) whose boundaries come from the user's strategy, threshold marks at ≥3:1, "urgent" label above the bar and "liquidation"/"safe" below, "safe" starting at its mark, so they never collide, a 14px text-1 knob ringed in the surrounding surface. Always followed by a sentence: "Liquidation if X falls N%".

### Analysis panel (signature)

Order: header (AI-ranked chip, Run button with fixed width) → **verdict** → strategy → **what the agents found** → code-checks strip → decision pipeline.

- **Verdict:** a 48px tile + 28px/600 sentence. Tile is violet with the number of open moves, orange ⚠ when urgent, mint ✓ when nothing to do. This is the panel's single focal point.
- **Strategy:** a segmented control (native radios) followed by one line with the selected thresholds, numbers in bold text-1.
- **Findings:** four bordered 12px cards. Risk cards are tinted (watch 6%, act 7%) with a matching border and a coloured 26px icon disc; passed cards are neutral with a mint check; not-applicable cards are dashed.
- **Pipeline** sits last on an inset footer, in 13px: it is supporting evidence, not the headline.

### Intro (first visit, demo and read-only)

Three numbered stage cards (raised, violet number disc, 17px/600 title, 14px detail) and a trust column whose items lead with a bold claim and a violet icon (lock, shield, eye).

### Decision pipeline (signature)

Five steps with 14–16px dots. Done = accent dot with a drawn check and an accent connector that fills left to right; running = spinning ring; locked (no AI on this view) = dashed dot with lock and dashed connector. Step names text-1 when done, details text-2, timings text-3.

### Review & sign sheet (signature)

Order is fixed: balance changes (−/+ with token, amount, USD) → tiered warning with acknowledgement gate when loss > 5% → key facts inline → "What you will sign" steps → exact calls (collapsible, mono) → code-check line → sticky footer with Sign and its reason line. Signing progress replaces the body with numbered steps; the result appears in the footer; the portfolio updates only after the sheet closes (view transition card → receipt, count-up, row flash).

### Motion

Enter 280ms `cubic-bezier(.16,1,.3,1)`, exit 150ms ease-in; phone sheet slides from the bottom 400ms `cubic-bezier(.32,.72,0,1)` and drags to dismiss. Count-up 600ms ease-out-cubic. Row flash 1.6s safe-bg → transparent. Reduced motion keeps fades and colour changes and drops movement; spinners become a pulse.

## Do's and Don'ts

### Do:

- **Do** set every value, amount, asset name and conclusion in text-1; keep text-2 for details and labels and text-3 for provenance/timestamps.
- **Do** put the net worth on the page, not in a panel, as the only 56px number.
- **Do** mark the #1 suggestion with raised surface + elev-1 + the 2px rule, and give only it the primary button.
- **Do** show gains and losses with a sign and arrow as well as colour.
- **Do** keep the sign sheet one column and within 900px; show the reason whenever Sign is disabled.
- **Do** patch the DOM instead of re-rendering whole regions, so transitions play and focus and scroll survive.
- **Do** design the missing states with the same tokens: first-read skeleton, stale-data warning (RPC/price failure), empty wallet, AI run failure/timeout, quote failure inside the sheet.

### Don't:

- **Don't** use violet for anything that is not the AI or the user's decision.
- **Don't** tint neutral states; "Earning" is not a status alert.
- **Don't** add coloured glows or gradient washes to cards or buttons.
- **Don't** set content below 13px; 12px is for chips, provenance tags, column heads and mono only.
- **Don't** hide explanations behind tooltips or truncate them to shorten the page.
- **Don't** use a chain's brand colour as the product colour.
- **Don't** confuse the three contexts: demo (hatched, dashed), read-only (amber chip, dashed), your wallet (safe chip).
