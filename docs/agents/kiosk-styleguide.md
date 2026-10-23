# Kiosk style guide

How to build or change a kiosk page so it matches design system v2, "Snake
River dusk" (`docs/design/kiosk-v2/`). Read this before touching `kiosk/src`.
The spec is design data: `tokens.json` is the source of the palette,
`components/*/README.md` describes each primitive, and this file records how
the kiosk applies them and where it deviates. The rules are short on purpose;
the primitives do the heavy lifting, so prefer composing them over writing CSS.

## Golden rules

1. Compose pages from the primitives in `kiosk/src/components/ui/`. Do not
   hand-roll cards, stats, chips, bars or range switches.
2. Colors come from the tokens in `kiosk/src/index.css` (`:root` block; only
   `--background` and `--foreground` live in `index.html` so the first frame
   paints before the bundle). Never write hex values in components, and never
   add a new hue.
3. One brand hue. Teal (`--primary`) is for the mark, links, focus rings,
   chart lines, glow and hero numbers. Status is always `ok` / `warn` / `fail`
   (meadow green / gold / red-orange) or `neutral`; teal is never a status.
   `fail` always renders as a filled chip with the triangle icon.
4. Every text/background pair reaches 4.5:1 and every control boundary
   reaches 3:1 in both themes, measured over the scene (the screenshot script
   does this). Stale or disabled state uses `--muted-foreground` plus
   `--border-control`, never opacity on text.
5. Motion is CSS or Recharts only, no animation libraries. `prefers-reduced-
   motion: reduce` stops everything: the scene, the pulses, the entrance
   stagger, the chart draw and the number tweens.
6. One page = one `<main className="dashboard …">` containing a `PageHeader`
   followed by `Panel`s. `App.tsx` owns the top bar, the Verdict strip, the
   ambient scene and the footer.
7. The 1728×1117 kiosk display shows the whole overview without scrolling in
   every state (steady, loading, error, outage, reconnecting). The screenshot
   script fails if the document or `.dashboard` overflows. Check the ≥1280 px
   grid in `index.css` after adding anything to the overview.

## Tokens (`kiosk/src/index.css`)

Light ("dawn") and dark are equals: every token is one `light-dark()`
declaration, so a new token needs both values at once. The theme follows the
system; the top-bar toggle writes the sticky `factory-theme` override and
`index.html` applies it before the first paint.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--background` | `#f2f6f7` | `#0d1218` | page ground under the scene |
| `--card` | `#ffffff` | `#101820` | panel glass tint (at `--glass-alpha`) |
| `--muted` | `#e7eef0` | `#17222c` | sub-surfaces, meter tracks, disabled fills |
| `--foreground` | `#102026` | `#eef4f6` | primary text |
| `--muted-foreground` | `#4f6169` | `#9fb0ba` | secondary text, stale readings |
| `--border` / `--border-strong` | 10% / 18% ink | 9% / 18% white | resting and hover edges on tiles and rows |
| `--border-control` | `#718389` | `#728894` | the only border that must read alone (≥ 3:1): buttons, toggles, inputs, disabled controls |
| `--primary` / `--primary-foreground` | `#00756c` / `#ffffff` | `#3fd1c2` / `#06201d` | brand teal, filled buttons, the mark |
| `--accent-text`, `--accent-soft` | `= --primary`, 12% teal | `= --primary`, 14% teal | links, focus rings, chart line, soft accent fills |
| `--glow` | `#e0895a` | `#f2a477` | alpenglow; scene only |
| `--ok` | `#25661a` | `#7ee081` | status only |
| `--warn` | `#7a5800` | `#ffd447` | status only |
| `--fail` | `#ad2d17` | `#ff6a4f` | status only |
| `--on-status` | `#ffffff` | `#120b08` | text on a filled status chip |
| `--sky-0…4`, `--ridge-far/mid/near`, `--snow` | see `:root` | | scene gradient stops and the ridgeline |
| `--glass-*` | see below | | glass edge, sheen, glint, drop shadow, alpha, blur, saturation |
| `--shadow-glass`, `--shadow-tone-warn/fail`, `--shadow-mark` | | | depth and tone rings; the old `--shadow-card`/`--glow` shadows are gone |
| `--radius-sm` 6 / `-md` 8 / `-lg` 12 px, `--radius-glass` 14 px, `--radius-pill` | | | the only radii: `sm` toggle items, `md` controls and fields (shadcn `rounded-md`; buttons no longer use `rounded-lg`), tiles and icon chips, `lg` alerts and dialogs, `glass` panels, `pill` chips. `radius-xl` / `radius-4xl` are gone; never write a pixel radius |
| `--dur-fast/-/-slow` 160/320/640 ms, `--dur-tween` 600, `--dur-draw` 900, `--dur-event` 1200, `--dur-ping` 1800, `--dur-sweep` 60 s, `--dur-aurora` 48 s, `--dur-twinkle` 6 s, `--ease-out`, `--stagger` 60 ms | | | motion |

