# Devices

Phase 1 reads factory-gpu from the factory-api process. There is no second GPU
sample store and no remote ingestion.

Phase 2 remote ingestion design (for review): [devices-ingest.md](devices-ingest.md).

## Sources

| Reading | Source |
| --- | --- |
| CPU, memory, load, disk I/O, network, uptime | `/proc` under `FACTORY_DEVICES_ROOT` (default `/`) |
| Filesystems, drives, temperatures, fans | `/sys` and mount info under the same root |
| Filesystem capacity in a fixture | `{root}/sys/fs/factory-mountstat` |
| GPU | live `GET /meter/gpu` through `AppState::gpu_current` |
| UPS | current summary only, with href `/ups` |
| Backup | `/var/lib/factory-backup-status/status.json` |
| Clock | `require_clock` |
| SMART | `{root}/var/lib/factory-devices/smart.json` |
| Unsafe shutdown count per drive | NVMe `unsafe_shutdowns` in the same SMART snapshot; omitted when absent |
| Pending updates, held packages | `apt list --upgradable`, `apt-mark showhold`, published in `{root}/var/lib/factory-devices/maintenance.json` |
| Maintenance services | `systemctl is-enabled unattended-upgrades.service`, `fstrim.timer`, `smartmontools.service` |
| Unattended auto-reboot | exact `Unattended-Upgrade::Automatic-Reboot` key from `apt-config dump` |
| Tailscale auto-update | only `AutoUpdate.Check` and `AutoUpdate.Apply` from `tailscale debug prefs` |
| Journal size | total file bytes under `/var/log/journal` |
| Reboot age | `/var/lib/factory-reboot-status/status.json` |
| Fleet services | the factory-gpu node already collected by fleet |

factory-api does not run `nvidia-smi` or `smartctl`. A missing or unreadable
SMART file is `permission_denied`. `tool: "absent"` is `unsupported`.

## Intervals

Fast samples run every 15 seconds. Slow inventory runs every 5 minutes. One
collection runs at a time. The first CPU, disk, and network sample has a null
rate. A counter reset, boot id change, or gap longer than 30 seconds starts a
new window. History is not interpolated across that gap.

A fast sample older than 30 seconds, or a failed fast collection, makes the
host `stale`. Alerting uses a separate 2 minute stale threshold.

The root `factory-devices-maintenance.timer` publishes hourly with
`Persistent=true`. The API reads that file on the existing 5-minute slow
inventory. A maintenance observation older than 2 hours is `stale`, including
when a served cached observation crosses that boundary. Stale values remain
visible with their observation time. Maintenance does not change host health.
Update counts reflect the existing apt cache. The helper never refreshes that
cache, installs packages, or changes settings.

## Retention

`device_samples` keeps raw rows for 7 days. `device_rollup_hourly` keeps the
hourly min, avg, and max. A raw row is deleted only after its hour's rollup is
committed, and only in batches of 1000. Hourly rows stay.

`GET /v1/devices/factory-gpu/history?range=1h|24h|7d` returns at most 720
points. The 1 hour range buckets raw rows. The longer ranges read hourly
rollups. Missing hours are left empty.

## Schema

Migration version 2 on the requests database adds `device_samples` and
`device_rollup_hourly`. Both tables are STRICT. Timestamps are INTEGER
milliseconds. Version 1 is unchanged.

Live readings are served from memory when the clock is not synchronized.
History writes wait for the clock, the same way UPS history does.

### Maintenance snapshot v1

`maintenance.json` contains `schema: 1`, UTC `observed_at_ms`, and these sections:

| Section | Fields when available |
| --- | --- |
| `updates` | integer `security`, `other`; security means an origin contains `-security` |
| `held` | `packages`, a sorted list of held package names |
| `services` | `unattended_upgrades`, `fstrim_timer`, `smartd`, each `enabled`, `disabled`, `absent`, or `unknown` |
| `unattended_auto_reboot` | boolean `value`; an unset apt key defaults to false |
| `tailscale_auto_update` | boolean `check`, `apply`; no other preference fields are retained |
| `journal_bytes` | integer `value`, without following symbolic links |

Each section has `availability` (`available`, `unsupported`, or `error`) and an
optional sanitized `error`. An unavailable section omits its values, except
`services`, which retains each independent service state. A failed probe does
not blank successful probes. Missing commands are `unsupported`.

