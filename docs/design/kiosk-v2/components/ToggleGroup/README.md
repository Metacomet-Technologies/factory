shadcn ToggleGroup on Base UI: a row of exclusive toggles. Undocumented; the kiosk uses it only inside `RangeToggle`, whose index.css overrides restyle every instance.

Source: `ui/toggle-group.tsx`. **Consumer provides:** `value` / `onValueChange` (arrays), `size`, `spacing` (base gap `spacing × 4px`; overridden to 2 px), `orientation`, `ToggleGroupItem` children with `value`.
