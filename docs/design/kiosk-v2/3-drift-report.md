# Drift report

Source: `Metacomet-Technologies/factory` main @ `757250d` (2026-10-17). Paths are under `kiosk/` unless they start with `docs/`. Measurements come from the code running against `kiosk/mock` in Chromium 141 at 1728×1117, 1024×768 and 390×844, light and dark.

> This report describes **the shipped v1 code**, not the v2 system on the other pages. It is the before picture for MET-227. Items that v2 decides are cross-referenced in *Open questions › Decided in v2*.

## 1. Defects the code ships

| # | Where | What happens |
| --- | --- | --- |
| D1 | `src/index.css:53-58` | `--shadow-card: light-dark(<shadow>, <shadow>)` is invalid because `light-dark()` only accepts colours. Every `.panel`, `.ups-panel` and `[data-slot=card]` computes `box-shadow: none`. |
| D2 | `src/index.css:339-350` | The warn and fail halo (`0 0 0 3px` at 18%) is listed after `var(--shadow-card)` in the same declaration, so the whole declaration is invalid and alarm panels get only a border colour. |
| D3 | `src/index.css:59-62, 75` | `--glow` has the same `light-dark()` problem, so `html` computes `background-image: none` in both themes. |
| D4 | `src/index.css:1331-1349` | At ≥1280 px the sidebar spans rows 2–3 and is taller than UPS + Local LLM. The extra height goes to those rows, but `.panel-link > .panel` does not stretch, which leaves a 144 px gap under UPS and another under Local LLM (measured: link 324 px vs panel 180; 345 vs 201). |
| D5 | overview, error state | When the overview is in its error state, `main` scrolls: `scrollHeight` 1073 vs `clientHeight` 1024, a 49 px overflow, and Live requests is clipped. When reconnecting it overflows by 10 px. Only the steady state fits (1024 = 1024). |
| D6 | `src/index.css:1163-1169` + `components/devices-page.tsx:253` | `.device-list li { display:flex }` leaves the filesystem `MeterBar` at zero width, so the Filesystems panel shows no bar. |
| D7 | `components/sections.tsx:300-303` (`UsageSection`) | In the error state, Local LLM keeps `tone="warn"` and "Pricing update pending" next to "Unable to load this section". Pending comes from pricing, so the panel signals two unrelated states. |

## 2. Hard-coded values

| Where | Value | Should be |
| --- | --- | --- |
| `src/index.css:252` | `.brand-mark { color: #fff }` | `var(--primary-foreground)` |
| `src/index.css:253` | `linear-gradient(135deg, oklch(0.62 0.2 285), oklch(0.45 0.22 290))` | a single-hue gradient: the second stop uses hue **290**, a second purple |
| `src/index.css:254` | `oklch(0.5 0.2 285 / 70%)` shadow | derive from `--primary` |
| `src/index.css:251, 258, 370, 711, 746, 1021, 1101` | radii 10 / 8 / 8 / 8 / 8 / 8 / 8 px | `--radius-md` (or a new token for 10) |
| `src/index.css:658, 664` | toggle-group radius 9 px, item 7 px `!important` | radius tokens (`--radius-sm` 6 is unused) |
| `src/index.css:120` | focus outline radius 4 px | a token |
| `src/index.css:676, 1108, 1126` | `rgb(0 0 0 / 12%)`, `/ 60%`, `/ 50%` | shadow and scrim tokens |
| `src/index.css:56` | `0 0 0 1px rgb(0 0 0 / 0%)` | does nothing; delete it |
| `src/index.css:337, 577` | stagger `60ms`, ping `1.8s` | motion tokens |
| `components/charts/trend-chart.tsx:41-42, 60` · `components/ups-charts.tsx:65, 103, 178` · `components/ups-page.tsx:397-398` | chart duration 900, area opacities 0.45/0.02, 0.1, 0.8, 0.35/0 | one chart-fill rule |
| `components/ups-charts.tsx:114, 128` | reference-label `fontSize: 10` | the chart-axis style |
| `lib/motion.ts:20` | tween 600 ms (cubic ease-out in JS, not `--ease-out`) | a token, so CSS and JS share it |
| `components/sections.tsx:39-41` | Tailwind sizes `h-8 w-2/3`, `h-20 w-full`, `h-4 w-1/2` on Skeleton | fine to keep, but undocumented |
| `components/sections.tsx:405` | `disabled:opacity-100 disabled:pointer-events-auto` overrides Button | a Button state |
| `components/ups-page.tsx:134, 146, 151` | `toFixed(6)`, `toFixed(4)` | `lib/format.ts` (the guide forbids ad-hoc `toFixed`) |

