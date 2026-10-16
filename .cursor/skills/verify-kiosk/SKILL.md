---
name: verify-kiosk
description: Drive the factory kiosk dashboard in a browser against its local mock API and capture proof. Use when proving kiosk UI behavior, theme, usage or GPU ranges, frontier refresh, or the live status.
---

# Verify factory kiosk

The user-facing surface is the kiosk web dashboard. The local stand-in is `vp run mock-dev`: a fixture API on `127.0.0.1:4179` and the Vite app on `127.0.0.1:4181`. This is not the tailnet factory-api on factory-gpu, and it does not read `nvidia-smi`. A pass here does not prove production telemetry, auth, or deploy.

`scripts/serve.ts` fixes both ports. A second instance cannot choose another UI port. If either port is already taken, launch refuses. Do not drive a kiosk this run did not start.

Other factory surfaces (meter, factory-api, the dispatcher CLI) are out of scope for this skill.

## Launch

From any directory, with a fresh `RUN_ID`:

```sh
export RUN_ID="$(date +%s)-$$"
export VERIFY_ROOT="/tmp/factory-kiosk-verify/$RUN_ID"
node /home/agent/work/factory/.cursor/skills/verify-kiosk/verify.mjs launch
```

`launch` sources `/home/agent/.config/vite-plus/env`, starts `vp run mock-dev` from `kiosk/` in its own process group, and returns only after both of these are true:

- the log contains `Mock API on 127.0.0.1:4179` and `http://127.0.0.1:4181/`
- `GET /v1/health` on port 4179 returns 200 and `GET /` on port 4181 returns the app shell

The mock has no database and no migrations. Fixtures in `kiosk/mock/fixtures.ts` are the seed data. Ready means the heading `factory / kiosk` can load, not merely that a socket accepts connections.

The process group id is `$VERIFY_ROOT/run/pid`. The log is `$VERIFY_ROOT/run/mock-dev.log`.

## Doctor

```sh
node /home/agent/work/factory/.cursor/skills/verify-kiosk/verify.mjs doctor
```

Doctor fails unless the recorded pid is alive, both ports are owned by that process or one of its descendants, mock `/v1/health` is HTTP 200, and the UI shell is being served. Run it before every drive.

## Drive

Use Playwright from `kiosk/node_modules` with `PLAYWRIGHT_BROWSERS_PATH=/home/agent/work/factory/kiosk/.browsers`. Open a new browser context so `localStorage` key `factory-theme` starts empty. Prefer accessible names over coordinates.

```sh
node /home/agent/work/factory/.cursor/skills/verify-kiosk/verify.mjs drive theme
```

That command is the theme journey in [features/theme.md](features/theme.md). It clicks the button named `Use dark theme` or `Use light theme`, then requires the accessible name to flip, `document.documentElement.dataset.theme` to change, and `localStorage['factory-theme']` to equal the new theme.

Other journeys are specified in `features/` and are not wrapped by the helper. Follow those files literally. Do not substitute a unit test or a direct `dataset.theme` write for a click.

## Evidence

Write proof under `$VERIFY_ROOT/evidence/<feature>/`. A theme proof is `theme/after.png` and `theme/after.aria.txt`. The text file records the button label and theme before and after the click, plus the stored preference. A screenshot alone is not proof.

Exercise the on-screen control. Capture the action's result (label, theme attribute, stored preference), not only the final pixels. Theme has no server side effect. Usage and GPU range changes must show the matching `range` query on `/v1/llm/usage` or `/v1/gpu`. Frontier refresh must show the POST to `/v1/agents/refresh` and the following status text. The mock API answers non-GET with 405, so that journey fails on this stand-in until the mock accepts the refresh POST. Do not mark it passed because the button rendered.

## Cleanup

```sh
node /home/agent/work/factory/.cursor/skills/verify-kiosk/verify.mjs cleanup
```

Cleanup sends `SIGTERM` to the recorded process group and deletes `$VERIFY_ROOT/run`. It does not kill by process name and does not delete `$VERIFY_ROOT/evidence`.

## Helpers

`verify.mjs` is the harness. Invoke it with `node` as shown above. `launch` and `cleanup` are the only commands that start or stop the app. `doctor` is read-only. `drive theme` is the one scripted journey.
