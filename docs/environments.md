# Environments

One toolchain contract for every place factory code is built or checked: orbs,
Cursor Cloud, the sandbox, CI and the two prod runners (MET-222). The contract
states requirements, not install paths. `scripts/env/setup.sh` brings an
environment up to it (MET-225); `scripts/env/check` proves whether it meets it.

```sh
scripts/env/check --env <orb|cursor|sandbox|ci|factory-gpu|factory-console>
```

Run it from the repository root. It is read-only, needs only `python3`, prints
one JSON object (`env`, `ok`, and every item with `expected`, `actual`, `ok`,
`required`) and exits 1 when a required item fails. Exempt items are reported
with `"required": false` and never fail. It never prints environment
variables; command output is cut to its first line. `--failing` prints only
the failing required items, one `name<TAB>expected<TAB>actual` line each.
Tests: `python3 -B scripts/env/test_check.py`.

The checker never installs or caches anything:

* `rustc` and `cargo` run with `RUSTUP_AUTO_INSTALL=0`, so a missing pinned
  toolchain is reported, not downloaded.
* The only JavaScript-toolchain programs it executes are
  `vp env current --json` and a real Node binary with `--version`. It never
  executes a Vite+ shim (running `node` or `bun` through one writes
  `resolve_cache.json` under the Vite+ cache and installs a missing pin) or
  `vp --version`. It runs a real Bun binary only with `--version`, which
  writes nothing (verified 2026-10-17 with Bun 1.4.2 and a fresh `HOME`).
* When `node` or `bun` on PATH links to `vp`, `vp env current --json` (in
  `kiosk/`, or the repo root for `.node-version`) names the project's pinned
  versions and binaries. A pin Vite+ has not installed fails as "not
  installed"; the checker never falls back to another Node or Bun on PATH.
  Both versions come from running the resolved binary with `--version`.
* Other installs: a `node` or `bun` that is not a Vite+ shim runs with
  `--version`; the Vite+ version comes from the nearest `package.json` named
  `vite-plus` or `vp-global` (a global Vite+ install) above the resolved
  executable.
* Verified 2026-10-17 (MET-223) in an offline Bubblewrap probe with real
  Vite+ 1.1.0, Node 24.22.0 and the then-pinned pnpm 12.11.2 and fresh `HOME`,
  `VP_HOME` and `XDG_CACHE_HOME`: no path, content or metadata changed with
  pins installed (cold and warm Vite+ state) or missing. Rechecked for Bun
  1.4.2 (MET-224) on factory-console: no file under `HOME` changed.
* Provisioning stays outside the checker, in `scripts/env/setup.sh`.

## Provisioning: `scripts/env/setup.sh`

```sh
scripts/env/setup.sh [--env <name>] [--ci] [--prebuild] [--check-only]
```

Without `--env` it uses `ci` with `--ci`, otherwise `cursor`: the full
contract, nothing exempt. That default never under-provisions; a bare
`--check-only` or `--prebuild` works anywhere. Pass `--env` to apply an
environment's exemptions and record its name in the checker JSON.

It asks the checker which required items fail for that environment and acts
only on those, so a converged host changes nothing on a rerun. It ends by
running `scripts/env/check --env <name>` and exits with its status. It holds no
version literals:

| Item | How setup installs it | Version from |
| -- | -- | -- |
| System packages | `apt-get install --no-install-recommends` (`DEBIAN_FRONTEND=noninteractive`), as root or through `sudo -n`; without either it stops and prints the administrator's command | the checker's `SYSTEM` list |
| Rust | rustup (installed from `sh.rustup.rs` if missing), then `rustup toolchain install` in the repo root | `rust-toolchain.toml` (channel and components) |
| Vite+ | the `vite.plus` installer, which verifies the npm package integrity; `VP_NODE_MANAGER=yes` | `kiosk/package.json` `catalog.vite-plus` |
| Node, Bun | `vp env install` in `kiosk/` and the repo root | `devEngines`, `.node-version` |
| Playwright | `vp exec playwright install chromium` in `kiosk/`, into `PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright` | the kiosk's locked `@playwright/test` |
| Layout | writes `/home/agent/.config/vite-plus/env` (sourcing the real Vite+ env) when missing. The checkout symlink stays with the environment | — |

Without `--ci` it also makes the login shell file bash reads
(`~/.bash_profile`, `~/.bash_login` or `~/.profile`, the first that exists,
else `~/.profile`) source `~/.cargo/env` and the Vite+ env, and installs the kiosk's locked
dependencies when `kiosk/node_modules` is missing (Playwright needs them).

* `--ci`: the environment defaults to `ci`. Skips Playwright, the layout,
  profile edits and the kiosk dependencies; writes the new PATH entries to
  `GITHUB_PATH`.
