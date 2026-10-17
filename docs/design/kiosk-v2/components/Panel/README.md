The one card template for every dashboard section: a header (icon, title, subtitle, action) above a body, drawn as frosted liquid glass.

Source: `kiosk/src/components/ui/panel.tsx`. v2 changes the skin only; props and markup are unchanged.

**Consumer provides:** `title` (also the region's accessible name), optional `subtitle`, `icon` (lucide, in an `accent-soft` tile), `action` (one right-aligned control or chip), `tone`, `index`, `className`, `bodyClassName`, children.

**Glass:**
- **Ground:** `card` at `glass-alpha`: 86% dawn and 68% night, the floor that keeps every text token at AA over the darkest backdrop.
- **Blur:** `glass-blur` 18 px and `glass-saturate` 170%.
- **Rim and shadow:** a 1 px `glass-edge` rim, the `shadow-glass` inner sheen and depth shadow, and a `glass-glint` specular highlight top-left.
- **Shape:** radius `radius-glass` (14).

| Prop | Values | Effect |
| --- | --- | --- |
| `tone` | `warn` · `fail` · none | Adds `shadow-tone-warn` / `shadow-tone-fail`: a 1 px status ring and a soft neon halo. |
| `index` | number | Entrance `panel-in` waits `index × stagger` (60 ms). |

**States:** loading, error and empty go through `ResourceState`. A panel with a details page is wrapped in `<a class="panel-link">`. On hover the border goes `border-strong` and lifts 1 px; on focus it gets a 2 px `accent-text` outline.

**Density:** padding `panel-pad` 18 / `panel-pad-1280` 14 / `panel-pad-639` 16; gap 12 (10 at ≥1280).
