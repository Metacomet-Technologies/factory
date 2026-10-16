# Factory alerts (MET-150)

Factory problems post to Slack `#factory-alerts` (`C0C9N9HCRG8`) as the
`factoryalerts` bot (scope `chat:write`). Decisions are in MET-76.

- **factory-api** on factory-gpu evaluates every 30 s and posts one message per
  alert key when it opens. When it clears, a recovery reply goes in the thread
  of the original message (`thread_ts`). Nothing is reposted while an alert is open.
- **factory-watchdog** on factory-console checks
  `https://factory-gpu.bearded-pompano.ts.net/v1/health` every 60 s, because
  factory-api cannot report its own node going down.
- `GET /v1/alerts` lists active alerts and the last 20 cleared ones, so the kiosk
  can show them too.

Each message is one line followed by the dashboard link
`https://factory-gpu.bearded-pompano.ts.net`.

## Alerts

| Key | Opens when | Severity | Source |
| --- | --- | --- | --- |
| `node:<name>` | Tailscale reports the node offline for 5 min | critical | fleet collector (`tailscale status`) |
| `service:<node>/<service>` | the service fails 3 consecutive fleet checks (> 2) | warning | fleet collector |
| `gpu:temperature` | GPU 0 is above 85 °C for 2 min | critical | meter `/meter/gpu` sample (15 s) |
| `meter:sync` | no successful meter sync for 5 min (10 cycles) | warning | factory-api meter sync |
| `pricing:<family>:<model>` | `pricing.changed`: a new reference model is pending | info | pricing DB |
| `backup:status` | a MET-74 backup failed, a pending marker is stuck for 2 h, or the last success is older than 36 h | warning | `/var/lib/factory-backup/status.json` |
| `clock:ntp` | `timedatectl show -p NTPSynchronized --value` is `no` | warning | timedatectl |
| `dispatch:timer` | `factory-dispatch.timer` last fired more than 5 min ago, or never | warning | `systemctl show --timestamp=unix -p LastTriggerUSec` |
| `usage:stale` | a collected tool's `observed_at_ms` is older than 45 min (3 collector intervals) | warning | `/var/lib/factory-usage/usage.json` |
| watchdog | factory-gpu health fails 5 consecutive minutes | — | factory-console |

The condition stays open until it is actually gone. A node offline for 3 min after
a restart, or a service with only one failed check after a restart, therefore
**keeps** an existing alert open rather than clearing it. Services on a node that
Tailscale reports offline are covered by the node alert. Info alerts (pricing)
clear without a recovery message once the pending selection is confirmed.

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
their Slack `ts`, the last 20 cleared alerts and any recovery replies not yet
accepted by Slack. It is not in SQLite (the cache DB is due for its MET-92
rebuild). An unreadable file is moved aside as `alerts.json.corrupt-<ms>`.

Failed posts retry with backoff (30 s doubling to 15 min); recovery replies give
up after 12 attempts. Pending condition timers (5 min offline, 2 min hot) and
consecutive-failure counts restart with the process.

| Setting | Default |
| --- | --- |
| `$CREDENTIALS_DIRECTORY/slack-bot-token` | absent: alerts are evaluated and logged, never posted |
| `FACTORY_ALERTS_CHANNEL` / `--alerts-channel` | `C0C9N9HCRG8` |
| `FACTORY_ALERTS_SLACK_URL` / `--alerts-slack-url` | `https://slack.com/api` |
| `FACTORY_API_ALERTS_STATE` / `--alerts-state` | `/var/lib/factory-api/alerts.json` |
| `FACTORY_API_BACKUP_STATUS` / `--backup-status` | `/var/lib/factory-backup/status.json` |

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
- `--test-alert` (no stdin) posts one live test message and a threaded reply from
  that node through a transient unit using the same credential.

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

From the Mac, after the MET-150 factory-api binary is deployed, install
factory-gpu, then factory-console, then run the test alert. The token pipes over
plain `ssh` (a byte stream with no PTY). The `gpu-ssh` and `console-ssh`
helpers run `_factory_ready` first, which can print or fail (see the PLAYBOOK).
`sudo` must not prompt, because stdin carries the token.

```sh
op read 'op://Factory/Factory Alerts Slack bot token/credential' | ssh "$FACTORY_USER@$FACTORY_GPU" 'sudo bash /home/agent/work/factory/deploy/alerts/install-alerts.sh --node factory-gpu'
op read 'op://Factory/Factory Alerts Slack bot token/credential' | ssh "$FACTORY_USER@$FACTORY_CONSOLE" 'sudo bash /home/agent/work/factory/deploy/alerts/install-alerts.sh --node factory-console'
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/alerts/install-alerts.sh --node factory-gpu --test-alert'
```

Rollback: pass the snapshot path the installer printed to undo that run, or no
path to remove everything. Console first:

```sh
console-ssh 'sudo bash /home/agent/work/factory/deploy/alerts/rollback-alerts.sh --node factory-console /var/backups/factory-alerts/<printed-console-snapshot>'
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/alerts/rollback-alerts.sh --node factory-gpu /var/backups/factory-alerts/<printed-gpu-snapshot>'
# Full removal instead:
console-ssh 'sudo bash /home/agent/work/factory/deploy/alerts/rollback-alerts.sh --node factory-console'
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/alerts/rollback-alerts.sh --node factory-gpu'
```

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
