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

`rollback-alerts.sh --node <node>` removes what the installer added. On factory-gpu
it removes the drop-in and restarts factory-api before deleting the token. On
the console it disables and removes the timer, service, script and state. The API's
`alerts.json` stays; without a token the engine only logs.

From the Mac, after the MET-150 factory-api binary is deployed (factory-gpu first):

```sh
op read 'op://Factory/Factory Alerts Slack bot token/credential' | factory-ssh 'sudo bash /home/agent/work/factory/deploy/alerts/install-alerts.sh --node factory-gpu'
op read 'op://Factory/Factory Alerts Slack bot token/credential' | console-ssh 'sudo bash /home/agent/work/factory/deploy/alerts/install-alerts.sh --node factory-console'
factory-ssh 'sudo bash /home/agent/work/factory/deploy/alerts/install-alerts.sh --node factory-gpu --test-alert'
```

Rollback:

```sh
console-ssh 'sudo bash /home/agent/work/factory/deploy/alerts/rollback-alerts.sh --node factory-console'
factory-ssh 'sudo bash /home/agent/work/factory/deploy/alerts/rollback-alerts.sh --node factory-gpu'
```

## Tests and sandbox check

- `cargo test -p factory-api --lib alerts` covers the engine with a fake clock and
  fake Slack server: open, debounce, threaded recovery, restart, missing token,
  unavailable source, retries and every signal rule.
- `python3 -B deploy/alerts/test-watchdog.py` checks the watchdog against a fake
  health endpoint and a fake Slack server.
- `python3 -B deploy/alerts/test-install.py` checks both installers and rollback
  against a fake root.

`scripts/sandbox up` starts a namespace-local fake Slack
(`scripts/sandbox-shims/fake-slack.py`) with a synthetic token. It records each
payload in `.sandbox/slack-posts.jsonl`. To force an alert, pause the fake Ollama
(`kill -STOP <host pid of target/release/fake-ollama>`). Killing it would stop the
whole sandbox. The `fake-ollama` service alert opens after three failed fleet
checks. Resume it with `kill -CONT` to get the threaded recovery. Compare
`GET /v1/alerts` before and after.
