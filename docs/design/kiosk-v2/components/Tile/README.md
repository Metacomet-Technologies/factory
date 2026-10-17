A bordered sub-surface inside a Panel: a fleet node, spend card, model card or energy period.

Source: `ui/panel.tsx` (`Tile`). v2 ground: `foreground` at 3% over the glass, a `border` hairline, radius `radius-md`. `tone` `warn`/`fail` mixes 45% of the status colour into the border. Padding 14, or 10 × 12 at ≥1280.

A tile that opens a page is wrapped in `<a class="tile-link">` and gets an `ArrowUpRight` hint in `accent-text` after its heading. Hover turns the border `accent-text` and lifts it 1 px.