## 3. CSS that duplicates a primitive

| Class | Where | Duplicates |
| --- | --- | --- |
| `.ups-panel` | `src/index.css:324-325, 403-404`; used `components/ups-controls.tsx:335, 350, 360` | `Panel`. It has no header, icon or `--i`, and uses an `<h3>Controls</h3>`. |
| `.ups-history` + `.section-head` | `src/index.css:961-970`; `components/ups-page.tsx:425-428` | `PanelHeader` (a section header without a Panel) |
| `.ups-trend table` | `src/index.css:1023-1040`; `components/ups-page.tsx:500-519` | `Table` |
| `.ups-settings input`, `.ups-control-setting input/select`, `.ups-confirm input` | `src/index.css:1011-1022` | no Input primitive exists |
| `.ups-confirm`, `.ups-confirm-backdrop` | `src/index.css:1104-1137`; Base UI `Dialog` used directly at `components/ups-controls.tsx:472-479` | no Dialog primitive exists |
| `.ups-pending`, `.ups-control-result` | `src/index.css:1095-1103`; `components/ups-controls.tsx:322, 346, 365` | `Alert` (+ the `.pending` variant at `src/index.css:696-701`) |
| `<p class="loading">Loading…</p>` | `components/ups-page.tsx:128, 174, 441, 443, 498, 557`; `components/devices-page.tsx:194` | `ResourceState` loading (Skeleton) |
| `<p role="alert" class="status-fail">` | `components/ups-page.tsx:124, 170, 431, 487, 493, 546`; `components/devices-page.tsx:105` | `ResourceState` error (Alert) |
| `.divider` | `src/index.css:478-482` | `Separator` (unused) |
| `.eyebrow` on an `<h3>` | `components/ups-page.tsx:122` | the eyebrow is a page-header element |
| list rows: `.agent-list li`, `.ticker li`, `.ups-events li`, `.device-list li` | `src/index.css:859-872, 990-997, 1163-1172` | four implementations of one hairline row list |
| `.spend-card::before` | `src/index.css:784-790` | a left accent bar on a tile, the "left-border card" trope |

## 4. Tokens and styles defined but unused

- `--radius-sm` (`src/index.css:29`): the only consumer is the tooltip's kbd selector, and no kbd is rendered.
- `--radius-xl`, `--font-heading`: used only by `ui/card.tsx`, which nothing imports. `--radius-4xl` is used only by `ui/badge.tsx`, which nothing imports.
- `--color-accent`, `--color-accent-foreground`, `--color-popover`, `--color-popover-foreground`, `--color-accent-text` (`src/index.css:14-24`): no `bg-accent`, `bg-popover` or `text-accent-text` utility appears. The `.accent-text` class is used instead.
- `--color-secondary(-foreground)`: used only by Button `secondary` and Badge `secondary`, and neither variant is used.
- Primitives nothing imports: `ui/badge.tsx`, `ui/card.tsx`, `ui/separator.tsx`, `ui/tabs.tsx`. Their dead overrides are `[data-slot=card]` at `src/index.css:678-684` (including `--tw-ring-shadow`) and `[data-slot=badge]` at `693-695`.
- Variants nothing uses: Button `secondary` and `link`, sizes `xs`, `sm`, `lg`, `icon-xs`, `icon-lg`.
- Selectors that match nothing: `.model-heading` (`src/index.css:806`), `.ups-range` (`983`), and `.ups-spark path { stroke-dasharray: 400 }` (`979-982`, left over from a removed draw animation).

## 5. Rules the code breaks

