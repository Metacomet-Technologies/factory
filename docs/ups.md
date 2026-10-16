# NUT and UPS control on factory-gpu

Deployment artifacts only. Devon runs these after merge and the dispatcher
updates the clean `/home/agent/work/factory` checkout and builds
`cargo build --release --locked -p factory-ups-control` as agent.
Never install on factory-console: it is not connected to this UPS.

## End-to-end architecture

NUT reads the CyberPower UPS over USB on factory-gpu. `factory-api` collects that
state for the dashboard card, [`/ups` controls](../kiosk/README.md#ups-controls-met-168),
[`/ups` history and settings](../kiosk/README.md#ups-history-and-settings-met-167),
and [synthetic UPS checks](sandbox.md#ups-fake-met-162). The kiosk uses the
same-origin `/control` mount only for control state and requests.
`factory-ups-control` accepts those requests only after its independent identity
guard verifies the live loopback peer and Devon or David's Tailscale identity;
tagged nodes have no identity header and are refused. A requested action needs a
short-lived, exact typed confirmation before the service performs its fixed NUT
command. It records confirmation and result in its own audit DB, then queues
control-service [Slack delivery](#audit-slack-timer-and-rollback-preserve-state).
Factory-api's alert engine evaluates five UPS alerts and posts to `#factory-alerts`:
on battery (30 s hold), low battery (critical), replace battery, communications
lost (60 s), and self-test failed. This connects the components below without
duplicating their configuration: [identity guard](#control-identity-is-checked-independently-of-factory-api),
[confirmation and tracking](#confirmations-and-tracking-distinguish-acceptance-from-execution),
[power behavior](#power-cycle-uses-only-the-late-nut-shutdown-path), and
[audit and timer](#audit-slack-timer-and-rollback-preserve-state).

## Installed configuration

`deploy/ups/install-nut.sh` installs Ubuntu's `nut` package only when missing.
It renders five templates for `/etc/nut`, matching MET-104's recorded live
configuration from 2026-10-13:

- `nut.conf`: standalone mode.
- `ups.conf`: `cyberpower`, `usbhid-ups`, automatic USB discovery, vendor
  `0764`, product `0601` (CyberPower CP1000PFCLCDa), and explicit
  `sdcommands = shutdown.return` for the late OS shutdown hook.
- `upsd.conf`: listen only on `127.0.0.1:3493`, never the tailnet.
- `upsd.users`: `upsmon` primary and a separate `factory-control` user.
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
The control password is independently generated/reused, with a root-only
`/etc/nut/factory-control.password` (0600) for `LoadCredential=nut-password:`.
The entire `/etc/nut` snapshot includes this file and both users.
`upssched.conf` and other unmanaged files are untouched.

## Dry-run, then install (from Devon's Mac)

Use the ordered deployment commands below. They stage artifacts as agent because
the administrator cannot traverse `/home/agent`; root executes only staged copies.

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
deadlock. Package installation sets `DEBIAN_FRONTEND=noninteractive` and passes
dpkg `--force-confdef --force-confold`, keeping the rendered files without a
conffile prompt. dpkg may leave `*.dpkg-dist` copies in `/etc/nut`; these contain
the stock samples, are safe to delete, and are captured by later snapshots.
It reloads udev rules and retriggers USB vendor `0764`, then waits for udev to
settle, fixing permissions when USB was attached before package install.

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
gpu-ssh 'upsc cyberpower@localhost ups.status'
gpu-ssh 'sudo journalctl -u nut-server -b --no-pager --grep="upsmon@127.0.0.1 logged into UPS"'
```

## Rollback (from Devon's Mac)

Use the exact snapshot path printed by installation; replace the placeholder:

Use the staged `rollback-nut.sh` command below with the exact printed snapshot.

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
and always target the node. Physical checks remain Devon's responsibility.

## Control identity is checked independently of factory-api

`factory-ups-control` runs as its own non-login system user and binds only
`127.0.0.1:8090`. It has no factory-api dependency or routes. Every request,
including unknown paths and methods, checks the loopback peer, the connecting
socket's UID from `/proc/net/tcp` or `/proc/net/tcp6`, and exactly one allowlisted
`Tailscale-User-Login`. Matching uses both endpoints, ports and ESTABLISHED state;
missing, ambiguous or unreadable ownership fails closed. The default trusted UID
is 0 (tailscaled), never agent or the control-service UID. Root remains trusted.
Missing/unlisted identities are rejected before scanning sockets. Required scans
run on blocking workers, at most four concurrently, so parsing cannot stall the
async NUT requests. A missing/ambiguous match receives up to three fresh reads
because the kernel socket walk is not atomic under connection churn; no cached
UID or header can substitute for a unique live match.
The default users are `DGarbs51@github,metacometdave@github`, case-sensitive.
Denials always return 403. The bounded audit samples retain the claimed,
untrusted login; excess denials are counted in aggregate as described below.

The current [Serve documentation, Identity headers](https://tailscale.com/kb/1312/serve#identity-headers)
explicitly says: “These identity headers are not populated for traffic originating
from tagged devices.” It also documents stripping incoming identity headers before
injecting verified user identity. Thus a tagged factory node cannot supply a human
identity through Serve. Header checks alone would not stop a local agent; the UID
check is required. Never deploy with the sandbox user's UID.

The current [Serve CLI documentation](https://tailscale.com/kb/1242/tailscale-serve)
documents `--bg`, `--https=443`, `--set-path=<path>` and matching path-only `off`.
The command below adds `/control` without replacing the dashboard's `/` mount:

```sh
tailscale serve --bg --https=443 --set-path /control http://127.0.0.1:8090
```

Serve strips the mount prefix before proxying ([implementation](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go)).
External `/control/v1/state` therefore reaches backend `/v1/state`.
The sandbox reproduces this rewrite and strips forged identity headers.
These links and behavior were checked on 2026-10-14; no live Serve config was changed.

## Confirmations and tracking distinguish acceptance from execution

The complete JSON contract is `ups-control/openapi.json`. External paths:

- `GET /control/v1/state`: login, actions/tiers/phrases/disabled reason, current
  writable settings and ENUM/RANGE constraints, pending power action, 20 audit rows.
- `POST /control/v1/actions`: `{ "action": "test.quick" }` or
  `{ "action": "input.sensitivity", "value": "high" }`. Returns integer `id`,
  `confirm_phrase`, and UTC `expires_ms`, 60 seconds after creation.
- `POST /control/v1/actions/{id}/confirm`: `{ "phrase": "confirm test.quick" }`.
  Requires the same login and exact phrase. The ID is consumed before repeating
  preflight; a failed or uncertain attempt cannot reuse it.
- `GET /control/v1/audit?limit=20&before_ms=...`: newest-first rows; limit 1–100,
  exclusive millisecond cutoff. Audit and confirmation rows are retained indefinitely.

All endpoints share a 30-request-per-login, fixed one-minute window. Guard failures
remain 403; authenticated rate limits return 429. POST requires `application/json`,
rejects cross-site fetches, accepts no extra JSON fields, and limits bodies to 4 KiB
and five seconds. No CORS is enabled. Validation/preflight failures return 409.

For every INSTCMD and SET VAR connection, the service authenticates, sends
`SET TRACKING ON`, requires `OK TRACKING <uuid>`, then polls `GET TRACKING <uuid>`
for at most ten seconds using a monotonic deadline. Only `SUCCESS` produces an
`execute` audit event and `executed=true`. Plain `OK`, malformed/missing tracking,
and `ERR FAILED`/other failures produce `executed=false` (HTTP 409). Still `PENDING`
at ten seconds produces `executed=false`, `tracking_status=PENDING` (HTTP 202).
Audit, API and Slack use the same outcome. NUT calls failure `ERR FAILED`, not a
literal `FAILURE` response; the API normalizes failures to `FAILURE`.

**Not executed means not confirmed by the deadline, not proof no device effect
occurred.** No automatic command retries occur. `SUCCESS` confirms driver handling,
not completion of a battery test or the physical effects of a delayed command.
The timer journals the tracked quick-test command result; inspect `ups.test.result`
for the later battery-test outcome. See NUT 2.8.4
[protocol tracking](https://github.com/networkupstools/nut/blob/v2.8.4/docs/net-protocol.txt)
and [tracking status implementation](https://github.com/networkupstools/nut/blob/v2.8.4/server/upsd.c).

Quick tests require exactly `OL`, exactly 100% charge and a known non-running test
result: `Done and passed`, `Done and warning`, `Done and error`, `Aborted`, or
`No test initiated` (case-insensitive exact matches). `In progress`, `Test scheduled`,
unknown and missing results are refused, including by the scheduled command.
Tests have a per-action ten-minute cooldown, including unconfirmed attempts.
Settings use upsd ENUM/RANGE; without transfer ranges the policy is low 90–105,
high 130–140, always low < high. Shutdown delay is restricted to 30–600 and start
delay to 0–600, intersected with any reported ranges. Audit records old and requested
new values, even when the driver rejects the change. All settings are re-read at
confirmation, not trusted from the initial request.

## Power cycle uses only the late NUT shutdown path

The NUT user has exactly these `instcmds`: `test.battery.start.quick`,
`test.battery.stop`, `beeper.enable`, `beeper.disable`, `beeper.mute`, `shutdown.stop`.
It has `actions = SET FSD`, with no `upsmon` role. NUT 2.8.4's
[`net_fsd`](https://github.com/networkupstools/nut/blob/v2.8.4/server/netmisc.c#L100-L127)
checks the FSD action directly; LOGIN/PRIMARY and `upsmon primary` are unnecessary.
SET permission itself cannot limit variable names; the service's fixed allowlist
does that, and only its systemd credential gives it the password.

`power.cycle` requires `power-cycle <hostname>`, online status without OB/LB/FSD,
no pending cycle, and a 30-minute cooldown. It sends only `FSD cyberpower`.
FSD has no tracking support: `OK FSD-SET` confirms the server latch, so API/audit
report `FSD_SET`, `executed=false`, “clean shutdown requested”, never physical
completion. The API includes a 5–15 minute planning budget; configured UPS delays,
OS shutdown and boot determine actual downtime. A response may be lost as shutdown
begins: inspect audit after return; do not blindly repeat the action.

upsmon treats FSD as critical, writes `/etc/killpower`, and initiates clean OS
shutdown. The [late systemd NUT hook](https://github.com/networkupstools/nut/blob/v2.8.4/scripts/systemd/nutshutdown.in)
checks that flag and runs `upsdrvctl shutdown`. Explicit `sdcommands=shutdown.return`
prevents fallback to a different mode. CyberPower's
[driver implementation](https://github.com/networkupstools/nut/blob/v2.8.4/drivers/usbhid-ups.c)
programs startup delay and shutdown delay at that late stage. No early load-off,
killpower, deep test, driver reload or shutdown.default command is exposed.

`power.off_stay` is **disabled with a reason in state**. Sending stay-off early could
cut power before halt, and final shutdown.return could override it. This version
does not replace the OS shutdown hook or claim a physical stay-off guarantee.
Driver handling and firmware timing still require the supervised test below.
`shutdown.stop` cancels a driver's pending shutdown delay; it does **not** clear
upsd's FSD latch or cancel an OS shutdown already begun.

An attempted FSD reserves the current boot durably before sending it, including
uncertain failures. Restarting the daemon does not clear that reservation. A new
boot clears it logically; all audit history remains. If shutdown fails, Devon must
inspect NUT/OS state rather than resetting the reservation through an API.

## Audit, Slack, timer and rollback preserve state

`/var/lib/factory-ups-control/audit.db` uses factory-db's bounded writer/reader pool,
shared PRAGMAs and versioned migration runner. Tables are STRICT; timestamps use
UTC integer milliseconds. Audit/time, cooldown, pending power and notification
queries have indexes. Every table retains rows indefinitely. Only the daemon's
startup `migrate` command runs schema changes; the scheduled command refuses an
uninitialized/newer schema. The installer stops both writers and verifies a SQLite
backup and table counts before opening an existing database with a new binary.
Action file locking serializes timer and API across processes; a durable dispatch
row precedes NUT writes. A crash leaves an unconfirmed attempt, never fabricated
execution. Confirmations and cooldowns survive service restarts.

Both systemd units load `nut-password` and the existing alerts bot's
`/etc/factory-alerts/slack-token` as `slack-bot-token`. The service reads credential
files directly, never argv or a shell. Slack uses the existing `#factory-alerts`
channel ID `C0C9N9HCRG8`. Every execution/failure and scheduled refusal is queued
in the audit database. An in-memory, process-wide budget admits at most eight
individual guard-denial audit attempts per window, before any database work.
Denial writes are serialized, occupying at most one pool slot rather than allowing
a flood to exhaust the queue needed by allowed callers. Excess denials still
receive 403 and increment a saturating in-memory count. After at least 60 seconds,
the next notification-worker tick writes one additional `guard-deny` summary row
with no login and the suppressed count, then renews the budget. This happens even
if the flood stops; empty summaries are omitted. Windows can extend while the
worker is busy. Restart resets the budget and loses any unflushed suppressed count.
Sample and summary guard alerts share the existing at-most-one-per-minute Slack
selection rule. Failed Slack delivery remains queued for retry.
Delivery is at-least-once: a crash after posting but before acknowledgement can
duplicate a post. Unknown dispatches are reported after 30 seconds.

`factory-ups-selftest.timer`: `Sat *-*-01..07 11:00:00`, host-local time,
`Persistent=false`. It runs `factory-ups-control selftest --scheduled`, applies
the same preflight/cooldown and refuses uptime under one hour. A busy action lock
is also recorded as a scheduled refusal and queued for Slack. The deployed
`factory-gpu.conf` reboot window is 06:00 America/New_York, five hours earlier
when the host timezone is America/New_York. The installer requires that timezone
and never changes it. No missed monthly tests catch up.

The control installer takes `PREBUILT_BINARY TRUSTED_UID ALLOWED_LOGINS_CSV`,
supports read-only `--dry-run`/`--preflight`, snapshots binary/units/enabled and
active state, then starts the daemon and timer. Its HTTP check is a forged allowed
header from the untrusted service UID, which must return 403. It never runs a test
or a power action. Reruns converge on the same files, preserve the database and
take a fresh snapshot; they restart the service. Rollback restores files/service
state and leaves the user, audit DB and verified snapshots intact. It does not
automatically downgrade a database for an older binary.

Backup config adds `ups-control` on GPU and console's receiver list. Both nodes
must receive the new config before the next scheduled backup. The existing SQLite
snapshot, integrity, compression, checksum and replication checks include it.
`rollback-backup-config.sh` restores only saved scripts/config/units and timer
state, never DBs, archive trees, accounts or known_hosts.

## Ordered Mac deployment and rollback

**Devon only, after merge and dispatcher build handoff.** Both clean checkouts
must be at the approved commit under `/home/agent/work/factory`; the GPU release
binary must already exist. Verify the host timezone is America/New_York. Preserve
the printed snapshot names from the **first** installer run on each host; later
reruns snapshot the newer state. Stop on every failure. These commands were not run.

Stage non-secret artifacts using agent's filesystem access. Keep the stage paths
in this Mac shell until verification/rollback finishes:

```sh
GPU_STAGE=$(gpu-ssh 'mktemp -d /var/tmp/factory-met-166.XXXXXX')
CONSOLE_STAGE=$(console-ssh 'mktemp -d /var/tmp/factory-met-166.XXXXXX')
gpu-ssh "set -o pipefail; sudo -u agent tar -C /home/agent/work/factory -cf - deploy/ups deploy/backup target/release/factory-ups-control | tar --no-same-owner -xf - -C '$GPU_STAGE'"
console-ssh "set -o pipefail; sudo -u agent tar -C /home/agent/work/factory -cf - deploy/backup | tar --no-same-owner -xf - -C '$CONSOLE_STAGE'"

# 1. Review masked NUT dry-run, then install both users/credential and shutdown mode.
gpu-ssh "sudo bash '$GPU_STAGE/deploy/ups/install-nut.sh' --dry-run"
gpu-ssh "sudo bash '$GPU_STAGE/deploy/ups/install-nut.sh'"

# 2. Install the prebuilt control service (never builds or runs a test).
gpu-ssh 'timedatectl show --property=Timezone --value'
gpu-ssh "sudo bash '$GPU_STAGE/deploy/ups/install-ups-control.sh' '$GPU_STAGE/target/release/factory-ups-control' 0 'DGarbs51@github,metacometdave@github' --dry-run"
gpu-ssh "sudo bash '$GPU_STAGE/deploy/ups/install-ups-control.sh' '$GPU_STAGE/target/release/factory-ups-control' 0 'DGarbs51@github,metacometdave@github'"

# 3. Add only the control mount; preserve the existing dashboard root mount.
gpu-ssh 'sudo tailscale serve --bg --https=443 --set-path /control http://127.0.0.1:8090'

# 4. Update receiver first, then origin; verify all four archived databases.
console-ssh "sudo bash '$CONSOLE_STAGE/deploy/backup/install-backup.sh'"
gpu-ssh "sudo bash '$GPU_STAGE/deploy/backup/install-backup.sh'"
gpu-ssh 'sudo /usr/local/lib/factory-backup/restore-check.sh all'
console-ssh 'sudo /usr/local/lib/factory-backup/restore-check.sh all'
```

Rollback in reverse dependency order. Replace placeholders with printed paths;
do not use “latest” after reruns. Remove only `/control`, never `serve reset` or `/`.
When restoring an earlier control version rather than removing it, restore its
previous matching Serve mount after checks. No database is deleted:

```sh
gpu-ssh "sudo bash '$GPU_STAGE/deploy/backup/rollback-backup-config.sh' /var/backups/backup-config.GPU_SNAPSHOT"
console-ssh "sudo bash '$CONSOLE_STAGE/deploy/backup/rollback-backup-config.sh' /var/backups/backup-config.CONSOLE_SNAPSHOT"
gpu-ssh 'sudo tailscale serve --bg --https=443 --set-path /control off'
gpu-ssh "sudo bash '$GPU_STAGE/deploy/ups/rollback-ups-control.sh' /var/backups/ups-control.CONTROL_SNAPSHOT"
gpu-ssh "sudo bash '$GPU_STAGE/deploy/ups/rollback-nut.sh' /var/backups/nut-NUT_SNAPSHOT"
```

## Devon's manual checks remain necessary

1. From a phone signed into Devon's own tailnet account, GET
   `https://factory-gpu.bearded-pompano.ts.net/control/v1/state`; require
   `login = DGarbs51@github`. Repeat with David's account if available.
2. From tagged factory-console, require 403, even with a forged login header:
   `console-ssh 'curl -i https://factory-gpu.bearded-pompano.ts.net/control/v1/state'`.
3. As agent on GPU, require 403:
   `gpu-ssh 'sudo -u agent curl -i -H "Tailscale-User-Login: DGarbs51@github" http://127.0.0.1:8090/v1/state'`.
4. From the phone, request/confirm `test.quick` with the returned phrase. Require
   tracking SUCCESS, audit `executed=true`, Slack notification, and inspect
   `gpu-ssh 'upsc cyberpower@localhost ups.test.result'` for the battery result.
5. Only while Devon is home, supervise `power.cycle`, confirm
   `power-cycle factory-gpu`, and record total downtime and whether outlets return
   without wall power ever leaving. Check host boot and both factory nodes afterward.
   Do not infer physical safety, return timing or UPS firmware behavior from sandbox FSD.

Local checks: `cargo test -p factory-ups-control`, `python3 -B deploy/ups/test-control.py`,
`python3 -B deploy/ups/test-nut.py`, `python3 -B deploy/backup/test-backup.py`,
and the [sandbox UPS smoke check](sandbox.md). No screenshots or live power actions
are required for development.