`GET /v1/devices/factory-gpu` adds optional response-level `maintenance` with
these fields and overall `availability`. The existing `device.maintenance`
still holds backup, reboot, clock, power, and fleet service readings unchanged.
A missing or unreadable file returns `maintenance.availability: permission_denied`.
Malformed content is `error`; an unsupported schema is `unsupported`. File
failure omits snapshot fields rather than inventing zero counts.

Each `device.drives[]` optionally includes integer `unsafe_shutdowns`. A drive
without an NVMe counter omits that field. It is not a SMART health threshold.

## API

- `GET /v1/devices`
- `GET /v1/devices/factory-gpu`
- `GET /v1/devices/factory-gpu/history?range=1h|24h|7d`

Other ranges return 400. Unknown device ids return 404. The list shape can
hold another id later. This phase only emits `factory-gpu`.

A metric value is null unless its availability is `available`. Unknown is
never stored as zero. A failed probe leaves unrelated good readings in place.

The SSE event is `devices.sample`. History still comes from GET. A disconnect
clears the live sample in the kiosk so the last frame is not shown as current.

## Health

Status is `critical`, `warning`, `healthy`, `unknown`, or `stale`. Each reason
names the metric, the threshold, and the value. Missing CPU utilization,
memory totals, filesystem capacity, or host uptime is not healthy. Unsupported
fans, and SMART that is unsupported because the tool or permission is absent,
do not fail the host. A drive with failed SMART, spare at or below its
threshold, or a critical media counter is critical. That state is shown on the
drive. Unsupported SMART is not evidence the drive is healthy.

Immediate health thresholds match the alerts: CPU temperature warning 80 °C
and critical 95 °C, filesystem space and inodes warning 85% and critical 95%.

## Alerts

These keys are new. Fleet already covers the other host alerts.

| Key | Fire | Clear |
| --- | --- | --- |
| `devices:cpu:temperature:warning` | 80 °C for 5 minutes | below 75 °C |
| `devices:cpu:temperature:critical` | 95 °C for 2 minutes | below 90 °C |
| `devices:fs:{id}:space:warning` and `:inodes:warning` | 85% for 10 minutes | below 80% |
| `devices:fs:{id}:space:critical` and `:inodes:critical` | 95% for 10 minutes | below 90% |
| `devices:smart:{id}` | unhealthy for 60 seconds | healthy for 2 minutes |
| `devices:telemetry` | no fast sample for 2 minutes | a fresh fast sample |
| `devices:unsafe_shutdowns:{id}:{count}` | one notice per counter increase after the first baseline | one-shot, no recovery |

An unreadable source holds open alerts. It does not clear them. A fast sample
older than 2 minutes does not open a new temperature or filesystem alert from
those stale numbers.

## Permissions

The SMART helper in `deploy/devices/` is allowlisted and read-only. It writes
`/var/lib/factory-devices/smart.json` by rename, mode 0640, and does not put
secrets, file contents, environment, or process arguments in the file. When
the `factory-api` group exists, the directory is `root:factory-api` mode
`2750`, and re-running the installer keeps that group and the setgid bit.
The helper runs as root and chowns the temporary file to `factory-api` before
rename, so the live snapshot stays `root:factory-api` mode `0640` after every
timer run. A failed chown removes the temporary file, leaves the previous
snapshot in place, and fails the service. The installer does not run
`smartctl` and does not install packages.

The maintenance helper uses the same atomic writer, directory, group, and mode
for `maintenance.json`. It publishes only the fields listed above, never raw
command output or Tailscale preferences. Its service runs as root so apt,
systemd, and journal observations do not need extra API permissions.

Private reboot status at `/var/lib/factory-reboot/status.json` stays root mode
0600 under a mode 0700 directory. factory-api cannot read that file. The reboot
installer publishes `/var/lib/factory-reboot-status/status.json` when the
`factory-api` group exists: directory `root:factory-api` mode 0750, file mode
0640 and group `factory-api`. The published copy contains `reboot_required`,
`pending_since_ms`, `days_pending`, `consecutive_skips`, `alert_due`,
`last_check_ms`, and `last_decision`. It does not include secrets, environment,
or process arguments. A missing or unreadable published file is
`permission_denied`, not healthy and not zero. `FACTORY_API_REBOOT_STATUS`
overrides the path. This does not change reboot policy and does not chmod the
private file.