Deviations from `tokens.json`, each one step away to clear AA over the scene
(the screenshot audit measures them; comments in `index.css` repeat the why):

- dark `--glass-alpha` 78% (spec 68%): status text on a tile over the lit
  snow peaks.
- dark `--fail` `#ff6a4f` (spec `#ff5a3d`) and light `--ok` `#25661a` (spec
  `#286d1a`): "Failing" / "OK" text on chips and tiles.
- dark `--border-control` `#728894` (spec `#6a808c`): toggle and button
  outlines at 3:1 on glass.
- Top bar and footer tint at `--glass-alpha`, not 60%, so the footer SHAs
  stay above 4.5:1 over the sky.

Measured minimums with the current tokens (`kiosk/screenshots/checks.json`):
text 4.54:1 ("Failing · —" at 1024 and 390 dark), 5.09:1 at 1728 dark,
5.15:1 at 1728 light; controls 3.09:1 (pressed "1h" border at 390 light),
3.66:1 / 3.53:1 at 1728 dark / light. If you change a token, run the
screenshot script and keep every pair above its floor.

## Surfaces: liquid glass

`.panel` (and `.ups-panel`, the top bar, the footer) is frosted glass over
the scene: `color-mix(var(--card) var(--glass-alpha))` tint,
`backdrop-filter: blur(18px) saturate(170%)`, a 1 px `--glass-edge` border,
a `::before` specular glint in the top-left corner, and `--shadow-glass` (an
inner sheen line top and bottom plus a soft depth drop). Warning and failure
panels add `--shadow-tone-warn/fail`: a 1 px inset ring and a glow in the
status color. Nothing else draws its own shadow.

The scene is fixed behind `#root` (`isolation: isolate`) so the glass blurs
it. `?ambient=static` turns the blur off and paints a pre-rendered, blurred
sky into the panels instead (`--fk-static-sky`); keep new glass surfaces in
the `:root[data-ambient="static"]` rule.

## Scene and ambient motion (`kiosk/src/ambient/`)

`AmbientScene` renders the sky gradient, the night layer and the Teton
ridgeline band (far ridge, near ridge with snow on the high peaks, teal rim
light) at the bottom of the frame. The ridgeline is generated from hand-placed
points in `scene.tsx`; do not trace a photo. Modes (`mode.ts`):

| Mode | What runs | How to get it |
| --- | --- | --- |
| `both` (default) | 60 s alpenglow sweep; at night, 50 twinkling stars and two aurora ellipses. Dawn shows the sweep only. | the plain URL |
| `sweep` | the sweep alone | `?ambient=sweep` |
| `static` | the sweep; `backdrop-filter` off, panels paint the pre-blurred sky | `?ambient=static` |
| `none` | still scene, no sweep | `?ambient=none` |

Unknown values fall back to `both`. `?perf=1` starts the frame sampler
(`perf.ts`, `window.__ambientPerf`) for `kiosk/scripts/ambient-trial.sh`.
"Night" means the dark theme, so dawn mode never shows stars or aurora. The
v1 look no longer exists.

Event pulses (`lib/motion.ts` `pulse()`, called once per data refresh in
`App.tsx`): the Live chip throws one `.fk-ripple`, every `.fk-hero
.stat-value` flashes once over `--dur-event`, and new request-ticker rows
slide in (`.ticker li.fk-new`, `row-in`). All of it is CSS keyframes;
`pulse()` returns early under reduced motion and the global
`@media (prefers-reduced-motion: reduce)` block disables every keyframe, so
`document.getAnimations()` is empty. The screenshot and ambient scripts assert
that.

## Primitives

All optional props accept `undefined` explicitly (`exactOptionalPropertyTypes`
is on).

