The sky and Teton ridgeline behind every page: a five-stop dusk gradient, the full Teton range as a jagged band along the bottom, snow above the snowline, a rim light in the brand teal, and the ambient layer.

New in v2. Mount it once as the first child of the app frame (`position: absolute; inset: 0`); glass panels sit above it.

**Consumer provides:** `ambient`: `both` (default; Devon's pick), `sweep`, `stars` or `none`.

- **Sky:** `sky-0` → `sky-4` at 0 / 40 / 66 / 84 / 100%; the apricot `sky-4` sits behind the ridge.
- **Ridge:** `ridge-far` at 75%, then the near range filled `ridge-mid` → `ridge-near`. The band is `band-height` (360 px) tall. The Grand Teton peaks at x ≈ 910 of 1728, behind the gap between Local LLM and the sidebar.
- **Snow:** a `snow` gradient clipped to the near range, fading out by 22% of the band height.
- **Ambient:** the alpenglow sweep (`glow` → `accent-text` → `glow`, 760 px wide, `dur-sweep` 60 s linear, clipped to the range); a two-ellipse aurora in `ok` at 32% (`dur-aurora` 48 s, alternate); and 50 stars twinkling on `dur-twinkle`. Stars are hidden in dawn.

**Performance.** Everything that moves is transform or opacity. Glass panels blur whatever sits behind them, so measure on factory-console first (MET-227). Fallback: render the sky and ridge once to a static, pre-blurred image behind the panels, and keep motion in the band only.

Reduced motion: no sweep, no aurora drift, no twinkle; the static scene stays.
