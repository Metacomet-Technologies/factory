# Kiosk verification map

This directory is the maintained source for verifying the user-facing behavior of the factory kiosk. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `verify.mjs launch` so the mock API is on `http://127.0.0.1:4179` and the dashboard is on `http://127.0.0.1:4181`.
- Set `VERIFY_ROOT=/tmp/factory-kiosk-verify/$RUN_ID` so the run log and evidence stay out of the repo.
- The mock fixtures are the seed. There is no login.
- Run `verify.mjs doctor` and require the recorded pid, both ports, and mock health.
- Never drive an instance that was not started by this verification run. The UI port cannot be changed.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or DOM position.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run the theme journey through `verify.mjs drive theme`.
- Run the other journeys with Playwright from `kiosk/node_modules` and `PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers` inside `kiosk/`, using a fresh context.
- Leave `$VERIFY_ROOT/evidence` in place during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot text file and a screenshot that shows the kiosk heading.
- Range changes also record the request URL the browser sent.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify.mjs` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Theme](./theme.md) covers the header control that switches light and dark and stores the preference.
- [Usage range](./usage-range.md) covers the Local LLM 24h, 7d, and 30d control.
- [GPU range](./gpu-range.md) covers the GPU 1h, 24h, and 7d history control.
- [Frontier refresh](./frontier-refresh.md) covers the Frontier CLIs refresh button and its mock limitation.
