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
- **Proof.** Record the POST status, the status text after the click, and a screenshot under `$VERIFY_ROOT/evidence/frontier-refresh/`.

## Gotchas

- The mock API used by `vp run mock-dev` answers every non-GET with HTTP 405, including `POST /v1/agents/refresh`. On that stand-in the journey fails at `refresh-post`: the POST returns 405 and the status reads `Refresh didn't complete` at once, without `Refreshing…` staying up. That exercises `refresh-failure` only. Report `refresh-post` as failed. Do not treat a rendered button as a completed refresh.
- A 202 response starts a 90 second completion timer. HTTP success alone does not finish the journey.
- The button stays disabled during cooldown. Forcing the click skips the user path.
- A row whose fixture status is `not_tracked` or `unknown` shows `not tracked` or `unknown` instead of `observed … min ago`. The mock tracks all six by default.
