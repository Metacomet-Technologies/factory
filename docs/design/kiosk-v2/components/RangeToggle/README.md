Segmented control for time ranges (1h / 24h / 7d …); generic over the literal union so `onChange` gets a typed value.

Source: `ui/range-toggle.tsx` over `ui/toggle-group.tsx`; styles are the `[data-slot="toggle-group"]` overrides in `index.css:653-677`.

**Consumer provides:** `value`, `options`, `onChange`, `label` (the group's accessible name). Items expose `aria-pressed`.

Track: `muted` with a `border` hairline, 2 px padding and gap, 9 px radius. Item: 12 px, 26 px tall, min 38 px wide, 7 px radius, `muted-foreground`; pressed is `card` + `foreground` + a 1 px shadow. The 9/7 px radii are literals outside the radius scale.

Ranges in use: GPU 1h·24h·7d, usage 24h·7d·30d, devices 1h·24h·7d, UPS 1h·24h·7d·30d·365d.
