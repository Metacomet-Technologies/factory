The factory kiosk is a read-mostly operations dashboard for a home compute lab. It runs on a 1728×1117 wall display and also works on laptops and phones. **v2 — "Snake River dusk"** keeps v1's calm, dense, literal discipline and sets it inside a Teton evening: frosted glass panels over a sky that fades into apricot, a jagged ridgeline along the bottom, river-teal light on the live data, and slow ambient motion. The neon is light, not decoration. It appears where data is live or an event just happened, and nowhere else.

This is the target system, decided with Devon by A/B votes in the Kiosk direction lab. The kiosk at `main@757250d` still ships v1. *Drift report* describes that code, and Linear MET-227 tracks the move to v2.

## Fixed constraints

- **One teal hue, brand and live data only.** `primary` (#00756c dawn / #3fd1c2 night) fills the brand mark and the default button. `accent-text` is the same teal as ink: links, the eyebrow, panel icons, the focus ring, chart series, the comet head and hero numbers. Teal never says anything about state.
- **Status colours are for status only.** `ok` is meadow green, `warn` is gold and `fail` is red-orange. Always pair the colour with a word. **Fail is always a solid chip with a warning icon**, so an alarm reads by shape and fill from across the room, not by hue alone.
- **Apricot is scenery.** `glow` lights the sky, the horizon and the alpenglow sweep. It is never text, never a status, and never on a control.
- **Dawn and night are equals.** Both themes come from one set of token names and get equal care. Theme follows the system, and a manual toggle sticks (`localStorage["factory-theme"]`) until it matches the system again.
- **No inline colours.** Components read tokens or the composites in `bundle.css`.
- **AA on glass, measured at the worst point.** Text is 4.5:1 against glass composited over the brightest part of the sky or ridge behind it. Glass alpha has floors (86% dawn, 68% night) so this holds. Control boundaries, focus rings and meaningful marks are 3:1.
- **Motion is ambient or meaningful, and it all stops.** Ambient layers run at 48–60 s periods and never pull the eye. Event motion fires only when data changes. Every animation stops under `prefers-reduced-motion`, and the scene then renders as a still dusk.
- **No animation libraries.** CSS keyframes and transitions, the chart's first draw and one rAF number tween.

## The scene

The page is a stage with three layers, back to front:

1. **Sky** (`Backdrop`): a vertical gradient `sky-0` → `sky-4`. It is cool blue-grey at the top and warms into apricot at the horizon. At night, `ambient="both"` adds 50 twinkling stars and two aurora ellipses in teal.
2. **Ridgeline band**: 360 px (`band-height`) along the bottom of the viewport. A far range (`ridge-far`) sits behind a jagged near range (`ridge-near` gradient) with snowfields above the snowline (`snow`, top 22%) and a 1 px teal rim light on the crest. The **alpenglow sweep** is a soft apricot band that crosses the near range every 60 s (`dur-sweep`).
3. **Glass**: the app. Panels are `card` at `glass-alpha` over the scene, with `backdrop-filter: blur(18px) saturate(170%)`, a 1 px `glass-edge`, an inner `glass-sheen`, a top-left `glass-glint` and the `shadow-glass` depth shadow.

Use `ambient`: `"both"` on the kiosk (default), `"sweep"` on laptops, `"none"` in specimens or anywhere the GPU budget is tight.

## Voice and copy

- Lowercase for system names (`factory`, `factory-gpu`, `meter-http`). Sentence case for titles ("Local LLM", "Frontier CLIs").
- Say what is true and what happens next: "Unable to load this section", "HTTP 503. Retrying on the next refresh."
- The verdict leads: "3 need attention" or "All systems nominal", then the issues, then "14 other checks OK".
- Null is an em dash (`—`), never zero. Join facts with ` · `. Units take a space ("9.1 GiB", "62 °C"). Percent on meters ("14% used").
- No emoji, no exclamation marks. The headline is "Your local compute. In focus."
- Format every number with `lib/format.ts`.

## Colour

| Role | Tokens |
| --- | --- |
| Ground | `background` page · `card` glass base · `muted` tracks and skeletons |
| Ink | `foreground` · `muted-foreground` |
| Lines | `border` decorative hairline · `border-strong` hover · `border-control` every input, select and toggle track (3.86 dawn / 4.16 night) |
| Brand | `primary`, `primary-foreground`, `accent-text`, `accent-soft` |
| Status | `ok`, `warn`, `fail`, and `on-status` for the label on a solid chip |
| Scene | `sky-0…4`, `ridge-far`, `ridge-mid`, `ridge-near`, `snow`, `glow` |
| Glass | `glass-edge`, `glass-sheen`, `glass-glint`, `glass-drop` |

Measured on glass at its worst point (dawn / night): `foreground` 15.07 / 12.96, `muted-foreground` 5.83 / 6.44, `accent-text` 5.03 / 7.61, `ok` 5.75 / 8.82, `warn` 5.87 / 10.12, `fail` 5.98 / 4.65. The chips are 12% tint with a 28% border: ok 4.86 / 6.71 and warn 4.96 / 7.48 at worst. Fail is solid at 6.64 / 6.30. Every pair passes. The Specimen shows each ratio beside its swatch.

## Type

**Geist** for UI and **Geist Mono** for numbers, 400–700. This DS loads them from Google Fonts. The kiosk self-hosts them (`@fontsource`, WOFF2, 400 and 600 preloaded) so it renders offline. Tabular figures everywhere.

- Display: `page-title` 22 / 650 / −0.02em, `verdict` 22 / 650, `panel-title` 15 / 650.
- Numbers (Geist Mono 600, −0.02em): `num-lg` 30 (hero and KPI), `num` 20, `num-sm` 15. The kiosk compacts lg and md to 26 and 19 at ≥1280.
- Text: `body` 14 / 1.45, `heading-sm` 13 / 600, `small` 12, `chip` 12 / 600 on 18, `eyebrow` 11 / 600 / 0.18em uppercase in `accent-text`, `footer` 11, `chart-axis` 10, and `brand` 17 / 700 for the wordmark.

## Spacing and density

Density is **dense** by vote. Lengths step 2, 3, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32. Panel padding is `panel-pad` 18, `panel-pad-1280` 14 on the kiosk and `panel-pad-639` 16 on phones. The grid gap is 12 on the kiosk and 16 below it. *Patterns* has the full grid.

## Shape and elevation

- Radii: `radius-sm` 6 toggle items · `radius-md` 8 controls, tiles and tooltips · `radius-lg` 12 alerts and dialogs · `radius-glass` 14 glass panels and the verdict · `radius-pill` chips and meters.
- Elevation is glass, not cards: `shadow-glass` is a sheen, an inner floor and a soft warm drop in dawn or deep black at night. Shadows are split per theme because `light-dark()` cannot hold shadows, which is the v1 defect that left panels flat.
- Alarm emphasis is a toned ring with a soft halo (`shadow-tone-warn`, `shadow-tone-fail`), plus the solid fail chip.
- Glow is reserved for three things: the brand mark (`shadow-mark`), live data (the comet head, and meter fills at night) and status dots. Nothing else glows.

## Neon and motion

| What | How | Tokens |
| --- | --- | --- |
| Panel entrance | fade, rise 10 px, scale 0.995, staggered | `dur-slow` 640, `stagger` 60 |
| Hover | border `border-strong`, 1 px lift | `dur` 320 |
| Colour changes | colour and border | `dur-fast` 160 |
| Live numbers | tween to the new value | `dur-tween` 600 |
| Comet trend | gradient trail from transparent to teal, glowing head, a ring at the last point | `dur-draw` 900 |
| Event pulse | on new data, the Live chip ripples and hero numbers (`.fk-hero`) flash teal once | `dur-event` 1200 |
| Alarm | the status dot pings | `dur-ping` 1800 |
| Alpenglow sweep | apricot band across the range | `dur-sweep` 60 s |
| Aurora and stars | night only, drift and twinkle | `dur-aurora` 48 s, `dur-twinkle` 6 s |

All use `ease-out` (`cubic-bezier(0.22, 1, 0.36, 1)`), apart from the linear sweep. Under reduced motion every one of them stops and the scene holds a still frame.

**GPU budget.** factory-console is a 2020 Intel MacBook running Chromium on Ubuntu. Backdrop blur over an animated sky is the riskiest cost in v2. Measure it on the device first (MET-227 spike): go if Chromium averages ≤ 15% CPU over 10 minutes with no jank on the sweep. If not, the fallback is a pre-blurred static sky image behind the panels, with `backdrop-filter` off and the alpha floors kept.

## States

| State | How it shows |
| --- | --- |
| Loading | `ResourceState` skeletons |
| Error | destructive Alert, plus a fail item in the Verdict |
| Empty | 13 px `muted-foreground` line |
| Stale | `muted-foreground` values, a "stale ·" prefix in `warn` |
| Live | LiveIndicator `ok`. Values tween, and the event pulse fires on change. |
| Alarm | toned glass ring, a solid fail chip with icon, a Verdict item, the pinging dot |
| All clear | the Verdict collapses to "All systems nominal · N checks OK" |

## Iconography

lucide only (24 grid, 2 px stroke, `currentColor`). The brand mark is lucide `Mountain`, 18 px in `primary-foreground` on a 32 px `primary` tile with `radius-md` and `shadow-mark`. `ArrowUpRight` means "goes somewhere", and nothing else uses it.

## Not synced

- Components are hand-written renditions of `kiosk/src/components/ui/*` on React 18, restyled to v2. Backdrop, Verdict, the comet TrendChart and `pulse()` are new here and have no kiosk source yet.
- The ridgeline is generated (seeded jag of hand-placed Teton control points), not traced from a photo.
- `bundle.css` is the v2 target, not today's kiosk. *Drift report* lists what the shipped code does instead.