Backup status that factory-api can read is
`/var/lib/factory-backup-status/status.json`, with `last_success_ms`,
`last_attempt_ms`, and `error`.

## Install and rollback

Devon runs these from his Mac after reviewing the PR. No deploy runs in an
agent session. Build and read worktree files as `agent`, then stage artifacts
outside `/home/agent` for the root installers. Save each printed backup path
and the staging directory. These commands install the helpers, API, and kiosk:

```sh
gpu-ssh "sudo -u agent bash -lc 'cd /home/agent/work/factory-met-217-devices-node-maintenance-status && cargo build --release --locked -p factory-api && cd kiosk && VITE_API_BASE= vp build'"
gpu-ssh 'set -euo pipefail; stage=$(mktemp -d /tmp/met-217.XXXXXX); sudo -u agent tar -C /home/agent/work/factory-met-217-devices-node-maintenance-status -cf - deploy target/release/factory-api kiosk/dist | tar -xf - -C "$stage"; printf "Keep staging directory for preflight/rollback: %s\n" "$stage"; sudo bash "$stage/deploy/devices/install-devices.sh"; sudo bash "$stage/deploy/install-factory-api.sh" "$stage/target/release/factory-api"; sudo bash "$stage/deploy/install-kiosk.sh" "$stage/kiosk/dist"'
# Use the staging directory printed above:
gpu-ssh 'sudo bash /tmp/met-217.XXXXXX/deploy/devices/install-devices.sh --preflight'
gpu-ssh 'sudo systemctl start factory-devices-maintenance.service factory-devices-smart.service; sudo python3 -m json.tool /var/lib/factory-devices/maintenance.json; sudo systemctl status factory-devices-maintenance.timer --no-pager'
```

There is no DB migration for MET-217. The existing API installer's backup and
schema preflight gates still apply. Do not restart Ollama or change factory-console.

Verify the new response-level `maintenance` object and the Maintenance card:

```sh
gpu-ssh 'curl -fsS http://127.0.0.1:8080/v1/devices/factory-gpu | python3 -c '\''import json,sys; print(json.dumps(json.load(sys.stdin).get("maintenance"), indent=2))'\'''
# Open https://factory-gpu.bearded-pompano.ts.net/devices/factory-gpu
# Replace placeholders with the printed staging and component backup paths:
gpu-ssh 'sudo bash /tmp/met-217.XXXXXX/deploy/rollback-kiosk.sh /var/backups/factory-kiosk/KIOSK_SNAPSHOT'
gpu-ssh 'sudo bash /tmp/met-217.XXXXXX/deploy/rollback-factory-api.sh /var/backups/factory-api/API_SNAPSHOT'
gpu-ssh 'sudo bash /tmp/met-217.XXXXXX/deploy/devices/rollback-devices.sh /var/backups/factory-devices/DEVICES_SNAPSHOT'
```

Rollback restores previous helpers and units, disabling the maintenance timer
and stopping its service when those files were absent before install. The last
maintenance snapshot can remain as historical data. Revert the API and kiosk
through their own printed rollback snapshots.

Unprivileged tests use `DEVICES_TEST_ROOT` and do not call host `smartctl`.

## After deploy

1. `GET /v1/devices` lists `factory-gpu`.
2. CPU rate is null on the first sample and a number on the next.
3. Memory, filesystem, and uptime values are null where the probe failed, never `0` standing in for unknown.
4. SMART is `permission_denied` until the timer writes a snapshot, or `unsupported`
   when `smartctl` is absent. After that write, the directory is mode `2750`,
   `smart.json` is group `factory-api`, and `collector.smart` is `available`
   or `unsupported`.
5. Reboot age stays `permission_denied` until a group-readable status file exists.
6. `GET /v1/devices/factory-gpu/history?range=30d` returns 400.
7. The kiosk links `/devices` and `/devices/factory-gpu` render, and a stream disconnect stops showing the last sample as live.

## Rollback of the API

Revert the factory-api binary. Version 2 tables can stay. They are unused by
the previous binary. Do not delete the requests database to roll this back.
