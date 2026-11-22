# Frontier refresh

Frontier refresh lets a user ask the dashboard to read frontier CLI quotas again. The button posts to the API, then waits for an `agents.usage` update.

## Sub-features

- `refresh-post` sends the refresh request from the Frontier CLIs card.
- `refresh-status` shows `Refreshing…` until a newer usage snapshot arrives.
- `refresh-failure` shows `Refresh didn't complete` when no snapshot arrives.

## How to get to it (user POV)

- In the Frontier CLIs card, choose the button named `Refresh usage`.

## Driving it with verify.mjs

Preconditions:

- `verify.mjs doctor` succeeds for this `VERIFY_ROOT`.
- The Frontier CLIs section shows the rows Amp, Cursor, Claude Code, ChatGPT, Kimi, and OpenCode.
- The refresh button is enabled. A `Next refresh in m:ss` countdown means the control is in cooldown: the cooldown ends 3 minutes after the newest `observed_at_ms`. The mock's newest row is always 2 minutes old, so every page load starts with about 1:01 of cooldown. Wait for the button to enable; do not force it.

- **Refresh.** Choose `Refresh usage`. The browser sends `POST /v1/agents/refresh` with an empty body. The status next to the button reads `Refreshing…`, and the button is disabled.
- **Complete.** Wait for an `agents.usage` event whose `observed_at_ms` is newer than the click. `Refreshing…` clears and all six rows stay visible.
- **Run it.** `node .cursor/skills/verify-kiosk/verify.mjs drive frontier` does every step above, including the cooldown wait.
- **Proof.** Record the POST status, the status text after the click, and a screenshot under `$VERIFY_ROOT/evidence/frontier-refresh/`.

## Gotchas

- The mock answers `POST /v1/agents/refresh` like the API: 202 with a 3 minute `next_allowed_at_ms`, then 429 until that time. It pushes a newer `agents.usage` on `/v1/stream` 1.5 s after a 202, which completes the journey. Other mock POSTs still answer 405.
- A 202 response starts a 90 second completion timer. HTTP success alone does not finish the journey; it finishes when the status reads `Updated just now`.
- The button stays disabled during cooldown. Forcing the click skips the user path.
- A row whose fixture status is `not_tracked` or `unknown` shows `not tracked` or `unknown` instead of `observed … min ago`. The mock tracks all six by default.
