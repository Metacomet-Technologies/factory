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
- The Frontier CLIs section shows Amp, Claude Code, and ChatGPT.
- The refresh button is enabled. A countdown means the control is in cooldown and this journey cannot start.

- **Refresh.** Choose `Refresh usage`. The browser sends `POST /v1/agents/refresh` with an empty body. The status next to the button reads `Refreshing…`, and the button is disabled.
- **Complete.** Wait for an `agents.usage` event whose `observed_at_ms` is newer than the click. `Refreshing…` clears and the Amp, Claude Code, and ChatGPT rows stay visible.
- **Proof.** Record the POST status, the status text after the click, and a screenshot under `$VERIFY_ROOT/evidence/frontier-refresh/`.

## Gotchas

- The mock API used by `vp run mock-dev` answers every non-GET with HTTP 405, including `POST /v1/agents/refresh`. On that stand-in the journey fails at `refresh-post`. Report that failure. Do not treat a rendered button as a completed refresh.
- A 202 response starts a 90 second completion timer. HTTP success alone does not finish the journey.
- The button stays disabled during cooldown. Forcing the click skips the user path.
- Cursor and Kimi are a not-tracked line. They are not the three quota rows this journey checks.
