shadcn Alert: an icon, a title and a description in a bordered block.

Source: `ui/alert.tsx` plus overrides `index.css:685-701`.

**Consumer provides:** `variant` (`default` · `destructive`), an optional leading icon (16 px), `AlertTitle`, `AlertDescription`, `AlertAction`.

Ground is the tile mix (`muted` 55% into `card`), border `border`; radius `radius-lg`; 8 × 10 padding; 14 px (12 px in the overview Local LLM panel at ≥1280). `destructive` sets `fail` text and a 40% fail border; the description drops to 90% fail. Add class `pending` for the warn variant the pricing notice uses (warn icon, 40% warn border).

The UPS page hand-rolls `.ups-pending` / `.ups-control-result` instead of this.
