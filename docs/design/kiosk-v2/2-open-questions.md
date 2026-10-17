# Open questions

v2 closes most of the questions the v1 extraction raised. This page lists what was decided and why, then what still needs Devon. Numbers refer to the v1 extraction at `757250d`, and every ratio is re-measured on v2 glass.

## Decided in v2

| # | Question | Decision | Basis |
| --- | --- | --- | --- |
| 1 | Elevation: fix the shadows or drop them? | **Glass elevation.** `shadow-glass`, `shadow-tone-*` and `shadow-mark` are split per theme, because `light-dark()` cannot hold shadows. | Vote: frosted liquid glass |
| 2 | Theme: system or sticky override? | **Follows the system, and a manual choice sticks until it matches again.** Dawn and night are equals. | Code behaviour plus the vote |
| 3 | Unknown host health in the brand colour | **`neutral`.** The brand hue never carries state. | Constraint |
| 5 | Light warn fails AA as chip text | **New gold `warn`** (#7a5800 dawn / #ffd447 night): chip 4.96 / 7.48 at the worst glass point. | Measured |
| 6 | Chip tint 12% or 14%? | **12% tint, 28% border.** Fail is solid. | Measured |
| 7 | Control borders below 3:1 | **`border-control`** (#718389 / #6a808c): 3.86 / 4.16 on glass. | WCAG 1.4.11 |
| 8 | Meter markers hue-only | **Markers in `foreground` with a `background` outline.** | Constraint |
| 9 | Overview row gaps | **New grid**: the sidebar owns column 3 and the rows hug their content. No gaps, and the ridgeline shows below. | *Patterns* |
| 11 | Brand mark gradient | **A solid `primary` tile with lucide `Mountain` and `shadow-mark`.** | Vote: Teton theme |
| 16 | Hover language | **`accent-text` for both panel-link and tile-link**, plus the 1 px lift. Applied in `bundle.css`. | Recommendation |
| 17 | Motion literals | **Tokens:** `dur-tween` 600, `stagger` 60, `dur-draw` 900, `dur-event`, `dur-ping`, `dur-sweep`, `dur-aurora`, `dur-twinkle`. | Ambient + event pulse vote |
| 20 | Stale screenshots | **Regenerate in MET-227** and assert no-scroll plus the v2 contrast pairs in `scripts/screenshots.ts`. | Guide |
| — | Palette | **Snake River dusk**: teal brand, apricot sky, river-blue ground. | Vote: river |
| — | Teal brand vs a teal "ok" | **Meadow-green `ok`** (#286d1a / #7ee081), 52° of hue away from the teal. | Devon |
| — | Ridgeline | **The full jagged Teton band**, 360 px, with snow and a teal rim light. | Vote: range |
| — | Ambient | **Both**: the alpenglow sweep, plus stars and aurora at night. | Vote: both |
| — | Status and alarm | **The Verdict strip leads. Fail is a solid chip with an icon.** | Vote |
| — | Type | **Geist + Geist Mono**, dense density. | Vote |
| — | GPU budget on factory-console | **Spike first** behind `?ambient=both\|sweep\|none\|static`. Go if Chromium averages ≤ 15% CPU over 10 minutes with no jank on the sweep. Otherwise ship `static`: a pre-blurred sky, `backdrop-filter` off, motion only in the band. | Devon · MET-227 |
| — | Font hosting | **Self-host** with `@fontsource/geist` and `@fontsource/geist-mono` (400–700, latin WOFF2, `font-display: swap`, 400 and 600 preloaded). No runtime CDN. | Devon · MET-227 |
| — | Disabled state | **Tokens, not opacity:** a `muted` fill, a `muted-foreground` label and a `border-control` outline, with the reason text beside the control. | MET-227 audit list |
| — | No-scroll in error and reconnecting | **Measured in MET-227** by the screenshot script, in every state. | MET-227 acceptance |

## Deferred to MET-228 (after MET-227 merges)

1. **Radius scale.** Delete the unused `radius-xl` and `radius-4xl`. Map shadcn `rounded-lg` to `radius-md` for controls. Replace the toggle-group literals.
2. **Unused primitives.** Delete Badge, Card and Tabs, and adopt Separator in place of `.divider`.
3. **Form and dialog primitives.** `ui/input`, `ui/select` and `ui/dialog` on Base UI, as glass with `border-control`. Move UPS Controls onto them.
4. **ResourceState on details pages.** Make it the only loading and error UI, with an overload for non-Resource props.
5. **Spend-card decoration.** Remove the accent bar and the non-link `ArrowUpRight` (`llm-page.tsx:98`, `index.css:784`).
6. **UPS badge navigation.** Use `<a href="/ups">` instead of `window.location.assign`.

## Still open

1. **Ridgeline source.** The ridgeline is generated from hand-placed control points. **Recommend keeping it generated for now.** A trace of a real panorama (Snake River Overlook) would be more faithful, but it needs a licensed or own photo.
