# Metacomet software factory

The factory runs local AI for Metacomet on two Ubuntu nodes on the Metacomet
tailnet. factory-gpu runs Ollama behind **meter** (a metering proxy),
**factory-api** (aggregation API, alerts and the kiosk's static files),
**ups-control**, backups and an Amp runner. factory-console is an optional
satellite: the kiosk display, backup replicas and a second runner. The
operating manual is [docs/PLAYBOOK.md](docs/PLAYBOOK.md); agent rules are in
[AGENTS.md](AGENTS.md).

## Layout

| Path | What |
|---|---|
| `meter/` | Ollama metering proxy, :11434 ([README](meter/README.md)) |
| `factory-api/` | Aggregation API v1, Slack alerts, kiosk hosting, :8080 behind Tailscale Serve ([README](factory-api/README.md)) |
| `kiosk/` | React dashboard ([README](kiosk/README.md), [style guide](docs/agents/kiosk-styleguide.md)) |
| `pricing/` | Reference model rates and spend-avoided estimates ([README](pricing/README.md)) |
| `shared/`, `factory-db/` | API contract types; SQLite pool, PRAGMAs and migrations ([data model](docs/data-model.md)) |
| `ups-control/`, `devices-agent/` | UPS control service ([docs](docs/ups.md)); device telemetry agent ([docs](docs/devices.md)) |
| `sandbox/`, `scripts/sandbox` | Isolated synthetic stack for live checks ([docs](docs/sandbox.md)) |
| `scripts/usage/` | Agent usage collector ([README](scripts/usage/README.md)) |
| `scripts/env/` | Toolchain contract and setup ([docs](docs/environments.md)) |
| `deploy/` | Installers, rollbacks, units, `factory-deploy` and the auto-deployer |
| `client/` | Devon's Mac helpers (`gpu-ssh`, `factory-status`, ...) |
| `docs/` | Reference docs; `docs/agents/` holds per-area agent rules |

## Working

Commit to `main` and push. Before pushing, run `scripts/check`: it runs only
the check groups your change touches (`--list` shows them, `--all` runs all of
them). Enable it as a pre-push hook once per clone:

```sh
git config core.hooksPath .githooks
```

CI runs `scripts/check --all` plus the sandbox stack on every push; the
`ci-ok` check is the verdict. A red main is fixed or reverted before anything
else. Test against the sandbox (`scripts/sandbox up`), never production.

## Deploying

Nobody deploys by hand. `factory-autodeploy.timer` on factory-gpu checks main
every 2 minutes. When `ci-ok` is green it compares each component's running
`inputs_fingerprint` with `scripts/build-fingerprint.sh` at the new commit and
runs `sudo factory-deploy` for meter, factory-api and kiosk where they differ.
`factory-deploy` builds as `agent`, installs, probes health three times and
rolls back on failure. Failures post `deploy:*` alerts to Slack; the latest
state is in `/var/lib/factory-autodeploy/status.json`. Details:
[PLAYBOOK §6](docs/PLAYBOOK.md#6-deploy-flow) and
[deploy/sudoers/README.md](deploy/sudoers/README.md).

Everything else (backups, alerts, usage, devices, UPS, pricing, reboot policy,
the auto-deployer's own units) and meter DB migrations are installed by Devon
with the `deploy/install-*.sh` scripts, each with a matching `rollback-*.sh`.

## Versions and build identity

`main` is what runs; there are no release tags. The root `VERSION` file is the
repo-wide 0.x SemVer that every crate and `kiosk/package.json` must match; bump
it with `scripts/bump-version.sh 0.2.1` and commit. Each component reports
`version`, short `git_sha`, `git_dirty`, `built_at_ms` and `inputs_fingerprint`
(meter `/meter/health`, factory-api `/v1/health`, kiosk `/version.json`); the
kiosk footer shows them and warns on mismatches.

`factory-api/openapi.json` is the committed API contract. After an intentional
schema change:

```sh
UPDATE_OPENAPI=1 cargo test -p factory-api --test openapi_snapshot
cd kiosk && OPENAPI_URL=file://$PWD/../factory-api/openapi.json vp run api:types
```

## Docs

- Operations: [PLAYBOOK](docs/PLAYBOOK.md), [alerts](docs/alerts.md),
  [backups](docs/backups.md), [off-site backups](docs/offsite-backups.md),
  [reboot policy](docs/reboot-policy.md), [UPS](docs/ups.md),
  [network](docs/network.md), [devices](docs/devices.md)
- Development: [environments](docs/environments.md), [orbs](docs/orbs.md),
  [sandbox](docs/sandbox.md),
  [data model](docs/data-model.md)
