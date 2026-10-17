# Environments

One toolchain contract for every place factory code is built or checked: orbs,
Cursor Cloud, the sandbox, CI and the two prod runners (MET-222). The contract
states requirements, not install paths. `scripts/env/check` proves whether an
environment meets it.

```sh
scripts/env/check --env <orb|cursor|sandbox|ci|factory-gpu|factory-console>
```

Run it from the repository root. It is read-only, needs only `python3`, prints
one JSON object (`env`, `ok`, and every item with `expected`, `actual`, `ok`,
`required`) and exits 1 when a required item fails. Exempt items are reported
with `"required": false` and never fail. It never prints environment
variables; command output is cut to its first line. rustup auto-install is off
unless the caller sets `RUSTUP_AUTO_INSTALL` (CI does). Tests:
`python3 -B scripts/env/test_check.py`.

## Contract

| Item | Requirement | Pin lives in |
| -- | -- | -- |
| OS | Ubuntu (Debian family) LTS, x86_64 | — |
| Rust | 1.99.0 with `rustfmt` and `clippy`, as `rustc` resolves inside the repo | `rust-toolchain.toml` |
| Node | 24.22.0, as `node` resolves in `kiosk/` and the repo root | `kiosk/package.json` `devEngines.runtime`, `.node-version` |
| Package manager | pnpm 12.11.2 in `kiosk/` (Bun after MET-224) | `kiosk/package.json` `devEngines.packageManager` |
| Vite+ | `vp` v1.1.0 on PATH in `kiosk/` | `scripts/env/check`, `.agents/setup`, `ci.yml` |
| Playwright | a Chromium browser (`chromium-*`) in `PLAYWRIGHT_BROWSERS_PATH`, `kiosk/.browsers` or `~/.cache/ms-playwright`; required where kiosk UI checks run | — |
| System packages | build-essential (`cc`, `make`), pkg-config, ca-certificates, curl, python3, util-linux (`flock`), bubblewrap (`bwrap`), shellcheck, sqlite3, zstd, rsync, xz-utils (`xz`) | `.agents/setup` |

System packages are checked by the command each provides, not by package
manager records. `scripts/dispatch` and `scripts/usage` keep their own
`.node-version` (24.21.0) for the dispatcher and usage collector services.

## Layout

Where kiosk UI checks run (the `verify-kiosk` skill):

* `/home/agent/work/factory` is the factory checkout. In cloud VMs it is a
  symlink to the workspace checkout.
* `/home/agent/.config/vite-plus/env` is the Vite+ env file that `verify-kiosk`
  sources to put `vp`, `node` and `pnpm` on PATH.

## Environments

| Environment | Provisioned by | Exempt from |
| -- | -- | -- |
| `orb` (Amp) | `.agents/setup` on orb creation | Playwright (setup downloads no browsers), layout |
| `cursor` (Cursor Cloud) | Team environment in the Cursor dashboard: `metacomet-technologies/factory`, id `d36f659b…`, snapshot `snapshot-20261016-…`. Install script there; no repo `.cursor/environment.json`, which would override it | nothing |
| `sandbox` (`scripts/sandbox` host) | The host it runs on (orb, Cursor or runner); CI's `sandbox` job installs its own prerequisites | Playwright, layout |
| `ci` (GitHub Actions `kiosk` job, ubuntu-24.04) | `.github/workflows/ci.yml`: `setup-node` and npm from the pins, rustup from `rust-toolchain.toml` | Playwright, layout |
| `factory-gpu` | By hand (admin), converging through MET-225 | nothing |
| `factory-console` | By hand (admin), converging through MET-225 | nothing |

Exemptions live in `EXEMPT` in `scripts/env/check`.

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

Claude Code and Codex cloud are next.

1. Add its name to `EXEMPT` in `scripts/env/check`, with only the exemptions it
   truly needs, and a row to the table above.
2. Provision it to the contract. Prefer the shared setup script once MET-225
   lands; otherwise mirror `.agents/setup`. Keep its config where the vendor
   versions it, and say where in the table.
3. If it runs kiosk UI checks, meet the layout (symlink the checkout to
   `/home/agent/work/factory`) and install Playwright Chromium.
4. Run `scripts/env/check --env <name>` there and record the JSON on the issue.
