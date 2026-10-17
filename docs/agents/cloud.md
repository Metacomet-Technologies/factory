# Cloud agent

## Cursor Cloud specific instructions

Boot runs `scripts/sandbox up --rows 1k --kiosk` when that synthetic stack is
stopped, then returns. `scripts/sandbox status` prints the loopback URLs.
`scripts/sandbox down` stops it. The stack stays inside Bubblewrap and does not
call production.

Login shells prepend Node 24.21.0 and a `vp` wrapper. Inside `kiosk/`, `vp`
is the project CLI. From `kiosk/`: `OPENAPI_URL=file://$PWD/../factory-api/openapi.json vp check`,
then `vp test --run` and `VITE_API_BASE= vp build`.

`verify-kiosk` expects `/home/agent/work/factory` and
`/home/agent/.config/vite-plus/env`. Those are a symlink to this checkout and a
PATH file. Playwright browsers are in `kiosk/.browsers`.
