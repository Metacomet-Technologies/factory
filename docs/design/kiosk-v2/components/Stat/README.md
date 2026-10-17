A label above a large tabular number, with an optional suffix and note. `StatGrid` lays Stats out in equal columns.

Source: `ui/stat.tsx`, `index.css:485-533`.

**Consumer provides:** `label`, `value` (number + `format` so live changes tween over 600 ms; a string renders as-is; null → "—"), `suffix`, `note`, `size`, `tone`, `className`. `StatGrid` takes `columns` (default 2).

| `size` | below 1280 | ≥1280 | below 640 | use |
| --- | --- | --- | --- | --- |
| `lg` | 32 px | 26 px | 26 px | hero totals |
| `md` (default) | 22 px | 19 px | 22 px | card metrics |
| `sm` | 15 px | 15 px | 15 px | dense rows |

`tone`: `ok` · `warn` · `fail` · `accent` colour the value only. Weight 650, letter-spacing −0.02em (−0.03em at lg), line-height 1.15.

Format numbers with `lib/format.ts` (`count`, `usd`, `ms`, `number`, `seen`, `time`); never `toFixed` (UPS Energy does, `ups-page.tsx:134`). This rendition does not tween.