* `--prebuild`: adds the release `cargo build` of the sandbox binaries and the
  kiosk build (the same as `scripts/sandbox up --kiosk`), for snapshots.
* `--check-only`: prints each change it would make (`would …`), including the
  login-file lines for env files an install would create, and changes
  nothing. Exits 1 only when an item cannot be installed (`os`,
  `layout:checkout`).

Exempt items are never installed. Tests:
`python3 -B scripts/env/test_setup.py` (fake checker, stubbed installers).

`scripts/sandbox up` runs `scripts/env/check --env sandbox --failing` first and
refuses to start, naming each failing item, until the host meets the contract.

## Contract

| Item | Requirement | Pin lives in |
| -- | -- | -- |
| OS | Ubuntu (Debian family) LTS, x86_64 | — |
| Rust | 1.99.0 with `rustfmt` and `clippy`, as `rustc` resolves inside the repo | `rust-toolchain.toml` |
| Node | 24.22.0, as `node` resolves in `kiosk/` and the repo root | `kiosk/package.json` `devEngines.runtime`, `.node-version` |
| Package manager | Bun 1.4.2 in `kiosk/` (package manager only; Node stays the runtime) | `kiosk/package.json` `devEngines.packageManager` |
| Vite+ | `vp` v1.1.0 on PATH in `kiosk/` | `kiosk/package.json` `catalog.vite-plus` |
| Playwright | an installed Chromium executable (`chromium-*/chrome-linux*/chrome` with `INSTALLATION_COMPLETE`) in Playwright's effective location: `PLAYWRIGHT_BROWSERS_PATH` when set (no fallback), otherwise `~/.cache/ms-playwright`; required where kiosk UI checks run | — |
| System packages | build-essential (`cc`, `make`), pkg-config, ca-certificates, curl, python3, util-linux (`flock`), bubblewrap (`bwrap`), shellcheck, sqlite3, zstd, rsync, xz-utils (`xz`) | `SYSTEM` in `scripts/env/check` |

System packages are checked by the command each provides, not by package
manager records. `scripts/dispatch` and `scripts/usage` keep their own
`.node-version` (24.21.0) for the dispatcher and usage collector services.

## Layout

Where kiosk UI checks run (the `verify-kiosk` skill):

* `/home/agent/work/factory` is the factory checkout. In cloud VMs it is a
  symlink to the workspace checkout.
* `/home/agent/.config/vite-plus/env` is the Vite+ env file that `verify-kiosk`
  sources to put `vp`, `node` and `bun` on PATH.

## Environments

| Environment | Provisioned by | Exempt from |
| -- | -- | -- |
| `orb` (Amp) | `.agents/setup` on orb creation: `scripts/env/setup.sh --env orb` | Playwright, layout |
| `cursor` (Cursor Cloud) | Team environment in the Cursor dashboard (`metacomet-technologies/factory`, id `d36f659b…`): its install script runs `scripts/env/setup.sh --prebuild` (default `cursor`) after the checkout symlink (below). No repo `.cursor/environment.json`, which would override it | nothing |
| `sandbox` (`scripts/sandbox` host) | `scripts/env/setup.sh --env sandbox` on the host it runs on; CI's `sandbox` job runs it with `--ci` | Playwright, layout |
| `ci` (GitHub Actions `kiosk` job, ubuntu-24.04) | `scripts/env/setup.sh --ci` in `.github/workflows/ci.yml` | Playwright, layout, bubblewrap (the `sandbox` job installs it) |
| `factory-gpu` | `scripts/env/setup.sh --env factory-gpu`, run as `agent` by an administrator (below) | nothing |
| `factory-console` | `scripts/env/setup.sh --env factory-console`, run as `agent` by an administrator (below) | nothing |

Exemptions live in `EXEMPT` in `scripts/env/check`.

## Checking the runners

Read-only, from an administrator Mac. The checker runs as `agent` in a login
shell, from the `/home/agent/work/factory` checkout:

```sh
for node in gpu console; do
  echo "== factory-$node"
  "$node-ssh" "sudo -iu agent bash -lc 'cd /home/agent/work/factory && scripts/env/check --env factory-$node'"
done
```

Record both JSON results on MET-222.

## Converging the runners

The runners are production. An administrator runs this from a Mac; setup runs
as `agent` and never restarts or touches a service. Each node's
`/home/agent/work/factory` must be at a main commit that has
`scripts/env/setup.sh`. Step 1 changes nothing; step 2 runs only after you
answer `y` to the plan; step 3 prints the JSON to record on MET-222; the
running service list is compared before and after.

