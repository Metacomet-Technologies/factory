A 0–100 fill with optional threshold markers, built on a native `<progress>`.

Source: `ui/meter-bar.tsx`. **Consumer provides:** `value`, `label`, `tone` (`accent` default · `ok` · `warn` · `fail` · `muted` for stale · `foreground`), `markers` (`{at, label}[]`).

**v2 changes:**
- **Solid fill.** The v1 gradient's light start failed 3:1.
- **Glow at night:** `0 0 10px -1px` of the tone.
- **Track:** `foreground` at 9%.
- **Markers:** `foreground` with a 1 px `background` outline. A threshold is a reference, not a status; v1's warn marker was 1.08:1 against an ok fill.
- **Width** animates over `dur-slow`.

Fix in MET-227: inside `.device-list li` (flex) the bar collapsed to zero width.
