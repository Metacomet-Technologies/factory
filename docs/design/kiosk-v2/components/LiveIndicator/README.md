The stream-status chip in the top bar; takes `useStream().status`.

Source: `ui/live-indicator.tsx`. A `StatusChip` with `role="status"`, a dot, and class `live-indicator` (11 px, 7 px inline padding below 640).

| `status` | label | tone | pulse |
| --- | --- | --- | --- |
| `live` | Live | ok | yes |
| `connecting` | Connecting | warn | no |
| `reconnecting` | Reconnecting | warn | no |

The stream reconnects on error, after 45 s of silence and on online/visibility/pageshow, with jittered backoff 1–30 s.
