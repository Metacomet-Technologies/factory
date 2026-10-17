A pill for state words (Online, Failing, Stale, 2 / 3 online); `StatusText` is the same colour inline, with no pill.

Source: `ui/status-chip.tsx`. **Consumer provides:** children (the state word; never colour alone), `tone`, `dot`, `pulse`, `icon` (`false` suppresses the fail icon), `className`.

| `tone` | look | meaning |
| --- | --- | --- |
| `ok` | meadow-green tint 12%, border 28% | healthy, online, passing |
| `warn` | gold tint | degraded, stale, pending, reconnecting |
| `fail` | **solid** `fail` fill, `on-status` label, alert icon | offline, failing, on battery, critical |
| `neutral` (default) | `muted-foreground` tint | no data, informational |
| `accent` | `accent-text` tint | links-as-chips only ("Details ↗"). Never a state. |

**Rules:**
- **The brand never fills.** Teal appears as lines and glow, so a solid chip always means failure.
- **Dots glow** (`0 0 8px currentColor`). `pulse` rings the dot every `dur-ping` (1.8 s), for active alarms and the Live indicator only.

**Contrast:** worst ground, 12% tint: dawn ok 4.86, warn 4.96; night ok 6.71, warn 7.48. Solid fail is 6.64 dawn and 6.3 night.