- `Panel` (`ui/panel.tsx`): the glass card. `title`, `subtitle`, `icon`,
  `action` (right-aligned control or chip), `tone="warn" | "fail"` adds the
  tone ring, `index` staggers the entrance. Renders `<section
  aria-label={title}>`, so tests use `getByRole("region", { name })`. `Tile`
  is the bordered sub-surface inside a Panel (fleet node, spend card).
- `Verdict` (`ui/verdict.tsx`, data from `lib/verdict.ts`): the strip under
  the header. "N need attention" with one chip per issue (failures first) and
  "M other checks OK", or one calm line when nothing is wrong. Add a new
  overview signal to `verdict()`, not to the component.
- `Stat` / `StatGrid` (`ui/stat.tsx`): label above a Geist Mono number. Pass a
  numeric `value` plus `format` so live changes tween. `size` is `lg` for hero
  totals (give the container `fk-hero` so it flashes on a pulse), `md` for
  card metrics, `sm` for dense rows. `tone="accent"` is the only teal number.
- `StatusChip` / `StatusText` (`ui/status-chip.tsx`): pill or inline text
  with a `Tone` (`ok | warn | fail | neutral | accent`). `fail` is filled with
  the triangle icon (`icon={false}` only inside a tile that already shows
  one); `ok` and `warn` are tinted. `dot` adds the status dot, `pulse`
  animates it for active alarms. Unknown host health is `neutral`.
- `MeterBar` (`ui/meter-bar.tsx`): native `<progress>` for semantics under a
  `.meter-fill` sized by `--fill`, with optional threshold markers;
  `tone="muted"` for stale readings. Give it a grid cell or a block, not a
  flex row with other content, or it collapses to zero width (the filesystem
  rows on the device page are a grid for this reason).
- `RangeToggle` (`ui/range-toggle.tsx`): segmented control; the pressed
  segment gets a `--border-control` outline so the state reads at 3:1.
- `Input` (`ui/input.tsx`, Base UI) and `Select` (`ui/select.tsx`): glass
  fields (`.field`): the card tint at `--glass-alpha`, a `--border-control`
  outline (≥ 3:1), `radius-md`, the teal focus ring, `--fail` border when
  `aria-invalid`, and the muted fill when disabled. `Select` is a native
  `<select>` with a chevron so phones get the system picker and the value
  stays a form value. Label every field with `<label htmlFor>`.
- `Dialog`, `DialogContent`, `DialogTitle`, `DialogDescription`
  (`ui/dialog.tsx`, Base UI): a modal glass sheet (`radius-lg`, glass blur,
  `--shadow-glass`) over a dimmed backdrop; focus is trapped while open and
  Escape closes it through `onOpenChange`. UPS Controls' typed confirmation
  is the only dialog; keep any new one read-only unless it is a control.
- `Alert` (`radius-lg`): `variant="destructive"` for errors (via
  `ResourceState`); the default for results; add `className="pending"` for the
  warn tone (UPS pending power banner, pricing pending). Pass `role="status"`
  for non-error announcements.
- `Separator` (`ui/separator.tsx`): the hairline between blocks inside a
  Tile (fleet nodes). There is no `.divider` class.
- `KeyValue`, `PageHeader`, `LiveIndicator` (`.live-indicator`, the ripple
  target), `Button`, `Table`, `Tooltip` as before. `Badge`, `Card` and `Tabs`
  were deleted in MET-228: use `StatusChip`, `Panel` / `Tile` and
  `RangeToggle`. A test in `ui/primitives.test.tsx` fails if they, the old
  radius tokens or `.divider` come back.
- ↗ (`ArrowUpRight`) only ever marks navigation: a tile or panel that is a
  link. Never use it as decoration (the spend cards no longer carry it or
  their accent bar).
- `TrendChart` (`charts/trend-chart.tsx`): the comet trail by default: a teal
  stroke fading in from the left with a bright "now" head and halo; no fill.
  `variant="area"` keeps the gradient area for distributions (devices
  chart). Import it only from a lazily loaded module so Recharts stays out of
  the main bundle.

Formatting helpers live in `kiosk/src/lib/format.ts`. Use them instead of
ad-hoc `toFixed`.

## Type

Geist for UI and Geist Mono for numbers, from `@fontsource/geist` and
`@fontsource/geist-mono` (exact versions in `package.json`, latin 400–700,
`font-display: swap`, imported in `main.tsx`). `index.html` preloads the 400
and 600 WOFF2 files for both families; Vite rewrites the `node_modules` paths
to hashed assets. No CDN. `--font-sans` / `--font-mono` are the only font
stacks; numbers get `tabular-nums` from `body`.

