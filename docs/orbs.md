# Factory orbs

## Scope and compatibility

Orbs support Rust workspace checks, kiosk checks/builds, offline script tests,
and an on-demand mock kiosk preview. `.agents/setup` installs dependencies but
does not compile, test, start services, download Playwright browsers, or log in.
No resume hook is needed.

The setup uses Rust 1.99.0 with rustfmt/clippy, matching the observed factory
runners, and Vite+ 1.1.0. Vite+ selects Node/pnpm from the kiosk's `devEngines`
and the scripts' `.node-version` files. System packages provide the C compiler,
Python 3, flock, shellcheck, SQLite CLI, zstd, and rsync. SQLite used by Rust is
bundled; it does not depend on the host SQLite CLI version.

Linux x86_64 and these development tools provide practical parity with the
Ubuntu factory runners. Their kernels, GPU, real Ollama, Tailscale, systemd
deployment units, UPS, physical kiosk, backups, dispatcher, account collectors,
production databases, and credentials are intentionally excluded. Python 3.10+
is sufficient; exact runner Python/GCC versions are not required.

No additional secrets or live integrations are required. Tailnet connectivity
and production checks require separately approved scope. Do not run production
collectors, dispatcher commands, deployment scripts, or live verification scripts.

## Checks

From the repository root:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace --locked
node --test scripts/dispatch scripts/usage
python3 -B deploy/test_set_ollama_host.py
python3 -B deploy/backup/test-backup.py
python3 -B deploy/reboot/test-reboot.py
```

From `kiosk/`, check against the committed OpenAPI schema, not production:

```sh
OPENAPI_URL="file://$(realpath ../factory-api/openapi.json)" vp check
vp test --run
vp build
```

Shell checks and installer tests remain available through the commands in
`.github/workflows/ci.yml`. Running the isolated real meter/API stack is outside
this setup's scope: `scripts/sandbox` additionally needs Bubblewrap namespaces
and an orb-supervised lifecycle. It must never fall back to production services.

The current usage test's final inode inequality can fail on the orb's `/tmp`
filesystem: it reuses freed inodes over ten atomic replacements. Each adjacent
replacement changes inode, but the first and final inode can match. Do not hide
this failure or change the test as part of environment setup. Reboot decision
checks run offline; their optional Bubblewrap installer checks are skipped when
namespaces are unavailable.

## Mock preview

Start from the repository root only when needed:

```sh
amp orb services ensure
amp orb service status kiosk
amp orb service stop kiosk
```

The supervised service runs the existing `vp run mock-dev` task: mock API on
loopback port 4179 and Vite on loopback port 4181. Readiness checks the proxied
`/v1/health` fixture. Use the exact authenticated portal URL printed by Amp;
do not expose the mock API separately or change firewall/Tailscale settings.
Setup never calls `ensure`; opening the declared portal can start the service.
The service survives Amp updates and orb wake-ups after it has been started.

The orb's preinstalled `agent-browser`/Chromium can inspect the preview without
another browser download. Repository Playwright screenshot scripts may require
their matching browser installation; that download is not part of setup.

## Cost and verification limits

The approved project default is `a1.small` (2 CPUs, 4 GB), with project-scoped
`CARGO_BUILD_JOBS=2`. Standard pricing is $0.17/hour versus $0.33/hour for medium
(4 CPUs, 8 GB); slower builds can offset the lower hourly rate. Fetch/install
caches are reused, and builds/tests remain on demand. Routine setup edits suit
low agent mode; troubleshooting may need medium. No premium features are needed.

Verify setup twice and check tools from a new non-interactive login shell.
Verification in an existing medium orb does not prove clean installation or
small-orb memory capacity. Ask before larger sizes, extra workers, paid services,
or fresh verification orbs. Local setup files become active for future orbs only
after they reach the project's base branch; changing the project size alone
does not publish the setup.
