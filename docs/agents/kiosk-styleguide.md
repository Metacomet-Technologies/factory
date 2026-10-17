# Kiosk style guide

How to build or change a kiosk page so it matches the rest of the dashboard.
Read this before touching `kiosk/src`. The rules are short on purpose; the
primitives do the heavy lifting, so prefer composing them over writing CSS.

## Golden rules

1. Compose pages from the primitives in `kiosk/src/components/ui/`. Do not
   hand-roll cards, stats, chips, bars or range switches.
2. Colors come from the tokens in `kiosk/src/index.css` (`:root` block). Never
   write hex or oklch values in components, and never add a new hue.
3. Purple is the brand accent only. Status is always `ok` / `warn` / `fail`
   (green / amber / red) or `neutral`.
4. Every text and icon color must reach WCAG AA (4.5:1) in both themes. Stale
   data uses the muted color, never reduced opacity.
5. Motion is CSS or Recharts only, no animation libraries. Every animation
   must respect `prefers-reduced-motion`.
6. One page = one `<main className="dashboard …">` containing a `PageHeader`
   followed by `Panel`s. The top bar and footer are owned by `App.tsx`; the
   area between them scrolls.
7. The 1728×1117 kiosk display must show the whole overview without
   scrolling. Check the ≥1280 px density rules in `index.css` after adding
   anything to the dashboard grid.

## Tokens (`kiosk/src/index.css`)

| Token | Use |
| --- | --- |
| `--background`, `--card`, `--muted` | page, panel and sub-surface backgrounds |
| `--foreground`, `--muted-foreground` | primary and secondary text (both AA on all three surfaces) |
| `--border`, `--border-strong` | resting and hover borders |
| `--primary`, `--primary-foreground` | filled buttons and the brand mark |
| `--accent-text`, `--accent-soft` | links, focus rings, chart series, soft accent fills |
| `--ok`, `--warn`, `--fail` | status only |
| `--radius-sm/md/lg/xl` | 6 / 8 / 12 / 14 px corners |
| `--dur-fast`, `--dur`, `--dur-slow`, `--ease-out` | 160 / 320 / 640 ms and the shared easing curve |

Light and dark values live in one `light-dark()` declaration per token, so a
new token needs both values at once. Theme follows the system unless the user
toggles it; never force a default.

## Primitives

All optional props accept `undefined` explicitly (`exactOptionalPropertyTypes`
is on).

- `Panel` (`ui/panel.tsx`): the card. `title`, `subtitle`, `icon`, `action`
  (right-aligned control or chip), `tone` tints the border for alarms,
  `index` staggers the entrance animation. Renders a `<section
  aria-label={title}>`, so tests can use `getByRole("region", { name })`.
  Pass `aria-label` to override. `Tile` is the bordered sub-surface inside a
  Panel (fleet node, spend card, model card).
- `Stat` / `StatGrid` (`ui/stat.tsx`): label above a tabular number. Pass a
  numeric `value` plus `format` so live changes tween; strings render as-is.
  `size` is `lg` for hero totals, `md` for card metrics, `sm` for dense rows.
  `StatGrid columns={n}` lays Stats out in equal columns.
- `StatusChip` / `StatusText` (`ui/status-chip.tsx`): pill or inline text
  with a `Tone` (`ok | warn | fail | neutral | accent`). `dot` adds the
  status dot, `pulse` animates it for active alarms.
- `MeterBar` (`ui/meter-bar.tsx`): native `<progress>` with optional
  threshold markers; `tone="muted"` for stale readings.
- `RangeToggle` (`ui/range-toggle.tsx`): segmented control for time ranges;
  buttons expose `aria-pressed`.
- `KeyValue` (`ui/key-value.tsx`): definition list of label/value rows.
- `PageHeader` (`ui/page-header.tsx`): eyebrow + title on the left, aside on
  the right. Every routed page starts with one.
- `LiveIndicator` (`ui/live-indicator.tsx`): the stream status pill in the top
  bar; takes `useStream().status`.