| Rule (`docs/agents/kiosk-styleguide.md`) | Violation |
| --- | --- |
| 3. Purple is brand only; status is ok/warn/fail/neutral | `tone="accent"` for unknown host health, `components/sections.tsx:124, 184` |
| 2. Never add a new hue | brand-mark gradient hue 290, `src/index.css:253` |
| 4. Every text/icon colour reaches AA in both themes | light `warn` chip text is 4.39:1 on a tile and 4.37:1 on the page. Tabs inactive text is 4.34:1 on `muted` (light). Crumb separator is 2.49:1 (light). |
| 4 / Contrast check 3. Never use opacity on text for stale or disabled | `.crumb-sep { opacity: .6 }` `src/index.css:232`; `disabled:opacity-50` in `ui/button.tsx:6`, `ui/toggle.tsx:6`, `ui/tabs.tsx:53`; `text-foreground/60` `ui/tabs.tsx:53`; `text-destructive/90` `ui/alert.tsx:12`. A disabled primary button's label is 1.56:1 in light. |
| WCAG 1.4.11 (implied by "AA minimum") | Control boundaries: inputs `border-strong` 1.69:1 (light) / 1.71:1 (dark) on card; toggle-group track `border` 1.37:1 / 1.33:1. A MeterBar warn marker on an ok fill is 1.08:1, distinguished by hue only. |
| 6. One `main.dashboard`, PageHeader, then Panels | UPS page wraps a bare `<section class="ups-history">` and `.ups-chart-grid` divs (`components/ups-page.tsx:425, 453`); Controls is not a Panel. |
| 7. 1728×1117 shows the whole overview without scrolling | breaks in the error state (+49 px) and when reconnecting (+10 px); see D5 |
| Live data: ResourceState at the top of any Panel with a Resource | UPS and devices pages (section 3) |
| Layout: navigation is plain `<a href>` | `UpsBadge` uses `onClick={() => window.location.assign("/ups")}`, `components/ups.tsx:49`, which forces a full reload |
| Hover: panel-link and tile-link "strengthen the border" | panel-link hovers to `border-strong` (`src/index.css:425`), tile-link to `accent-text` (`444`): two hover languages |

## 6. Guide and README vs code (the code's value is recorded)

| Topic | Guide or README says | Code does |
| --- | --- | --- |
| Where tokens live | the `:root` block in `index.css` | `--background` and `--foreground` are in `index.html:23-24` |
| One `light-dark()` per token | every token | `--primary` and `--primary-foreground` are single values (`src/index.css:44-45`); `--shadow-card` and `--glow` use `light-dark()` invalidly |
| Light `--ok` | `#007a46`, 5.4:1 | `oklch(0.47 0.14 160)` = `#00713e`, **6.12:1** on card |
| Chip tint | 14% | 12% background, 28% border (`src/index.css:548-549`) |
| Chip text contrast | "4.4:1 or better" light | 4.37 worst (warn on page) |
| MeterBar motion | width on `--dur` | `--dur-slow` (`src/index.css:622`) |
| GPU chart (README) | primary fill with an accent-text outline | accent-text stroke and accent-text gradient fill (`components/charts/trend-chart.tsx:41-55`) |
| Disabled (README) | 50% opacity, exempt | guide: never opacity |
| Theme | `kiosk.md`: "follows the system; never force a default" | follows the system unless the user toggles; the override persists in `localStorage["factory-theme"]` and clears when it matches the system (`App.tsx:160-178`, `index.html:7-19`) |
| Muted-foreground on muted (guide) | 5.2:1 light, 6.8:1 dark | 5.17 / 6.75 (consistent; rounding) |

## 7. What the guide does not cover

- Primitives with no entry: Badge, Card, Separator, Skeleton, Toggle, ToggleGroup. Tile, ResourceState, Warnings, TopBar and VersionFooter are mentioned only in passing.
- No type scale: sizes, weights (400/500/550/600/650/700), letter-spacing and line-heights are only in CSS.
- No spacing or density table: 18/14/16 panel padding, grid gaps 16/12, page padding 24×32 → 10/12 top/bottom, tile 14 → 10×12.
- Breakpoints: 640 and 900 px are not mentioned (900 is UPS controls only). Only "≥1280" and "≤640 screenshots" appear.
- Forms, inputs, dialogs, typed confirmation and destructive tiers (all of UPS Controls).
- Chart conventions: accent primary series, muted-foreground dashed secondary, warn dashed thresholds, 10 px labels.
- Copy and state patterns: "—" for null, "Waiting for…", "Retrying on the next refresh.", "stale ·", "observed N min ago".
- Radii for controls: Tailwind's `rounded-lg` resolves to the kiosk's 12 px, so buttons and alerts are 12 px, as round as panels.
- Iconography: lucide sizes 14, 15, 16 and 20 px; panel icon tile.

## 8. Evidence drift

- `kiosk/screenshots/*.png` and `checks.json` were last committed in #12 (2026-10-11), before the MET-198 overhaul (#97, 2026-10-17). They show the old layout (no UPS panel, no breadcrumbs or footer, model table on the overview) and the old hue 300 tokens (`checks.json`: `oklch(38% .17 300)`). Compared at 1728×1117, 10.6% of pixels differ from the current code (dark) and 10.3% (light).
- `scripts/screenshots.ts` asserts the old overview (`"$3.41 priced"`, a visible `.model-table`) and would fail against the current code.
