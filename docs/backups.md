# Cross-host SQLite backups (MET-74)

See [off-site backup recommendations and the opt-in R2 prototype](offsite-backups.md) for MET-308.

`deploy/backup/` backs up running services without copying live SQLite files.
Root uses SQLite's `.backup` API (including committed WAL data), requires exactly
`ok` from `PRAGMA integrity_check`, compresses with zstd, and publishes a SHA-256
sidecar. Failed snapshots never become successful status entries. The databases are:

- factory-gpu: `meter`, `/srv/factory/meter/meter.db`; `requests`,
  `/var/lib/factory-api/requests.db`; `pricing`,
  `/var/lib/factory-api/pricing.db`; `ups-control`,
  `/var/lib/factory-ups-control/audit.db`; and `atuin`,
  `/var/lib/atuin/atuin.db`. Follow the [Atuin handoff](agent-host-handoff.md)
  before updating backup configuration. The Atuin DB must exist first.
- factory-console: no originating DBs; receives all five GPU replicas.
  Its retained API DBs and old snapshots are rollback data, never pushed/pruned
  by the receiver-only timer. Its local status becomes `{}`. GPU requests
  replica pruning after successful pushes; all five verified current copies
  are required before retention can delete anything.

Snapshots are `/var/backups/factory-db/<host>/<db>/<UTC-timestamp>.db.zst` with
adjacent `.sha256` files. Local snapshots are root-owned and read-only to the
`factory-backup` group. Only the dedicated, password-locked system user
`factory-backup` runs network operations: `rsync -a --partial -e ssh` over
Tailscale SSH, **never
`--delete`**. Incoming replicas live at `/srv/factory/backups/replica` on
factory-gpu and `/var/backups/factory-replica` on factory-console, under
`<source-host>/<db>/`. Each replica root has mode 0700 and is owned by
`factory-backup`. Its home is `/var/lib/factory-backup`, also owned by it with
mode 0700. The immediate replica parents (`/srv/factory/backups` on factory-gpu,
`/var/backups` on factory-console) are root-owned 0711: traversal without directory
listing. Higher shared ancestors are not changed and must permit traversal.
No sudo permissions or SSH keys are granted; `/bin/sh` supports rsync remote
commands, unlike a `nologin` shell. Ubuntu's built-in `backup` account is never
used for these backups.

Every SSH operation explicitly sets
`-o UserKnownHostsFile=/var/lib/factory-backup/known_hosts`
and `-o StrictHostKeyChecking=accept-new`. No operation depends on `~/.ssh`.
First-use keys are recorded over the trusted tailnet; changed keys still fail.

The oneshot service runs as root at 03:15 on factory-gpu and 03:45 on
factory-console, in each host's local timezone, with `RandomizedDelaySec=10m`
and `Persistent=true`. Filenames and retention dates use UTC. Each DB retains
the newest copy on each of the seven newest available daily dates, plus the
four newest available Sunday copies. Overlap counts once; reruns do not consume
daily slots. The newest copy is never pruned. Any snapshot or push failure
skips all pruning for that run. After a successful push, the receiving host
prunes its own replica as `factory-backup`, then the sender prunes its local tree.
Receiver pruning requires today's complete, checksummed copies for every DB
from that source, so missing/failed days do not trigger deletion. This avoids
depending on whether the peer's staggered timer has already run.

`/var/lib/factory-backup/status.json` is atomically replaced, with a top-level
entry for each local DB: `last_success_ms`, `last_attempt_ms`, `size_bytes`
(compressed), `integrity` (`ok`, `failed`, or null before checking),
`pushed_to_peer` (boolean), and `error` (string or null). A successful run means
snapshot, push and retention finished; failures preserve `last_success_ms`.
Every failure exits nonzero for systemd/journald. The root lock is
`/var/backups/factory-db/.backup.lock`, outside the SSH user's writable home.
On factory-gpu the backup also publishes a copy to
`/var/lib/factory-backup-status/status.json` (`PUBLISHED_STATUS` in
`deploy/backup/nodes.conf`), which factory-api reads for `backup:status`;
factory-console publishes none.
Inspect with:

```sh
sudo cat /var/lib/factory-backup/status.json
systemctl list-timers factory-backup.timer
journalctl -u factory-backup.service
```

## Install on both nodes (Devon; requires MET-73)

Do not run the installer during development. No application service is stopped
or restarted by installation or backups. Origin nodes need their configured databases;
the receiver-only console needs none. Both nodes need
systemd, active tailscaled with Tailscale SSH enabled, SQLite CLI, zstd, rsync,
OpenSSH client, Python 3.11+, and standard Ubuntu coreutils/util-linux/account
tools. Install missing packages as administrator:

```sh
sudo apt-get install sqlite3 zstd rsync openssh-client python3
```

To avoid changing another agent's checkout/branch, fetch and create an isolated
MET-74 checkout on **each node**, as the checkout owner (not root):

GitHub auth is preconfigured for agent (gh + git credential helper); don't set GH_TOKEN or run gh auth commands. If `gh auth status` fails, stop and report.

```sh
git fetch origin
git worktree add --detach /home/agent/work/factory-backup-fix \
  origin/devon/met-74-dedicated-backup-account
cd /home/agent/work/factory-backup-fix
```

After the fix PR is merged, use `origin/main` instead of the feature branch.
Do not run the stale original installer from an older worktree.

**Require the MET-73 Tailscale SSH rule before completing installation.** Devon
must tag both nodes `tag:factory`, enable Tailscale SSH on both, permit TCP 22
between them in the network policy, and add this SSH rule to the existing policy
(do not replace unrelated rules). Use `accept`, not interactive `check`, for
unattended backups:

```json
{
  "action": "accept",
  "src": ["tag:factory"],
  "dst": ["tag:factory"],
  "users": ["factory-backup"]
}
```

First, on **factory-gpu**, from the MET-74 checkout:

```sh
sudo bash deploy/backup/install-backup.sh --prepare-only
```

Then, on **factory-console**, from the same checkout:

```sh
sudo bash deploy/backup/install-backup.sh --prepare-only
```

Preparation migrates the accounts/directories, installs config/units, and checks
real filesystem access as `factory-backup`. It stops the backup service and
disables/stops its timer, including an existing timer, until full installation
passes. No application service is stopped. Once both nodes are prepared
and MET-73 is active, run on **factory-gpu**, then **factory-console**:

```sh
sudo bash deploy/backup/install-backup.sh
```

Each completion run checks peer access using the explicit known_hosts path,
runs an immediate backup through systemd, verifies local restores, then enables
the timer. After both
completion runs, verify local and received copies on **each node**:

```sh
sudo /usr/local/lib/factory-backup/restore-check.sh all
```

The installer is idempotent, preflights dependencies/databases/accounts/paths
and unit overrides, and stops on errors with no automatic rollback. Before any
peer connection or timer enable, it runs `factory-backup.sh --check-access` as
`factory-backup`: actual ancestor traversal, replica read/write access (including
a temporary file), home traversal/write access, and known_hosts read/write.
Normal backups run the same probe before snapshotting to catch permission drift.
Fix the reported failure and rerun. It installs scripts in `/usr/local/lib/factory-backup`
and a single root-owned config at `/etc/factory-backup/nodes.conf`; reinstalling
replaces that config from the checkout. No firewall, Tailscale policy or live DB
is changed. A failed completion leaves the timer disabled; rerun to finish.

## Read-only restore checks and manual recovery

`restore-check.sh [local|replica|all]` (default `all`) verifies the checksum of
the newest copy of every selected DB, decompresses only into a temporary
directory, checks integrity, and prints row counts for every table (including
quoted table names). Missing/corrupt copies fail; it **never replaces live DBs**.
Use `local` during first-node bootstrap before incoming replicas exist.

