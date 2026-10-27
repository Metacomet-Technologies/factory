# Factory orbs

## Scope and compatibility

Orbs support Rust workspace checks, kiosk checks/builds, offline script tests,
and an on-demand mock kiosk preview. `.agents/setup` runs
`scripts/env/setup.sh --env orb`, which converges the orb to the toolchain
contract in `docs/environments.md` and ends with `scripts/env/check --env orb`.
It installs the toolchain and the kiosk's locked dependencies, but does not
compile, test, start services, download Playwright browsers, or log in. No
resume hook is needed.

Every version comes from the repo: Rust from `rust-toolchain.toml` (1.99.0 with
rustfmt/clippy, matching the factory runners), Vite+ from the kiosk catalog,
Node and Bun from the kiosk's `devEngines` and `.node-version`. The scripts keep
their own `.node-version`. System packages provide the C compiler, Python 3,
flock, Bubblewrap, shellcheck, SQLite CLI, zstd, rsync, xz and the lld
release linker (`ld.lld`). SQLite used by Rust is bundled; it does not depend
on the host SQLite CLI version. Rust crates are fetched by the first build, not
by setup.

Orb setup also installs missing coding-agent tools: rg, fd, jq, yq, ast-grep,
gh, shellcheck, uv/uvx, just, watchexec, entr, hyperfine, scc and direnv. Debian
packages supply rg, fd (`fdfind`, with an `fd` symlink), jq, gh, shellcheck,
entr, hyperfine and direnv. The others use pinned Linux x86_64 upstream
release binaries with SHA-256 verification in `scripts/env/setup.sh`; yq is
Mike Farah's YAML/JSON/XML processor, not Debian's Python jq wrapper. Updating
a release requires updating its asset and checksum together. Existing commands
on PATH are kept, and user-local binaries go in `~/.local/bin`, appended to
login-shell PATH. Only `ast-grep` is installed, not its `sg` companion (a
standard Unix command). No standard commands are aliased or replaced, no
direnv hook or automatic `.envrc` approval is added, and bat/eza/fzf/delta/
zoxide/difftastic are not installed. These conveniences are orb-only; they do
not extend the shared build contract or provision CI, Cursor or production.
`--check-only` includes them in its read-only plan. System-package installs
use the shared installer's root requirement; without privileges it prints the
administrator command and stops rather than silently skipping tools.

Linux x86_64 and these development tools provide practical parity with the
Ubuntu factory runners. Their kernels, GPU, real Ollama, Tailscale, systemd
deployment units, UPS, physical kiosk, backups, dispatcher, account collectors,
production databases, and credentials are intentionally excluded. Python 3.10+
is sufficient; exact runner Python/GCC versions are not required.

No additional secrets or live integrations are required. Tailnet connectivity
and production checks require separately approved scope. Do not run production
collectors, dispatcher commands, deployment scripts, or live verification scripts.

## Checks

Use a non-interactive login shell (`bash -lc 'command'`) for tool calls that do
not load profiles. This selects the pinned Rust/Vite+ environment rather than
the orb's base Node runtime. Amp supervised services already use login shells.

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
this setup's scope: `scripts/sandbox` additionally needs an orb-supervised
lifecycle. It must never fall back to production services.

The usage test checks atomic replacement through an open reader, not inode
uniqueness: filesystems may reuse freed inode numbers. Reboot checks run offline;
their Bubblewrap installer fixtures preserve permissions and use relative source
paths for portable GNU cp behavior. Require the installer PASS group when
verifying orb parity; a namespace-related SKIP is not full verification. Never
relax host security policy to make namespaces work.

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

The approved project default is `a1.large` (8 CPUs, 16 GB), with project-scoped
`CARGO_BUILD_JOBS=8`. Standard pricing is $0.66/hour. Small (2 CPUs, 4 GB,
$0.17/hour) passed builds/tests but repeatedly failed Vite+ linting: oxc's
approximately 4 GiB aligned virtual allocation returned ENOMEM before analysis.
Medium (4 CPUs, 8 GB, $0.33/hour) passed that check, and a full run peaked at
6 GiB. Large is the default so eight compile jobs fit. Fetch/install caches are
reused, and builds/tests remain on demand. Routine setup edits suit low agent
mode; troubleshooting may need medium. No premium features are needed.

Clean medium measurement at the initial setup merge: cold setup 26.16 seconds,
warm setup 0.59 seconds, clippy 37.53 seconds, Rust tests 117.88 seconds, kiosk
check 3.47 seconds, tests 3.38 seconds, and build 1.15 seconds. Rust reported
70 passing tests and one explicitly ignored test; kiosk reported 30 passing tests.
The workload cgroup had a 6 GiB limit and reached that historical peak, with no
OOM kills. This measures one run, not guaranteed spare capacity or build time.

Follow-up validation of the Bubblewrap dependency and both portability fixes
reused that medium orb: setup reruns took 0.64/0.70 seconds, Node offline tests
passed 82/82, all nine reboot groups passed without skips, and kiosk check passed
in 3.62 seconds. User and network namespace probes passed; OOM counters stayed
zero. These warm runs do not measure a new cold installation.

Verify setup twice and check tools from a new non-interactive login shell. Ask
before larger sizes, extra workers, paid services, or fresh verification orbs.
Local setup files become active for future orbs only after they reach the
project's base branch; changing the project size alone does not publish setup.