- `TrendChart` (`charts/trend-chart.tsx`): one accent area over time with
  gradient fill and tooltip. Import it only from a lazily loaded module so
  Recharts stays out of the main bundle (see `gpu-chart.tsx`).
- shadcn/Base UI components (`ui/button.tsx`, `ui/alert.tsx`, `ui/table.tsx`,
  `ui/tooltip.tsx`, `ui/tabs.tsx`, `ui/chart.tsx`) for anything interactive.

Formatting helpers live in `kiosk/src/lib/format.ts` (`count`, `usd`, `ms`,
`number`, `seen`, `time`). Use them instead of ad-hoc `toFixed`.

## Layout

- Top bar: brand mark + `factory` link home, then breadcrumbs derived from
  the path (`crumbs()` in `App.tsx`). Every crumb except the last is a link to
  the higher level; `devices` returns to the dashboard because devices live in
  the Fleet grid.
- Dashboard overview (`/`): the `.dashboard-grid`. Sections that have a
  details page render as a `<a className="panel-link">` wrapping a compact
  `Panel` with KPIs only (see `UsageSection`, `UpsSection`). Put tables,
  charts with controls and long lists on the details page, not the overview.
- Details pages (`/ups`, `/llm`, `/devices/<id>`): `PageHeader` then stacked
  Panels. Add `className="<name>-page"` and extend the
  `.ups-page, .devices-page, .llm-page` rule when you need page-level spacing.
- Fleet node tiles that match a device from `/v1/devices` render as
  `<a className="tile-link">` to the device page. There is no separate
  devices list page.
- Navigation: plain `<a href="/…">`. `App.tsx` intercepts same-origin clicks
  at the document level and pushes history, so components never call
  `history.pushState` themselves.

## Motion

- Entrance: Panels fade and rise with `index`-based stagger
  (`.panel { animation: panel-in … }`). Keep new sections in the same scheme.
- Live numbers: `useAnimatedNumber` tweens Stats over 600 ms with ease-out.
- Charts: Recharts `isAnimationActive={!reduced}` with `animationDuration={900}`.
- Bars: `MeterBar` width transitions on `--dur`.
- Hover: `.panel-link` and `.tile-link` lift 1 px and strengthen the border.
- `useReducedMotion()` (`lib/motion.ts`) must gate every animation; the
  global `@media (prefers-reduced-motion: reduce)` block disables CSS
  animations, and components pass `!reduced` to Recharts and tweens.

## Live data

- `useApi(path, query, revision)` fetches JSON and refetches when `revision`
  changes; `useStream()` owns the SSE connection and returns `status`
  (`connecting | live | reconnecting`), revision counters and the latest
  samples.
- The stream reconnects on `error`, after 45 s of silence, and on
  `online` / `visibilitychange` / `pageshow`, with jittered backoff from 1 s
  to 30 s. Do not add a second EventSource; bump a revision in
  `streamReducer` instead and let `useApi` refetch.
- Show `ResourceState` (loading skeleton, error alert, empty text) at the top
  of any Panel that renders a `Resource`.

## Contrast check

1. Render both themes at 1728×1117 (`agent-browser set viewport 1728 1117 1`,
   toggle with `localStorage.setItem('factory-theme','dark')`).
2. Compute WCAG ratios for every new text/background pair; the measured values
   for the current tokens are listed in `kiosk/README.md` under "Accent and
   contrast". Anything below 4.5:1 (3:1 for large text) is a bug.
3. Never use opacity on text to indicate stale or disabled state.

## Checklist before opening a PR

- `vp fmt`, `vp check`, `vp test --run`, `vp build` from `kiosk/`
  (`OPENAPI_URL=file:///…/factory-api/openapi.json vp check` when offline).
- Screenshots of every changed page in light and dark at 1728×1117 and at a
  narrow width (≤ 640 px), inspected, saved under `.amp/in/artifacts/`.
- Tests assert through roles and visible text (`getByRole("region", { name })`,
  `getByText`), not class names.
- No new dependencies, no inline colors, no `history.pushState` in components.