## Layout

- Top bar: brand mark (teal, one hue) + `factory` link home, then breadcrumbs
  derived from the path (`crumbs()` in `App.tsx`). Crumb separators use
  `--muted-foreground`, not opacity.
- Overview (`/`): `.dashboard-grid`. At ≥1280 px it is three columns plus a
  1.38fr sidebar, rows `auto auto auto 1fr`: Fleet, GPU, then UPS / Local LLM
  / Network on one row (the spec draws two columns there; three keeps the
  overview from scrolling at the kiosk size), with Frontier CLIs and Live
  requests in the sidebar. Sections with a details page render as `<a
  className="panel-link">` wrapping a compact `Panel`.
- Details pages (`/ups`, `/llm`, `/network`, `/devices/<id>`): `PageHeader`
  then stacked Panels; the dashboard area scrolls there.
- Navigation: plain `<a href="/…">`; `App.tsx` intercepts same-origin clicks.
  An icon that navigates (the UPS badge in the top bar) is an `<a>` styled
  with `buttonVariants({ variant: "ghost", size: "icon" })`, never a button
  calling `window.location`.
- Topology page (`/topology`, `kiosk/src/topology/`, MET-226): a static React
  Flow map of the factory. Boxes, groups, edges and flows live in
  `topology.ts`; edge geometry is routed at runtime by `router.ts` over that
  data (`routes.ts` caches one routing per flow), so a new box is one entry in
  the node list plus its id in a group's `nodes` and any edges that touch it.
  `@xyflow/react` loads only on this route (`lazy()` in `App.tsx`), so the
  overview chunk stays free of it; `topology.test.ts` walks the static imports
  to keep it that way. Colors come from tokens via `topology.css`; the
  "How … works" steps open a native `popover`.

## Live data

- `useApi(path, query, revision)` fetches JSON and refetches when `revision`
  changes; `useStream()` owns the SSE connection and returns `status`
  (`connecting | live | reconnecting`), revision counters and the latest
  samples. Each refresh calls `pulse()` once.
- Wrap frequently bumped resources in `useHeld` so the last response stays on
  screen during a refetch.
- The stream reconnects on `error`, after 45 s of silence, and on
  `online` / `visibilitychange` / `pageshow`, with jittered backoff. Do not
  add a second EventSource.
- `ResourceState` (skeleton, destructive `Alert`, empty text) is the only
  loading and error UI. Pass `resource={…}` for a `Resource`, or
  `loading` / `error` for anything else (the device view, paged events, a
  lazy chunk's `Suspense` fallback); `title` names a partial failure ("GPU
  overlay unavailable"). Put it at the top of the Panel or section it
  describes. Never write "Loading…" text or a hand-rolled `role="alert"`
  paragraph; `details-states.test.tsx` checks every details page. The UPS
  Controls error view stays verbatim (MET-168) and is the one exception.
  Error and reconnecting states must not grow the overview past the
  viewport.

## Checks

From `kiosk/` after `source /home/agent/.config/vite-plus/env`:

- `vp check` (`OPENAPI_URL=file:///…/factory-api/openapi.json vp check`
  offline), `vp test --run`, `vp build`.
- `vp run screenshots` (`PLAYWRIGHT_BROWSERS_PATH` to the Playwright cache;
  about five minutes): regenerates `kiosk/screenshots/`, asserts the first
  frame paints the right theme, no scroll at 1728×1117 in light and dark for
  steady, loading, error, outage and reconnecting, every text pair ≥ 4.5:1 and
  every control boundary ≥ 3:1 measured in the browser over the worst-case
  scene, and zero running animations under reduced motion. Results in
  `screenshots/checks.json`.
- `vp run ambient:check` against the mock preview or this worktree's sandbox:
  the default URL is `both`, every `?ambient=` override renders its scene,
  panels keep the glass blur and tone rings, nothing scrolls, and reduced
  motion stops everything. Results in `.amp/in/artifacts/ambient/`.
- `kiosk/scripts/ambient-trial.sh both` on the console for the 15%-of-all-cores
  rule (MET-237).

## Checklist before opening a PR

- The three `vp` commands plus both scripts above pass.
- Screenshots of every changed page in light and dark at 1728×1117 and at a
  narrow width, inspected.
- Tests assert through roles and visible text, not class names.
- No new dependencies, no inline colors, no opacity on text, no second hue,
  no `history.pushState` in components.
