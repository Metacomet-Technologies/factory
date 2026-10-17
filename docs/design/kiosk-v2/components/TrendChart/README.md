One live series over time. v2 draws it as a **comet**: the stroke fades in from transparent on the left to full `accent-text` at "now", ending in a lit head with a halo and a ping ring.

Source: `charts/trend-chart.tsx` (Recharts 3.8, lazily loaded). **This preview is a static SVG rendition.**

**Consumer provides:** `data`, `label`, `ariaLabel`, `domain` (0–100), `className` (`trend-chart`: 92 px on the v2 overview, 88 px otherwise; `trend-chart-tall` 220 px), `caption`, `variant` (`comet` default · `area` for v1-style multi-hour views).

- **Stroke:** 2.5 px with a gradient: 0% opacity at the start, 35% at 55%, 100% at the end.
- **Grid:** `border`, dashed 3 5.
- **Head:** a 10 px `accent-text` dot with a `0 0 12px 3px` glow, plus a ring pinging on `dur-ping`.
- **Draw:** the first draw takes `dur-draw` (900 ms) unless motion is reduced.
- **Event:** a new sample moves the head and fires the event pulse.