Manual restoration is an explicit administrator action. Choose a verified copy
from either local snapshots or received replicas and retain its sidecar. For
meter use service/user `meter` and `/srv/factory/meter/meter.db`; for either
API DB use service/user `factory-api` on factory-gpu and its corresponding path above.
Restore requests and pricing together when recovering the API.
Run the following in a root Bash shell, setting the three paths/names first.
`set -e` ensures a bad checksum or integrity result stops before replacement:

```sh
set -euo pipefail
service=meter
database=/srv/factory/meter/meter.db
archive='/var/backups/factory-db/factory-gpu/meter/<UTC-timestamp>.db.zst'
systemctl stop factory-backup.timer factory-backup.service
systemctl stop "$service.service"  # meter only; does not stop Ollama
(cd "$(dirname "$archive")" && sha256sum --strict -c "$(basename "$archive").sha256")
temporary=$(mktemp -d "$(dirname "$database")/.restore.XXXXXX")
zstd -d "$archive" -o "$temporary/verified.db"
test "$(sqlite3 -readonly "$temporary/verified.db" 'PRAGMA integrity_check;')" = ok
chown "$service:$service" "$temporary/verified.db"
chmod 0600 "$temporary/verified.db"
# Keep the old DB and any WAL/SHM together; never replay stale WAL onto a restore.
recovery=/var/backups/factory-db/pre-restore-$(date -u +%Y%m%dT%H%M%S.%NZ)
mkdir -m 0700 "$recovery"
printf 'Pre-restore originals: %s\n' "$recovery"
for file in "$database" "$database-wal" "$database-shm"; do
  if test -e "$file"; then mv -- "$file" "$recovery/"; fi
done
mv -- "$temporary/verified.db" "$database"
rmdir "$temporary"
systemctl start "$service.service"
systemctl start factory-backup.timer
```

Do not restart the application between replacing requests and pricing when
restoring both. Before starting the current factory-api binary, requests.db must
be v4 and pricing.db v1. An older requests backup requires a fresh verified
snapshot and `factory-api migrate --requests-db /var/lib/factory-api/requests.db`
as the service user while stopped; never relabel `user_version` manually. A v4
restore needs no migration. Check its health endpoint and replay coverage before
declaring recovery complete.
If any step fails, keep services stopped until the paths/error are reviewed;
the originals remain at the printed/selected recovery location.

## Backup development checks (no root)

```sh
python3 -B deploy/backup/test-backup.py
for script in deploy/backup/*.sh deploy/backup/nodes.conf; do bash -n "$script"; done
shellcheck -x deploy/backup/*.sh deploy/backup/nodes.conf
```

The contract check runs the real scripts with local rsync, three sample WAL
databases and active writers. It verifies transaction consistency, integrity,
compression, checksums, exact survivors of 40 dated copies on both trees,
same-day reruns, Sunday retention, status, read-only restore output, and no
deletion on missing/corrupt DBs, failed pushes, or incomplete incoming copies.
It also exercises kernel-enforced traversal/write failures, rejects unsafe
known_hosts links, and checks repeatable migration on both node configurations
with both legacy and already-restored Ubuntu accounts. Account administration
and uid/gid changes are modelled without root; directory modes, key migration,
access probes and data preservation are checked against the real filesystem.
Development overrides are `BACKUP_HOST`, `BACKUP_HOME`, `METER_DB`, `REQUESTS_DB`,
`PRICING_DB`, `LOCAL_ROOT`, `REPLICA_ROOT`, `PEER_REPLICA_ROOT`, `STATUS_FILE`, and
`BACKUP_TRANSPORT=local`. `BACKUP_CONFIG` selects a trusted alternative config.
The installer clears development overrides and always uses real node defaults.
These unprivileged checks do not prove production Tailscale SSH/root permissions;
the administrator's immediate systemd backup and restore checks do that.
