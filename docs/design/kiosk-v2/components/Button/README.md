shadcn (base-nova) Button on Base UI; use it for anything clickable that is not a link.

Source: `ui/button.tsx` (cva). Resolved here to plain CSS.

**Consumer provides:** `variant`, `size`, children (icon 16 px), `disabled`, button props.

| `variant` | look | used |
| --- | --- | --- |
| `default` | `primary` fill, white label, 80% on hover | Save settings, Confirm |
| `outline` | `border` + `background` (dark: border 30%) | Older/Newer events, Review, Cancel |
| `ghost` | transparent, `muted` on hover | top-bar icons, Refresh usage |
| `destructive` | `fail` 10% (dark 20%) with `fail` text | Power tier actions |
| `secondary` | `muted` fill | unused |
| `link` | `primary` text | unused; `primary` as text is 2.71:1 on dark |

| `size` | height | notes |
| --- | --- | --- |
| `xs` / `sm` / `default` / `lg` | 24 / 28 / 32 / 36 | radius 8 / 8 / 12 / 12 |
| `icon-xs` / `icon-sm` / `icon` / `icon-lg` | 24 / 28 / 32 / 36 square | |

States: hover, focus (border `accent-text` + 3 px ring at 50%, plus the global 2 px outline), active (1 px down), disabled (50% opacity: light primary label 1.56:1). UPS controls set `min-height: 44px` and wrap.
