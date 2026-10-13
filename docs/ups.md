# NUT on factory-gpu

Deployment artifacts only. Devon runs these after merge and the dispatcher
updates the clean `/home/agent/work/factory` checkout. No build is needed.
Never install on factory-console: it is not connected to this UPS.

## Installed configuration

`deploy/ups/install-nut.sh` installs Ubuntu's `nut` package only when missing.
It renders five templates for `/etc/nut`, matching MET-104's recorded live
configuration from 2026-10-13:

- `nut.conf`: standalone mode.
- `ups.conf`: `cyberpower`, `usbhid-ups`, automatic USB discovery, vendor
  `0764`, product `0601` (CyberPower CP1000PFCLCDa).
- `upsd.conf`: listen only on `127.0.0.1:3493`, never the tailnet.
- `upsd.users`: one `upsmon` primary user.
- `upsmon.conf`: monitor `cyberpower@localhost`, one required supply,
  `/sbin/shutdown -h +0`, `POWERDOWNFLAG /etc/killpower`, `FINALDELAY 5`.

`ignorelb` uses driver-derived low-battery status instead of the hardware's
low-battery flag. Low thresholds are **30% charge / 300 seconds runtime**.
While on battery, reaching the low-battery condition initiates clean shutdown.
The UPS power-down flag supports cutting/restoring power; BIOS AC-power recovery
is configured separately. This installer does not change BIOS settings or test
physical power loss.

The existing `[upsmon]` password is reused. If absent, the node runs
`openssl rand -hex 16`. Both credential files (and the other managed files) are
`root:nut 0640`. No password is printed or stored in the repository.
`upssched.conf` and all other files are untouched by installation.

## Dry-run, then install (from Devon's Mac)

```sh
factory-ssh 'sudo bash /home/agent/work/factory/deploy/ups/install-nut.sh --dry-run'
factory-ssh 'sudo bash /home/agent/work/factory/deploy/ups/install-nut.sh'
```

Stop and review any unexpected diff before installing. Dry-run creates no
temporary files, backups, accounts, package operations, udev actions or service
changes. Its unified diff normalizes comments, spacing and quoting and masks
password assignments and MONITOR credentials. A missing password is represented
as masked; generation occurs only during installation. Equivalent live config
should produce no functional diff. Password-only differences produce a
`credential differs (masked)` notice without either value; installation
reconciles the monitor credential with `upsd.users`.

Installation preflights commands and paths, renders privately, then snapshots
the complete `/etc/nut` tree (or records its absence) under
`/var/backups/nut-<UTC>.<unique-suffix>` before changing configuration or accounts.
Snapshots are private (0700) and contain credentials: do not share their contents.
It creates the `nut` group if necessary so config can be written **before**
`apt-get install -y nut`. This avoids the known unconfigured post-install startup
deadlock. It reloads udev rules and retriggers USB vendor `0764`, then waits for
udev to settle, fixing permissions when USB was attached before package install.

Only changed config restarts `nut-server` and `nut-monitor`. Equivalent files
retain their bytes, comments and modification times; permissions are enforced.
Reruns still take a snapshot, retrigger udev and verify health, but skip package
installation and service restarts. The installer waits up to 45 seconds each for
UPS status and local upsmon login. It requires `OL` or `OB` (with optional status
flags), read as the `nut` service user, and
`upsmon@127.0.0.1 logged into UPS` in the nut-server journal. Changed config
uses logs since restart; unchanged config uses the current boot journal.
Failures stop with a rollback command; rollback is never automatic.

Optional verification from Mac (no power-loss test):

```sh
factory-ssh 'upsc cyberpower@localhost ups.status'
factory-ssh 'sudo journalctl -u nut-server -b --no-pager --grep="upsmon@127.0.0.1 logged into UPS"'
```

## Rollback (from Devon's Mac)

Use the exact snapshot path printed by installation; replace the placeholder:

```sh
factory-ssh 'sudo bash /home/agent/work/factory/deploy/ups/rollback-nut.sh /var/backups/nut-<printed-UTC-and-suffix>'
```

Rollback stops both services, retains the displaced tree in a private
`/var/backups/nut-pre-rollback-<UTC>.<unique-suffix>` directory, restores the
entire snapshot with bytes, ownership, permissions and timestamps preserved,
then restarts both services. Files added after the snapshot leave `/etc/nut`
but remain in that recovery directory. A snapshot of an absent tree restores
absence; services may fail to restart in that case. The package and `nut` group
remain installed. Verify status again after restoring a working configuration.

## Development checks (no root or production access)

```sh
bash -n deploy/ups/install-nut.sh deploy/ups/rollback-nut.sh
python3 -B deploy/ups/test-nut.py
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
```

The fake-root suite runs the real scripts with stubbed package, service, udev,
journal and UPS commands. It checks read-only dry-run, masking, config-before-apt,
password reuse/generation, thresholds, equivalent-config/rerun restart avoidance,
untouched scheduling, exact snapshot restoration and failure rollback hints.
Ownership changes are stubbed; file modes and bytes are real. It cannot prove
physical USB access, actual systemd startup, live journal login or clean shutdown.
`NUT_TEST_ROOT` is accepted only for unprivileged tests; root invocations ignore it
and always target the node. No sandbox or production check is part of this task.
