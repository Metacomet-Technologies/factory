# Cloud agent

## Cursor Cloud specific instructions

Boot runs `scripts/sandbox up --rows 1k --kiosk` when that synthetic stack is
stopped, then returns. `scripts/sandbox status` prints the loopback URLs.
`scripts/sandbox down` stops it. The stack stays inside Bubblewrap and does not
call production.

The environment is provisioned by `scripts/env/setup.sh --prebuild`
(`docs/environments.md`); `scripts/env/check --env cursor` proves it. Login
shells source `~/.cargo/env` and the Vite+ env, so `node` and `bun` resolve to
the kiosk's pinned versions. Inside `kiosk/`, `vp` is the project CLI. From
`kiosk/`: `OPENAPI_URL=file://$PWD/../factory-api/openapi.json vp check`,
then `vp test --run` and `VITE_API_BASE= vp build`.

`verify-kiosk` expects `/home/agent/work/factory` and
`/home/agent/.config/vite-plus/env`. Those are a symlink to this checkout and a
file that sources the Vite+ env. Playwright Chromium is in
`PLAYWRIGHT_BROWSERS_PATH` when set, otherwise `~/.cache/ms-playwright`.
