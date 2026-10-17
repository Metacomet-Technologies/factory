# Patterns

## App frame

`#root` is the stage (`.fk-stage`): a 100dvh box with `Backdrop` absolutely behind everything and the app (`.fk-app`) above it at `z-index: 1`. `TopBar` and `VersionFooter` are `flex: none` glass strips (60–70% `background`, blurred). `<main class="dashboard">` is the only scroller, max 1728 px and centred. A skip link targets `#main`. The backdrop is fixed to the viewport, so the ridgeline stays put while `main` scrolls.

## Page anatomy

```
<div class="fk-stage">
  <Backdrop ambient="both" />
  <div class="fk-app">
    <TopBar />
    <main id="main" class="dashboard">
      <PageHeader eyebrow title aside />
      <Verdict issues okCount />          ← overview only
      Panel · Panel · Panel …
    </main>
    <VersionFooter />
  </div>
</div>
```

- Every routed page starts with a `PageHeader`. The overview follows it with the **Verdict strip**, which rolls every fail and warn on the page into one line. The worst tone colours the strip ring. Fail issues are solid chips with icons, and warn issues are tinted chips with dots. It ends with "N other checks OK". With no issues it collapses to "All systems nominal".
- Content is glass `Panel`s. Group things inside a Panel with `Tile`s and lay out numbers with `StatGrid`. A Panel has one action.
- Mark at most one number per panel as the hero (`Stat tone="accent" className="fk-hero"`). It is set in teal and flashes on the event pulse. On the overview that is GPU utilization.
- Any Panel that renders a fetched Resource begins with `ResourceState`.

## Overview vs details pages

| | Overview `/` | Details `/ups`, `/llm`, `/devices/<id>` |
| --- | --- | --- |
| Purpose | glanceable KPIs from across the room | everything about one area |
| Content | stats, chips, one 44 px trend, meters | tables, tall charts (220 px), forms, event lists, controls |
| Grid | `.dashboard-grid` (below) | `.details-page`: stacked grid, gap 16. UPS adds `.ups-chart-grid` (2 columns ≥640) and devices `.device-grid` (3 columns ≥640). |
| Controls | range toggles only | ranges, settings forms, typed-confirmation actions |
| Scrolling | must not scroll at 1728×1117 | scrolls inside `main` |

Put tables, charts with controls and long lists on the details page, never on the overview.

## panel-link and tile-link

- **Hover language is one ink.** Both links go to `accent-text` on hover and lift 1 px over `dur`.
- **panel-link.** A section with a details page renders as `<a class="panel-link <area>" aria-label="…">` wrapping a compact Panel (UPS, Local LLM). The action chip carries an `ArrowUpRight` ("Details ↗", or the alarm word with ↗).
- **tile-link.** A fleet node that matches a `/v1/devices` entry renders as `<a class="tile-link" href="/devices/<id>">` around its Tile. Its `h3` gets an `ArrowUpRight` in `accent-text`. Devices with no fleet node get their own tile-link ("Device collector only · not a fleet node"). There is no devices list page.
- Navigation is a plain `<a href>`. `App.tsx` intercepts same-origin clicks and pushes history, so components never call `pushState` themselves.

## The 1728×1117 no-scroll overview

At ≥1280 px the grid is `minmax(0,1fr) minmax(0,1fr) minmax(0,0.92fr)` with rows `auto auto auto 1fr`, gap 12:

```
row 1  Fleet (cols 1–2)                       ┐
row 2  GPU (cols 1–2: stats 2×2 | comet)      │ sidebar (col 3, rows 1–4):
row 3  UPS (col 1)     Local LLM (col 2)      │ Frontier CLIs, Live requests
row 4  — open: the ridgeline shows through —  ┘
```

- Rows hug their content and the spare height falls to row 4, so no panel stretches and the range is visible below UPS and Local LLM.
- GPU runs wide: a 2×2 stat block (utilization is the hero) beside a 92 px comet trend.
- UPS puts Charge and its meter across the top, then Runtime, Load and Input/output in three auto columns.
- The sidebar owns column 3 from top to bottom. The ticker's `role="log"` keeps its own scroll cap, so new requests never grow the page.

Measured at 1728×1117 in both themes: Fleet 210, GPU 215, UPS 241, Local LLM 196, sidebar 797 of the 1028 px in `main`. `main.scrollHeight` equals `clientHeight` (1028 = 1028), with about 60 px to spare in column 3. After adding anything, re-measure `scrollHeight ≤ clientHeight` in every state: steady, loading, error, outage and reconnecting. At 1280×800 the page scrolls inside `main` with no horizontal overflow.

## 640–1279 px

Two columns at gap 16. Fleet and GPU take one column each. UPS and Local LLM span both. The sidebar spans both as two columns (Frontier CLIs | Live requests). Kiosk density is off: panel padding 18, num-lg 30, num 20, trend 88.

## Narrow width (< 640 px)

- One column at gap 16. The page pads 20 / 14 / 100 at the bottom, so the last panel clears the footer.
- Top bar 10 × 14. The brand mark hides and the wordmark and crumbs drop to 15 px. LiveIndicator is 11 px. Header actions sit at gap 2.
- The page header stacks and the aside left-aligns. The title is 23 px. Panel padding is 16. Stat lg is 26.
- LLM model performance switches from the Table to per-model Tile + KeyValue cards (`.model-table` hidden, `.model-cards` shown).
- Agent windows go back to the two-row grid (name and meter above, percent and reset beside).
- UPS readings are 2-up, and the energy and chart grids are 1-up.

## Destructive actions (UPS Controls)

Actions come in three tiers: Safe, Settings and Power. Power buttons use the `destructive` variant and show their consequence text. Every action opens a Base UI Dialog that requires the exact `confirm_phrase` to be typed and counts down to expiry. While the factory is going down, a warn-bordered pending banner watches API health. This flow has no primitives yet (Open questions).

## Event pulse

When fresh data lands (a poll completes or a stream message arrives), call `pulse(root)` once. The Live chip throws a teal ripple and every `.fk-hero` flashes once over `dur-event`. Don't pulse on a timer that isn't tied to data, and don't pulse more than once per refresh. The overview mock pulses every 8 s only to demonstrate it.

## Ambient by context

| Context | `ambient` | Why |
| --- | --- | --- |
| Kiosk wall display | `both` | the full scene, judged from across the room |
| Laptop and details pages | `sweep` | the light without the night sky behind dense tables |
| Phone | `none` | battery life and small-screen focus |
| Reduced motion | any | renders as a still frame |
| GPU fallback | static image | if MET-227's spike shows dropped frames |
