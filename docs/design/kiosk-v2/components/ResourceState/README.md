The loading, error and empty states shown at the top of any Panel that renders a `Resource`.

Source: `ResourceState` in `components/sections.tsx:29-53`.

**Consumer provides:** a `Resource` (`{data, loading, error}`) and an optional `empty` sentence. Here: `state` (`loading` · `error` · `empty`), `error`, `empty`.

- **Loading:** three `Skeleton` bars (32 px at 2/3 width, 80 px full, 16 px at 1/2) in a 14 px grid.
- **Error:** destructive `Alert` with the triangle icon, "Unable to load this section", then "<error>. Retrying on the next refresh."
- **Empty:** a 13 px `muted-foreground` line ("No fleet nodes configured.").
- **Stale:** not a ResourceState. Stale readings use `muted-foreground` (MeterBar `muted`, `.agent-stale`) and a "stale ·" prefix in `warn`; never opacity.
- **Reconnecting:** the top-bar LiveIndicator turns warn; the ticker says "Stream reconnecting. Requests will appear here."; the devices aside appends "· reconnecting".

The UPS and devices pages skip ResourceState and print `<p class="loading">Loading…</p>` and `<p role="alert" class="status-fail">` instead.
