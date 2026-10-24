# Factory alerts

Factory problems post to Slack `#factory-alerts` (`C0C9N9HCRG8`) as the
`factoryalerts` bot (scope `chat:write`). Decisions are in MET-76. MET-253 changes
message presentation and recovery delivery, not alert rules, database schemas,
or Slack scopes.

- **factory-api** on factory-gpu evaluates every 30 s and posts one message per
  alert key when it opens. When it clears, a recovery reply goes in the thread
  of the original message (`thread_ts`), and the parent is updated to resolved.
  Nothing is reposted while an alert is open.
- **factory-watchdog** on factory-console checks
  `https://factory-gpu.bearded-pompano.ts.net/v1/health` every 60 s, because
  factory-api cannot report its own node going down.
- `GET /v1/alerts` lists active alerts and the last 20 cleared ones, so the kiosk
  can show them too.

## Shared Slack Block Kit contract (MET-253)

Factory-api alerts, the console watchdog, and UPS control audit notifications
use this contract. The top-level `text` is an emoji and a short title, with no
URL, for notifications and accessibility. The unclean-shutdown fallback is the
exact transition text [below](#unclean-shutdown-notice-met-217), without an emoji.
Every payload disables both `unfurl_links` and `unfurl_media`.

| Style | Attachment color | Fallback emoji |
| --- | --- | --- |
| Critical | `#ff6a4f` | `:rotating_light:` / 🚨 |
| Warning | `#ffd447` | `:warning:` / ⚠️ |
| Resolved | `#7ee081` | `:white_check_mark:` / ✅ |
| Neutral | `#728894` | `:information_source:` / ℹ️ |

Except for pricing info messages, each payload has exactly one colored
attachment. Its blocks appear in this order:

1. One `section` with a bold `mrkdwn` title, without the fallback emoji.
2. An optional `section.fields` array with at most 10 entries. Each entry is one
   bold label followed by a newline and one value, not a paragraph of metrics.
3. One `context` block with `node · alert key or audit ID · Slack date · page link`.

Dynamic text escapes `&`, `<`, and `>` as `&amp;`, `&lt;`, and `&gt;` before it
enters `mrkdwn`. Every text object sets `verbatim: true` to prevent Slack from
automatically turning raw URLs or mentions in those values into links or pings.
Explicit dashboard links and dates still render. Slack dates use Unix **seconds**,
not stored milliseconds:
`<!date^<seconds>^{date_short_pretty} {time}|<YYYY-MM-DD HH:MM:SS UTC>>`.
Slack localizes the displayed time; the fallback explicitly names UTC.

Page links use `https://factory-gpu.bearded-pompano.ts.net` with these paths:

| Message | Path |
| --- | --- |
| Node, GPU temperature, or unclean shutdown | `/devices/<node>` |
| Console watchdog | `/devices/factory-gpu` |
| Network | `/network` |
| UPS alert or UPS control audit | `/ups` |
| Meter sync or pricing | `/llm` |
| All others, including service alerts | `/` |

Pricing info uses a single top-level `context` block with the info emoji, title,
details, and LLM page link, with no attachment. Confirmation updates that same
message to `Confirmed: <title>` and sends no thread reply.

### Recovery messages

For a cleared non-info alert, the recovery reply uses the resolved style and
`Resolved after <duration>: <title>`. Its fields contain recovery-only facts,
such as UPS minimum charge and runtime, rather than repeating the opening
fields. Its context uses the recovery time. The parent update uses
`Resolved: <title>`, retains the original fields and opening time, and appends
`resolved after <duration>` to the context. Both use the same page route.

The reply (`chat.postMessage` with `thread_ts`) and parent update (`chat.update`
with `ts`) are separate persisted deliveries. A failed update does not replay
an accepted reply. The [state rules](#state-and-configuration) describe retries.
UPS control audit notifications are one-shot audit messages, not this recovery
lifecycle; their [severity mapping](ups.md#ups-control-slack-severity) follows
the recorded outcome.

Rendered Slack appearance remains unverified until Devon runs the approved
test in `#factory-alerts`. Payload tests do not prove Slack's rendered layout.

## Alerts

| Key | Opens when | Severity | Source |
| --- | --- | --- | --- |
| `node:<name>` | Tailscale reports the node offline for 5 min | critical | fleet collector (`tailscale status`) |
| `service:<node>/<service>` | the service fails 3 consecutive fleet checks (> 2) | warning | fleet collector |
| `gpu:temperature` | GPU 0 is above 85 °C for 2 min | critical | meter `/meter/gpu` sample (15 s) |
| `meter:sync` | no successful meter sync for 5 min (10 cycles) | warning | factory-api meter sync |
| `pricing:<family>:<model>` | `pricing.changed`: a new reference model is pending | info | pricing DB |
| `backup:status` | a MET-74 backup failed, a pending marker is stuck for 2 h, or the last success is older than 36 h | warning | `/var/lib/factory-backup-status/status.json` |
| `clock:ntp` | `timedatectl show -p NTPSynchronized --value` is `no` | warning | timedatectl |
| `dispatch:timer` | `factory-dispatch.timer` last fired more than 5 min ago, or never | warning | `systemctl show --timestamp=unix -p LastTriggerUSec` |
| `usage:stale` | a collected tool's `observed_at_ms` is older than 45 min (3 collector intervals) | warning | `/var/lib/factory-usage/usage.json` |
| `network:lan_down` | the open network event is `Down { lan }` and started 2 min or more ago; clears when that event closes or changes | critical | `net_events` (network collector, 30 s) |
| `network:wan_down` | the same for `Down { wan }`, an ISP outage | critical | `net_events` |
| `network:dns_down` | the same for `Down { dns }` | critical | `net_events` |
| `network:throughput_low` | the 3 most recent `ok` speed tests are all below `--network-throughput-low-mbps` (500 Mb/s) in either direction, skipping failed and timed-out tests between them; clears when the newest `ok` test is at or above it both ways | warning | `net_speed_tests` |
| `network:speedtest_failing` | the 3 most recent speed tests all failed or timed out; clears on the next `ok` test | warning | `net_speed_tests` |
| `retention:api`, `retention:meter` | 365-day request retention has skipped or failed for 24 h (`skipped_since_ms`); clears on a run that is allowed to prune | warning | API `/v1/health` `retention`; meter `/meter/health` `maintenance.retention` |
| watchdog | factory-gpu health fails 5 consecutive minutes | critical | factory-console |

### Unclean shutdown notice (MET-217)

Each drive's first `unsafe_shutdowns` observation records a baseline without
posting. A later increase queues one top-level message in `#factory-alerts`:

```text
factory-gpu: unclean shutdown recorded on <drive> (N → M)
```

That exact string remains the top-level fallback `text`. The attachment uses
the warning layout and links to `/devices/factory-gpu`. This one-shot notice
has no parent update and no thread reply.

`<drive>` is the existing stable drive ID, preferring WWN or serial over the
kernel name. Baselines and queued notices share `alerts.json`, so a normal
factory-api restart does not post the same increase again. A lower counter
resets that drive's baseline without posting. Missing counters leave baselines
unchanged. A replacement with a new ID gets a new baseline.

This notice has no recovery, does not become an active health condition, and
does not duplicate SMART failure, spare, or media-error alerts. No update,
service, or maintenance-freshness alerts are added.

The condition stays open until it is actually gone. A node offline for 3 min after
a restart, or a service with only one failed check after a restart, therefore
**keeps** an existing alert open rather than clearing it. Services on a node that
Tailscale reports offline are covered by the node alert. Info alerts (pricing)
clear with a `Confirmed:` parent update and no recovery reply once the pending
selection is confirmed.

Network alerts follow `net_events` and `net_speed_tests` (docs/network.md). The
2 minutes count from the stored event's start, not from an engine timer. A down
event younger than 2 min holds a down alert that is already open. A factory-api
restart during an outage closes the event as `restart`, and the first tick after
it is only degraded by loss, so the down alert clears and opens again 2 min after
the next down tick. A newest `ok` test that is still slow, or a newest test that
still failed, holds its open alert. A tailnet outage has no alert in v1.

Production note: the one manual production test measured 404 Mb/s upload against the 500 Mb/s default, so throughput_low will open unless the threshold is set at deploy.

**Unavailable sources.** A source that cannot be read (missing file, permission
denied, `tailscale status` failing, a stale GPU sample, a timer that is not
installed) is logged once as `alert source unavailable` and never alerts. Its
open alerts are held until it is readable again, then they clear normally.

**Known gap: backup status is root-only today.** `backup-state.py` writes
`status.json` 0600 inside the 0700 `/var/lib/factory-backup`, so in production
factory-api logs the backup source as unavailable. Making the file readable by
`factory-api` belongs to the MET-74 backup scripts: MET-152.

## State and configuration

State lives in `/var/lib/factory-api/alerts.json` (0600, written atomically with
fsync + rename, in the service's `StateDirectory`). It holds open alerts with
their Slack `ts`, the last 20 cleared alerts, per-drive unsafe-shutdown baselines,
and pending recovery replies, parent updates, and shutdown notices.
It is not in SQLite (the cache DB is due for its MET-92
rebuild). An unreadable file is moved aside as `alerts.json.corrupt-<ms>`.

Recovery replies and parent updates retry independently, starting at 30 s and
doubling to a 15 min cap, with at most 12 attempts per delivery. The engine
attempts due replies before parent updates. The watchdog uses the same policy;
its timer checks due retries once per minute. Openings and shutdown notices keep retrying.
Every Slack result is saved before the next network request, so an accepted
reply is not replayed when an update fails or the process restarts.
If the state file cannot be written, delivery pauses until it can be saved;
alert evaluation and `GET /v1/alerts` continue. This also prevents a failed
acknowledgement write from allowing another Slack request in the same tick.

Existing `alerts.json` and watchdog state remain readable, including old queued
messages. MET-253 does not change SQLite schemas or the ambiguous acceptance
window: a Slack timeout, or a crash after Slack accepts a post but before its
acknowledgement is saved, can still cause a duplicate. Local state and Slack do
not share a transaction.
Pending condition timers (5 min offline, 2 min hot) and
consecutive-failure counts restart with the process.

| Setting | Default |
| --- | --- |
| `$CREDENTIALS_DIRECTORY/slack-bot-token` | absent: alerts are evaluated and logged, never posted |
| `FACTORY_ALERTS_CHANNEL` / `--alerts-channel` | `C0C9N9HCRG8` |
| `FACTORY_ALERTS_SLACK_URL` / `--alerts-slack-url` | `https://slack.com/api` |
| `FACTORY_API_ALERTS_STATE` / `--alerts-state` | `/var/lib/factory-api/alerts.json` |
| `FACTORY_API_BACKUP_STATUS` / `--backup-status` | `/var/lib/factory-backup-status/status.json` |
| `FACTORY_API_NETWORK_THROUGHPUT_LOW_MBPS` / `--network-throughput-low-mbps` | `500` (1 to 100000) |

The token is never logged. Startup logs only `alerts: Slack token loaded; posting
enabled` or `alerts: Slack token absent; ...`.

The watchdog reads the same credential name and `FACTORY_ALERTS_CHANNEL` /
`FACTORY_ALERTS_SLACK_URL`, plus `FACTORY_WATCHDOG_HEALTH_URL`,
`FACTORY_WATCHDOG_STATE` (`/var/lib/factory-watchdog/state.json`) and
`FACTORY_WATCHDOG_THRESHOLD` (5). It does not count a failure while
factory-console's own clock is unsynchronized, because TLS then fails for
reasons unrelated to factory-gpu (MET-99).

## Install

The installers take the bot token **on stdin only** and store it as
`/etc/factory-alerts/slack-token` (root, 0600):

- `--node factory-gpu` adds
  `/etc/systemd/system/factory-api.service.d/50-factory-alerts.conf`
  (`LoadCredential=slack-bot-token:/etc/factory-alerts/slack-token`). It restarts
  factory-api only if the token or drop-in changed, then checks health and the
  `Slack token loaded` log line. The installed factory-api must already include
  MET-150. `install-factory-api.sh` and `rollback-factory-api.sh` accept this
  one drop-in, but only when it matches the repository copy.
- `--node factory-console` installs `factory-watchdog.py` in
  `/usr/local/lib/factory-alerts`, plus `factory-watchdog.service` (`DynamicUser`,
  `LoadCredential`) and `.timer`. It enables the timer and runs one check. A
  token change needs no restart.
- `--test-alert` (no stdin) posts one live test message, a resolved threaded
  reply, and a resolved parent update from that node through a transient unit
  using the same credential.

**Snapshots and restore.** Before changing anything, each install run saves a
root-only snapshot in `/var/backups/factory-alerts/<UTC time>.XXXXXX` (0700). It
holds the previous token copy (0600), the previous drop-in or watchdog files (or
markers that they were absent), and the previous factory-api or timer state. The
installer prints the snapshot path. If a later step fails, such as factory-api
not reporting the token as loaded or the first watchdog run failing, the
installer restores that snapshot automatically: the previous working token,
files and service state. A rerun that changes nothing takes no snapshot.
Snapshots are kept until removed by hand, and each one holds a copy of the token.

`rollback-alerts.sh --node <node> <snapshot>` restores the state saved before that
run. Rolling back a first-install snapshot, or running without a snapshot, removes
everything the installer adds. On factory-gpu, removal deletes the drop-in, then
the token, and restarts factory-api if it is running. On the console, removal
disables and removes the timer, service, script and state. The API's
`alerts.json` stays; without a token the engine only logs.

### Deploy MET-253 from Devon's Mac

Run these commands only after merge, approval, and the dispatcher build handoff.
Both clean `/home/agent/work/factory` checkouts must be at the approved commit.
The GPU must already have approved release binaries for `factory-api` and
`factory-ups-control` in `target/release`. This procedure assumes NUT, UPS
control, the `/control` Serve mount, and backups are already installed. It does
not change NUT, Serve, backup configuration, database schemas, or Slack scopes.
These commands have not been run for MET-253.

Stop on every failure. Keep the first printed snapshot path from each changed
component; reruns snapshot the newer state. Keep `GPU_STAGE` in the Mac shell
until verification and any rollback finish.

The administrator cannot traverse `/home/agent`. Copy the UPS artifacts as
agent into `/var/tmp`, as in the [UPS deployment procedure](ups.md#ordered-mac-deployment-and-rollback).
Run the API installer as root at its original path: it verifies the binary's
build SHA against the clean checkout as agent, so a staged copy without Git
metadata is not sufficient. Root can read the alerts scripts at their original
paths too. No command relies on the administrator reading those files directly.

```sh
set -o pipefail
GPU_STAGE=$(gpu-ssh 'mktemp -d /var/tmp/factory-met-253.XXXXXX')
gpu-ssh "set -o pipefail; sudo -u agent tar -C /home/agent/work/factory -cf - deploy/ups target/release/factory-ups-control | tar --no-same-owner -xf - -C '$GPU_STAGE'"

# 1. Check and install the approved API binary, preserving the alert credential drop-in.
gpu-ssh 'sudo -n bash /home/agent/work/factory/deploy/install-factory-api.sh /home/agent/work/factory/target/release/factory-api --check-only'
gpu-ssh 'sudo -n bash /home/agent/work/factory/deploy/install-factory-api.sh /home/agent/work/factory/target/release/factory-api'

# 2. Reconcile the GPU credential, then install the console watchdog.
op read 'op://Factory/Factory Alerts Slack bot token/credential' | ssh -T "$FACTORY_USER@$FACTORY_GPU" 'sudo -n bash /home/agent/work/factory/deploy/alerts/install-alerts.sh --node factory-gpu'
op read 'op://Factory/Factory Alerts Slack bot token/credential' | ssh -T "$FACTORY_USER@$FACTORY_CONSOLE" 'sudo -n bash /home/agent/work/factory/deploy/alerts/install-alerts.sh --node factory-console'

# 3. Check and install the approved UPS control binary. No UPS action is run.
gpu-ssh "sudo -n bash '$GPU_STAGE/deploy/ups/install-ups-control.sh' '$GPU_STAGE/target/release/factory-ups-control' 0 'DGarbs51@github,metacometdave@github' --dry-run"
gpu-ssh "sudo -n bash '$GPU_STAGE/deploy/ups/install-ups-control.sh' '$GPU_STAGE/target/release/factory-ups-control' 0 'DGarbs51@github,metacometdave@github'"

# 4. Post the approved live layout test and inspect #factory-alerts.
gpu-ssh 'sudo -n bash /home/agent/work/factory/deploy/alerts/install-alerts.sh --node factory-gpu --test-alert'
```

The token pipes over plain `ssh -T`, a byte stream with no PTY. Do not pipe it
through `gpu-ssh` or `console-ssh`: those helpers run `_factory_ready` first,
which can print or fail. `sudo -n` refuses to prompt while stdin carries the
token. Do not put the token in argv, an environment variable, or a staging file.

Devon must inspect the resolved parent, the single threaded reply, colors,
field layout, localized date, fallback text, and dashboard link. The test exercises
factory-api's formatter, not every real alert or UPS audit outcome. The console
installer runs one health check; it does not force an outage.

### Roll back MET-253 from Devon's Mac

Replace the uppercase snapshot placeholders with the exact paths printed by
the matching install run. Roll back only components that changed. The GPU
alerts installer can report no change and produce no snapshot; skip that
rollback in that case. Never omit the alerts snapshot argument during an
upgrade rollback, because omission removes the credential used by UPS control.

```sh
gpu-ssh "sudo -n bash '$GPU_STAGE/deploy/ups/rollback-ups-control.sh' /var/backups/ups-control.CONTROL_SNAPSHOT"
console-ssh 'sudo -n bash /home/agent/work/factory/deploy/alerts/rollback-alerts.sh --node factory-console /var/backups/factory-alerts/CONSOLE_ALERTS_SNAPSHOT'
gpu-ssh 'sudo -n bash /home/agent/work/factory/deploy/alerts/rollback-alerts.sh --node factory-gpu /var/backups/factory-alerts/GPU_ALERTS_SNAPSHOT'
gpu-ssh 'sudo -n bash /home/agent/work/factory/deploy/rollback-factory-api.sh /var/backups/factory-api/API_SNAPSHOT'
```

These rollback commands restore binaries, scripts, credentials, and service
state from their snapshots. They do not remove the existing `/control` mount,
UPS audit database, or API alert state. They do not undo Slack messages already
accepted. With current database schemas, MET-253 needs no database downgrade.

## Tests and sandbox check

- `cargo test -p factory-api --lib alerts` covers the engine with a fake clock and
  a fake Slack server. It checks:
  - open, debounce and threaded recovery;
  - restart, missing token, unavailable source and retries;
  - every signal rule;
  - interrupted deliveries. One post is acknowledged and the next hangs, then the
    engine is aborted and restarted. The acknowledged opening or recovery is never
    reposted, and later recoveries still thread under the original `ts`. Each
    Slack result is persisted before the next network call.
- `cargo test -p factory-api --test deploy_alerts` runs
  `deploy/alerts/test-watchdog.py` and `deploy/alerts/test-install.py`. The first
  checks the watchdog against a fake health endpoint and a fake Slack server. The
  second checks the installers, snapshots, failed-update restore and rollback
  against a fake root, with synthetic tokens.

`scripts/sandbox` has no Slack hook. There factory-api runs without a token, so
alerts are evaluated and logged but never posted. To see payloads, give a local
sandbox run a namespace-local fake Slack. That means a synthetic
`CREDENTIALS_DIRECTORY` token plus `FACTORY_ALERTS_SLACK_URL` on the factory-api
command in `scripts/sandbox-shims/runtime.py`, as a temporary change you do not
commit. To force an alert, pause the fake Ollama with
`kill -STOP <host pid of target/release/fake-ollama>`. Killing it would stop the
whole sandbox. The `fake-ollama` service alert opens after three failed fleet
checks. Resume it with `kill -CONT` to get the threaded recovery, and compare
`GET /v1/alerts` before and after.
