The fixed app header owned by `App.tsx`: brand mark and `factory` home link, breadcrumbs, then LiveIndicator, UPS badge, API-health info and the theme toggle.

Source: `App.tsx:118-180`.
- **Background:** `background` at 60% over the sky, with a `border` hairline. No blur, since the sky behind it is static.
- **Padding:** 12 × 28 (8 block at ≥1280; 10 × 14 below 640, where the brand mark hides).
- **v2 brand mark:** a 32 px `primary` tile, radius `radius-md`, with a lucide `Mountain` in `primary-foreground` and the `shadow-mark` glow. This replaces v1's two-hue gradient.
- **Crumb separators** are solid `muted-foreground` with no opacity.
- **Live chip:** on each stream event it ripples (`dur-event`).
- **UPS badge:** a plain `<a href="/ups">` styled as a ghost icon button. MET-227 replaces the current `location.assign`.