```sh
for node in gpu console; do
  as_agent() { "$node-ssh" "sudo -iu agent bash -lc 'cd /home/agent/work/factory && $1'"; }
  services() { "$node-ssh" "systemctl list-units --type=service --state=running --no-legend --plain" | awk '{print $1}' | sort; }
  services > "/tmp/factory-$node.services.before"
  echo "== factory-$node 1/3: plan (changes nothing)"
  as_agent "scripts/env/setup.sh --env factory-$node --check-only" || { echo "!! factory-$node: unmet item above"; continue; }
  printf 'Apply this plan on factory-%s? [y/N] ' "$node"; read -r answer
  [ "$answer" = y ] || continue
  echo "== factory-$node 2/3: converge as agent"
  as_agent "scripts/env/setup.sh --env factory-$node >/dev/null" || echo "!! factory-$node: setup failed; see above"
  echo "== factory-$node 3/3: check (record on MET-222)"
  as_agent "scripts/env/check --env factory-$node"
  services | diff "/tmp/factory-$node.services.before" - && echo "== factory-$node: same services running"
done
```

`agent` has no sudo. If the plan needs system packages, setup stops and prints
`sudo apt-get install --no-install-recommends -y …`; run that line as yourself
(`"$node-ssh" "sudo apt-get install …"`), then rerun the loop. Expected from the
baseline below: Playwright Chromium for `agent` on factory-console, nothing on
factory-gpu.

### Rolling back

Setup only adds; its plan lists each addition. To return a runner to the
baseline below, as `agent`:

* Playwright on factory-console (baseline: none):
  `rm -rf /home/agent/.cache/ms-playwright`.
* A `. "…"` line setup appended to the login file: delete that line.
* Rust, Vite+, Node and Bun already matched the pins at the baseline, so setup
  should not change them. If a plan ever installs another version, remove it
  with `rustup toolchain uninstall <version>` or `vp env uninstall <version>` (Node) or `vp env uninstall bun@<version>`.

The repository side (this script, the orb wrapper, CI, the sandbox preflight)
rolls back by reverting its merge commit.

## Cursor Cloud install script

Paste into the team environment's install script in the Cursor dashboard (UI
only, never the API), replacing the old script. Save a copy of the old script
first; it is the rollback.

```bash
set -euo pipefail
# Layout: the checkout at /home/agent/work/factory, owned by this user.
sudo install -d -o "$(id -un)" -g "$(id -gn)" /home/agent /home/agent/work /home/agent/.config
ln -sfn "$PWD" /home/agent/work/factory
bash scripts/env/setup.sh --prebuild
```

The start script stays as it is. Then rebuild the snapshot from the
environment's page, start a fresh agent whose first command is
`scripts/env/check --env cursor`, and record its JSON on MET-222. To roll back,
paste the saved script and rebuild, or select the previous snapshot.

## Prod baseline (MET-222, 2026-10-17)

Recorded evidence before convergence. Both nodes identical unless noted.

| Item | Value |
| -- | -- |
| OS | Ubuntu 26.04.1 LTS, x86_64; kernel 7.0.0-38-generic (gpu), 7.2.9-2-t2-resolute (console) |
| Rust | 1.99.0 (b940084d7 2026-09-28), clippy 0.1.99. Was `stable`; pinned by hand with `rustup default 1.99.0` on 2026-10-17 |
| Node | 24.22.0 (Vite+ global default). Repo pinned 24.21.0 at the time |
| pnpm | 12.14.0 global; repo pins 12.11.2 |
| Vite+ | vp v1.1.0 at `~/.local/share/vite-plus` (orbs use `~/.vite-plus`, Cursor `/usr/local/lib/...`) |
| shellcheck | Was missing; 0.11.0 installed by hand on 2026-10-17 |
| Playwright | gpu: `chromium-1248`, `chromium_headless_shell-1248`, `ffmpeg-1013`; console: none |
| Other | gh 2.102.0, git 2.53.0, Python 3.14.4, sqlite3 3.46.1, bubblewrap 0.11.1; build-essential, pkg-config, zstd, rsync, xz-utils and util-linux present |

Drift then: Rust `stable` in CI and Cursor, Node 24.21.0 pinned vs 24.22.0 on
prod, a different Vite+ location per environment, no Playwright on console,
and (until fixed by hand) no shellcheck on prod.

## Adding an environment

Claude Code and Codex cloud are next. Each needs one setup line and the check.

1. Add its name to `EXEMPT` in `scripts/env/check`, with only the exemptions it
   truly needs, and a row to the table above.
2. In the vendor's setup or install script (kept where the vendor versions it;
   say where in the table), from the repository root:

   ```sh
   bash scripts/env/setup.sh --env <name>
   ```

   Add `--prebuild` when the vendor snapshots the result. If it runs kiosk UI
   checks, first symlink the checkout to `/home/agent/work/factory` as in the
   Cursor script above; setup installs Playwright Chromium and the Vite+ env
   file unless the environment is exempt.
3. Make `scripts/env/check --env <name>` a fresh agent's first command there
   and record the JSON on the issue.
