# Off-site SQLite backups (MET-334)

R2 backups remain disabled by default until Devon runs the activation runbook.
The MET-308 prototype tests used synthetic SQLite data, disposable credentials,
and moto on loopback on factory-gpu. Those results do not establish a live R2
backup or production restore. This document records the approved rollout model,
not a claim that activation has happened.

## Recommendation per database

Use the existing verified snapshots first. The two hosts share a house and
power supply; cross-host replication does not protect against whole-house loss.
The following RPOs are **approved data-loss budgets**, not measured
SLAs. A daily backup gives roughly 24 hours of loss between successful runs.
The 03:15 host-local schedule adds up to ten minutes of jitter, snapshot/upload
time, and a possible 25-hour interval at the DST transition. Failures extend
the recovery-point age until another upload succeeds. The approved maximum
recovery-point age is **26 hours** for each active daily database, including
that schedule margin. Both local freshness and off-site recovery-point alerts
use this threshold. A stricter accepted RPO requires a shorter backup interval
or a separately evaluated Litestream deployment.

| Name | Host | Path | Covered today | System of record | RPO | Mechanism | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| meter | factory-gpu | `/srv/factory/meter/meter.db` | yes | yes: original request facts, GPU history and rollups | 26 h; daily snapshots | snapshot-to-R2 | Historical observations cannot be recollected, but the approved disaster budget allows up to 26 hours of loss. |
| requests | factory-gpu | `/var/lib/factory-api/requests.db` | yes | yes: frozen costs, aggregates, UPS/device/network histories and settings; not just a meter cache | 26 h; daily snapshots | snapshot-to-R2 | Explicitly accept losing up to 26 hours of cost/operational history after whole-house loss. No current requirement establishes a minutes-level billing ledger. |
| pricing | factory-gpu | `/var/lib/factory-api/pricing.db` | yes | yes: historical prices and operator selections | 26 h; daily snapshots | snapshot-to-R2 | Refetching current prices cannot restore old rates or confirmations. Preserve the DB even though writes are infrequent. |
| ups-control | factory-gpu | `/var/lib/factory-ups-control/audit.db` | yes | yes: action audit, confirmations, cooldowns and notification state | 26 h for history; daily snapshots | snapshot-to-R2 | Restore with control disabled and reconcile physical actions first. A fresher asynchronous copy alone cannot make physical-action replay safe. |
| dispatch | factory-gpu | `/home/agent/.local/state/factory-dispatch/dispatch.db` | no; separate later ticket | yes: local claims, decisions, thread and QA/recovery state | 26 h target; manual reconciliation before restart | snapshot-to-R2 | Linear/GitHub are reconciliation inputs, not a complete copy of the decision ledger. Not part of this activation. |
| atuin | factory-gpu, conditional on activation | `/var/lib/atuin/atuin.db` | yes in config; skipped if not created | no for history, assuming clients retain full encrypted history; yes for account/sync metadata | 26 h for server state; daily snapshots | snapshot-to-R2 | Cheap server recovery; no continuous replication needed for a client-encrypted sync hub. Client retention is an assumption to confirm in the drill. |
| meter-v0 | factory-gpu | `/var/backups/factory-db/factory-gpu/meter-v0/` | no; separate later ticket, outside `DBS`, pruning and restore checks | yes: immutable historical archive | zero further loss after a verified one-time copy | snapshot-to-R2 | Upload every approved archive generation once, keep indefinitely, and include in restore drills after that import. |

The live inventory comes from [nodes.conf](../deploy/backup/nodes.conf), not
the older issue's four-database list. Source evidence for the loss budget:
[meter schema](../meter/src/v1.sql), [retention and rollups](data-model.md),
[frozen costs](../factory-api/src/costs.rs),
[UPS](../factory-api/src/ups_schema.sql),
[devices](../factory-api/src/devices_schema.sql),
[network](../factory-api/src/network_schema.sql),
[pricing history](../pricing/src/v1.sql),
[UPS control safety state](ups.md), and the
[dispatch ledger](../scripts/dispatch/README.md).

**Requests RPO decision:** Devon approved the 26-hour budget. This does not mean
that the data is reconstructible. Meter replay cannot restore
co-resident telemetry or every historical cost decision, and both source and
API copies disappear in a house loss. If requests becomes authoritative for
customer invoicing or its loss budget becomes 15 minutes, choose Litestream
for requests and separately reassess meter/pricing consistency. None of the
current evidence justifies operating continuous replication for every DB.
No database is recommended as `none`; no Litestream daemon is part of this PR.

The later dispatch ticket adds `dispatch` to GPU `DBS` and console `PEER_DBS`.
Root's SQLite `.backup` can read the `agent`-owned WAL database outside `/var/lib`; preserve
its ownership and modes, do not copy the live DB/WAL files or widen permissions.
Test a live WAL writer and an absent required dispatch DB before dispatch activation.
Keep the dispatcher disabled after restore until claims and in-flight work
are reconciled with Linear/GitHub. This prototype does not change `DBS`.

In the later `meter-v0` ticket, inventory and validate the existing pairs under
separate approval. Verify checksums, decompress in scratch, and require SQLite integrity
before the first upload. Use `offsite.py push --archive` with each exact stamp.
If an archive lacks a sidecar, record a newly verified baseline explicitly;
do not pretend a new checksum proves historical authenticity. Do not add the
immutable archive to daily pruning or take recurring snapshots of it.

## Bucket layout, retention and cost

Devon has created the private bucket **`factory-sqlite-backups`**. Use Standard
storage. The planned `enam` location hint is not a residency
guarantee ([data location](https://developers.cloudflare.com/r2/reference/data-location/)).
The S3 region is **`auto`**, endpoint
`https://25c7d5cf9a2dbcd9238a95f54cfeedff.r2.cloudflarestorage.com`
([S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)).
Do not enable an r2.dev URL or public custom domain.

```text
v1/daily/factory-gpu/<db>/<UTC-stamp>.tar.age
v1/daily/factory-gpu/<db>/<UTC-stamp>.tar.age.sha256
v1/archive/factory-gpu/meter-v0/<UTC-stamp>.tar.age
v1/archive/factory-gpu/meter-v0/<UTC-stamp>.tar.age.sha256
```

The encrypted tar contains exactly `<host>/<db>/<stamp>.db.zst` and its
original `.sha256`. The identity inside the authenticated payload prevents
swapping different DBs from the same run. The outside sidecar checks ciphertext.
It is uploaded last; an object without its sidecar is not a restore point.
No mutable `latest` object, remote delete, bucket creation, or LIST/GET request
is needed by the uploader. The operator lists complete pairs during recovery.
PUTs use `If-None-Match: *` to refuse accidental replacement even in the local
test bucket. R2 evaluates that condition atomically
([conditional PUT](https://developers.cloudflare.com/r2/api/s3/api/)); it is
not a substitute for a lock against a malicious client that omits the header.

The optional step runs **after all local snapshots pass verification, peer
replication succeeds, both retention passes finish, and local status succeeds**.
It copies and rechecks the exact current generation in private scratch, encrypts
all selected DBs, then uploads. Existing snapshot or peer failures still stop
network work/pruning as before. R2 failure does not roll back or block local
backup, replication, or retention. Local exit remains zero; `r2.error` reports
the independent failure. Each run uploads only its current generation, so a
later success does not backfill missed days. Manual re-upload must use a fresh
generation because locks reject overwriting previously uploaded objects.

Devon has already created these rules. Do not recreate them during activation:

- Lifecycle `expire-daily-35d`: prefix `v1/daily/`, `Expiration.Days = 35`.
- Cloudflare's built-in **Default Multipart Abort Rule** aborts incomplete
  multipart uploads after 7 days across the whole bucket. It replaces the
  proposed `abort-incomplete-1d` rule.
- No expiry or storage-class transition for `v1/archive/`.
- Bucket lock `lock-daily-35d`: prefix `v1/daily/`, condition
  `{"type":"Age","maxAgeSeconds":3024000}`.
- Bucket lock `lock-archive`: prefix `v1/archive/`, condition `{"type":"Indefinite"}`.

R2 expiry is age-based, not the local **7 daily + 4 weekly** selection. Keeping
35 daily generations provides finer recovery choices than the local policy.
[Lifecycle deletion](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
typically occurs within 24 hours of expiry, not at a guaranteed exact time.
[Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
block deletion and overwriting, including lifecycle deletion while locked.
They protect against a compromised upload credential, not an administrator
who can remove the lock. Do not rely on S3 versioning: it is not implemented
in the [R2 S3 compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/).

**Planning estimate, not measured production sizes:** allow 0.50 GB for meter,
0.50 GB for requests, 0.05 GB each for pricing, ups-control and dispatch, and
0.10 GB for atuin per encrypted generation: **1.25 GB/day**. Allow 36 generations
for daily peak/expiry overlap and 5 GB total for the immutable archive:
1.25 × 36 + 5 = **50 GB-month**. Individual prototype uploads must be ≤4 GiB;
an archive above that limit needs a separately reviewed multipart design, not
silent truncation. Measure aggregate archive size before accepting this estimate.
This estimate includes dispatch and meter-v0 from the later tickets. This
activation covers at most five daily DBs, not the six in the estimate.

[R2 pricing](https://developers.cloudflare.com/r2/pricing/), retrieved
**2026-10-25**: Standard storage USD 0.015/GB-month, Class A USD 4.50/million,
Class B USD 0.36/million, no retrieval fee or Internet egress charge. Free tier:
10 GB-month, one million Class A and ten million Class B operations monthly.
Six daily DBs × two PUTs × 31 days = 372 Class A operations; monthly drills
and occasional listings remain well below 1,000 operations of either class.
With free allocations available, expected monthly cost is
**(50 − 10) × 0.015 = USD 0.60**. If free allocations are already exhausted,
budget up to **USD 5.61** for this workload's separately rounded units
(50 × 0.015 + 4.50 + 0.36), rather than quoting fractional request charges.
Account-wide usage shares those billing units. Actual cost scales with measured
size, retry frequency, expiry lag, and retained archive volume.

## Credentials

Use the existing static, bucket-scoped **Object Read & Write** account token
for `factory-sqlite-backups`. Devon approved this model instead of temporary
child credentials. There is no off-house issuer or credential renewal service.
The permission group is `Workers R2 Storage Bucket Item Write`. The token can
read and list objects and upload new objects. Bucket locks deny deletion and
overwrite of locked objects even with this permission. A stolen token can
download ciphertext or upload junk, but cannot decrypt the databases or replace
locked backups. Junk uploads can still incur storage costs.

Keep bucket-administrator credentials off both hosts. `Admin Read & Write`
can change bucket configuration, including locks
([token permissions](https://developers.cloudflare.com/r2/api/tokens/),
[S3 operations](https://developers.cloudflare.com/r2/api/s3/api/)).

The existing 1Password item is **Metacomet account → Factory vault → Factory
R2 backup**. Its fields are `access_key_id`, `secret_access_key`, `url`,
`account_id`, and `credential`. The `credential` field holds the Cloudflare API
token and is unused by backups. Deliver only `access_key_id` and
`secret_access_key` as JSON to `/etc/credstore/factory-r2` on GPU,
`root:root 0600`, with parent directory `root:root 0700`. `session_token` is
optional for compatibility with temporary credentials, not required for this
static token. The checked-in unit uses
**`LoadCredential=factory-r2`**, a name-only lookup; a missing credential does
not prevent the local backup from starting. An absolute missing source in
`LoadCredential=` would fail unit startup, so do not change it to that form
([systemd credentials](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#Credentials)).
The helper reads `$CREDENTIALS_DIRECTORY/factory-r2` directly. No credential
value is passed through environment variables, command arguments, shell config
or the repository. Missing/malformed credentials fail only the off-site step.
Restore operators retrieve the same token from the shared Factory vault.
Factory-console needs no R2 credential. On suspected compromise, create and
deliver a replacement bucket-scoped token, verify upload and restore, revoke
the old token, and update the vault item. No scheduled renewal is required.

## Encryption

Encrypt **every database**, including atuin, uniformly with age X25519.
Atuin's history is already client ciphertext, but the server also has account
and sync metadata. Uniform encryption avoids classifying individual tables.
The prototype uses **pyrage 1.4.0**, bindings to the Rust implementation of
the standard age format, with streaming file APIs
([pyrage](https://github.com/woodruffw/pyrage)). The S3 client is boto3 1.43.118.
The runtime installer provisions these dependencies with hash checking into
the root-owned `/opt/factory-backup-r2` environment. The backup timer never
downloads dependencies.

R2's [server-side encryption](https://developers.cloudflare.com/r2/reference/data-security/)
does not protect against a leaked object-read credential. Age encryption keeps
the recovery secret away from both backup nodes and Cloudflare. It provides
authenticated encryption, but is not a signature: anyone holding the public
recipient can fabricate a new valid archive. Bucket locks and independently
recorded recovery-point receipts remain necessary for origin-compromise recovery.

Devon has created the age X25519 identity in **1Password → Factory → Factory
SQLite backup age identity**. Its fields are `credential` for the complete
`AGE-SECRET-KEY-...`, `recipient` for the public `age1...` recipient, and `date`.
The Factory vault is shared with Dave. Devon approved recovery from that shared
vault without a separate offline key copy. Verify vault retrieval before the drill.
Put **only** the `age1...` public recipient in
`/etc/factory-backup/age-recipient.txt`, root-owned, `0644`; the nodes never
need the private identity for scheduled backups. The authorized activation drills
temporarily use a `0600` identity file on GPU's tmpfs and delete it afterward.
Keep previous private identities until all their
objects, including indefinite meter-v0 archives, are migrated and restore-tested.

The external `.sha256` checks encrypted bytes before decryption. The original
compressed snapshot checksum is **inside** age encryption and checked after
decryption; neither the DB nor its plaintext checksum is uploaded unencrypted.
Scratch directories are `0700` and files are `0600`. The uploader does not
change existing source, replica, status, or backup-account permissions.
Use an encrypted scratch volume with sufficient free space. Normal failures
and handled termination clean up scratch, but a crash or forced kill can leave
private plaintext files for an administrator to remove. The optional helper
runs in the existing root backup service; peer SSH still runs as `factory-backup`.

## Restore drill

Run the repeatable local drill from the repository root:

```sh
uvx --from 'moto[server]==5.2.4' --with 'pyrage==1.4.0' --with 'boto3==1.43.118' \
  python -B deploy/backup/test-offsite.py
```

The test starts `uvx --from 'moto[server]==5.2.4' moto_server -H 127.0.0.1 -p
<free-port>` itself and stops it afterward. No Docker. It creates a synthetic
WAL SQLite DB with rows `(7, 'synthetic private data')` and `(29, 'second row')`,
then runs the real `factory-backup.sh` with all DB, status and replica paths
under a temporary directory. That executes `.backup`, `PRAGMA integrity_check`,
zstd and sha256sum, age encryption and boto3 PUTs. The drill uses boto3 GETs
into a fresh temporary directory, checks the ciphertext, decrypts, validates
exact tar members without extracting paths, runs `sha256sum --strict -c`,
decompresses, and opens SQLite read-only for `PRAGMA integrity_check`.
An independent decrypt compares the actual row values. The live fixture's
bytes must remain unchanged.

Actual output from the 2026-10-25 local run (not an orb or real-R2 result):

```text
PASS: off by default; no off-site runtime or network needed
PASS: uploaded age ciphertext decrypts to the original asymmetric row values
20261025T192405.244515911Z.tar.age: OK
20261025T192405.244515911Z.db.zst: OK
factory-gpu/meter: integrity_check=ok
PASS: restore round-trip checks ciphertext, plaintext checksum and SQLite; live fixture unchanged
20261025T192405.244515911Z.db.zst: OK
Uploaded v1/archive/factory-gpu/meter-v0/20261025T192405.244515911Z.tar.age
20261025T192405.244515911Z.tar.age: OK
20261025T192405.244515911Z.db.zst: OK
factory-gpu/meter-v0: integrity_check=ok
PASS: bad checksum/recipient never upload; immutable archive round-trip leaves its source intact
PASS: wrong identity, corruption, forged checksum, swapped DB and unsafe key rejected
PASS: denied PUT preserves local/peer success and pruning; prior failure survives local failure; retry recovers
PASS: sidecar failure leaves an unusable partial pair and cannot mark off-site success
PASS: missing credential only fails off-site; disabling removes its status entry
Versions: moto=5.2.4, boto3=1.43.118, pyrage=1.4.0
```

Other tools in that run: Python 3.14.4, SQLite CLI 3.46.1, zstd 1.5.7,
and uvx 0.13.0. The `meter-v0` case is also synthetic, not the real archive.

Moto proves the client workflow and real HTTP failure handling. It does **not**
prove R2 token permissions, bucket locks, lifecycle timing, actual
production recovery, or service-manager credential delivery. Those require
the approved real-R2 drill in MET-334. The uploader's success means both PUTs
were acknowledged; only an independent restore proves a usable remote copy.

### Fresh-host recovery procedure

Use a clean recovery workstation, not a production database host. Install the
pinned helper dependencies and SQLite/zstd tools in an isolated environment.
Retrieve the R2 credential and age identity from the shared Factory vault
into a private, temporary directory. Never paste them into a shell command or
export their values. Place the credential JSON at `$CREDENTIALS_DIRECTORY/factory-r2`.
Set `TMPDIR` to a private directory on an encrypted recovery volume with enough
free space for ciphertext, tar, compressed and decompressed copies. Use a trusted
inventory to select the exact host, database and timestamp, not just the newest
object after a suspected host compromise.

```sh
CREDENTIALS_DIRECTORY=/path/to/private/credentials TMPDIR=/path/to/private/scratch \
  timeout --kill-after=10s 15m /path/to/venv/bin/python deploy/backup/offsite.py \
  --endpoint https://25c7d5cf9a2dbcd9238a95f54cfeedff.r2.cloudflarestorage.com \
  --bucket factory-sqlite-backups restore \
  --key v1/daily/factory-gpu/meter/UTC_STAMP.tar.age \
  --identity /path/to/private/identity.txt
```

Success prints the two checksum `: OK` lines and
`factory-gpu/meter: integrity_check=ok`. Failure is nonzero. The drill cleans up
downloaded and decrypted scratch files on normal exit and has no live-destination
option. It accepts at most 4 GiB ciphertext and 16 GiB decompressed SQLite.

For an actual recovery, separately download the selected pair into private
scratch with the operator's S3 client, then use the standard age tool and the
exact authenticated member names. Substitute the selected values below:

```sh
sha256sum --strict -c UTC_STAMP.tar.age.sha256
age --decrypt --identity /path/to/private/identity.txt --output snapshot.tar UTC_STAMP.tar.age
tar -xOf snapshot.tar factory-gpu/meter/UTC_STAMP.db.zst > UTC_STAMP.db.zst
tar -xOf snapshot.tar factory-gpu/meter/UTC_STAMP.db.zst.sha256 > UTC_STAMP.db.zst.sha256
sha256sum --strict -c UTC_STAMP.db.zst.sha256
zstd -d UTC_STAMP.db.zst -o recovered.db
sqlite3 -readonly recovered.db 'PRAGMA integrity_check;'
```

Do not copy `recovered.db` into service directories during a drill. After an
explicit recovery approval, stop the owning service, preserve its current
DB/WAL state, restore ownership and modes from that service's runbook, and
validate schema versions, row invariants and application behavior before
starting it. Snapshots of different DBs are sequential, not one cross-database
transaction. Reconcile requests against meter/pricing, dispatch against external
work, and UPS audit against physical state. Never replay pending power actions
or dispatcher jobs merely because a restored DB says they are pending.

## Monitoring

The prototype adds an independent **`r2` entry** to the existing status object:
`last_attempt_ms`, `last_success_ms`, `recovery_point_ms`, and `error`. Local DB
entries retain their existing meaning. Only after **all** current uploads and
sidecars succeed does `r2.last_success_ms` advance to the upload completion time
and `r2.recovery_point_ms` to the snapshot generation's UTC timestamp. That
timestamp precedes the sequential snapshots, so it is conservative for every DB
in the generation. Partial uploads do not count. A failed retry preserves both
timestamps, and a new local attempt preserves a prior off-site error. Turning
the opt-in off removes `r2` on the next run; audit configuration separately to
detect accidental disablement.

`backup-state.py` publishes the whole status to
`/var/lib/factory-backup-status/status.json` as `root:factory-api 0640`.
All three conditions are implemented in the merged prototype, using the existing
factory-api `backup:status` warning and Slack engine:

1. **Status unavailable or unreadable:** `AppState::alert_signals` detects a
   missing file, denied read, invalid JSON, empty status, or a file above the
   1 MB read limit. It supplies an explicit failed status entry instead of
   silently dropping the backup signal. The next engine evaluation raises
   `backup:status`, including when no previous alert exists.
2. **Local backup stale:** the backup rule in `factory-api/src/alerts.rs`
   raises the warning when any local DB's `last_success_ms` is more than
   **26 hours** old. A new pending attempt does not hide an old success.
   Existing local errors and never-successful entries also alert.
3. **Off-site failed or stale:** the optional helper's failure is recorded as
   `r2.error` by `factory-backup.sh` through `backup-state.py`. The same API
   rule alerts on that error or an `r2.recovery_point_ms` more than **26 hours**
   old. A recent upload receipt cannot hide an old recovery point. A missing
   recovery point also alerts unless the initial push is still in progress.
   `Off-site push pending` lasting two hours is a failure, not success.

The engine checks these signals on its existing background cadence, deduplicates
notifications, and sends recovery when healthy status returns. The helper has
a 15-minute timeout plus a ten-second kill grace and bounded S3 retries. Off-site
failure does **not** block local or replica retention; the backup unit remains
successful when only R2 fails. Monitor the JSON/alert path, not just unit failure.

`backup_status_failures_and_freshness_reach_slack` exercises the real collector,
engine, and loopback Slack HTTP stub. Cases include an actual `PermissionDenied`
read of a mode-000 temporary status file, missing/malformed/empty/oversized status,
stale local success, failed upload, and a recent upload with an old recovery
point. It checks alert delivery, deduplication, and recovery. `signal_rules`
checks both sides of the 26-hour boundary and stuck-push handling. Moto tests
prove failed pushes preserve the prior recovery point and local/peer retention.
These checks use temporary data, not production paths or Slack credentials.

Readable publication is already in source, but deployment and real notification
delivery still need verification in MET-334. Publication errors remain warning-only:
an old readable copy eventually becomes stale; a missing or unreadable copy now
alerts immediately on evaluation. A stopped API, Slack outage, or whole-house
loss cannot be reported reliably by this in-house engine. Devon accepted that
risk and dropped off-house freshness monitoring. The in-house `backup:status`
alerts cover a silent upload stop while the API and notification path work.
The later meter-v0 import has no daily freshness deadline.

Run a **monthly independent restore drill for every active DB**,
and before/after encryption-key rotation. Record object keys, checksums,
integrity results, tool versions and drill time outside the house without
recording database contents. Include meter-v0 after its separately approved import.
Keep the recovery identity off both backup hosts except during an authorized
drill with a transient tmpfs file. Use a trusted operator workstation for recovery.
Page on failed or overdue drills. A PUT receipt is not a restore-check receipt.

## Activation runbook

[MET-334](https://linear.app/metacomet/issue/MET-334) covers activation of the
current daily inventory. Dispatch and meter-v0 remain separate later tickets,
not prerequisites for this rollout. The 26-hour budget, static token, shared
Factory vault recovery with Dave, and lack of off-house monitoring are approved.

Run these commands in Devon's existing Mac zsh session with the client helpers
loaded from `client/factory.zsh` in your factory clone (e.g. `~/Code/factory`), as described in the
[Mac client setup](../client/README.md). Do not start Bash or source that file
in Bash. It uses zsh-only syntax. Use an approved maintenance window.
The backup-permissions hotfix and API monitoring
release must already be deployed. Confirm existing local and peer backups work.
Sign in to the Metacomet 1Password account. The Mac needs `op` and `jq` and its
existing `gpu-ssh` and `console-ssh` functions. The helpers load `FACTORY_GPU`
and `FACTORY_CONSOLE` from `client/factory.env` and use
`${FACTORY_SSH_USER:-$USER}` as the node login. Set `FACTORY_SSH_USER` if your
Mac username differs. The hosts need noninteractive sudo for these commands.
Never enable shell tracing or paste credential values into commands.

Use `gpu-ssh` for GPU commands. Its `_factory_ready` check runs before SSH and
can consume stdin, including a script heredoc. Every helper call below carries
its script or configuration in the quoted remote command, with stdin redirected
from `/dev/null`. Heredocs inside those quoted commands run on the remote host,
not through helper stdin. Secret streams instead use plain `ssh -T` with the
same username and host variables. Only non-secret scripts, paths, and
configuration values appear in arguments or environment variables.

### 1. Install the GPU runtime

The deployed checkout is at a release tag. Fetch `origin/main` as `agent` and
create a detached temporary worktree without changing the deployed checkout.
Stop if `/tmp/factory-main` already exists. Review the printed commit and
confirm it contains the approved MET-334 changes before running the installer.

```sh
setopt ERR_EXIT NO_UNSET PIPE_FAIL
gpu-ssh 'sudo -iu agent bash -s <<\REMOTE
set -Eeuo pipefail
cd /home/agent/work/factory
test ! -e /tmp/factory-main
git fetch origin main
git worktree add --detach /tmp/factory-main origin/main
git -C /tmp/factory-main log -1 --format="%H %s"
test -f /tmp/factory-main/deploy/backup/install-offsite-runtime.sh
test -f /tmp/factory-main/deploy/backup/r2-drill.sh
REMOTE' </dev/null
```

After checking that commit, install the pinned runtime. This does not enable R2.
The installer requires Python 3.11 or newer with `venv` and `ensurepip`.
If those modules are missing, install Ubuntu's `python3-venv` package as an
operator prerequisite, then rerun the installer. It does not install OS packages.

```sh
gpu-ssh 'sudo bash /tmp/factory-main/deploy/backup/install-offsite-runtime.sh' </dev/null
gpu-ssh '/opt/factory-backup-r2/bin/python -c "import boto3, importlib.metadata; print(boto3.__version__, importlib.metadata.version(\"pyrage\"))"' </dev/null
```

Expect `1.43.118 1.4.0`. Record the printed runtime rollback snapshot path.
The runtime installer is idempotent and runs only on GPU.

### 2. Deliver the credential and public recipient over stdin

Create root-owned directories first. Build JSON from two input reads on the
Mac, not `--arg` with shell substitutions. Neither key enters argv or the
environment. The API-token `credential` field is not read.

```sh
gpu-ssh 'sudo install -d -o root -g root -m 0700 /etc/credstore && sudo install -d -o root -g root -m 0755 /etc/factory-backup' </dev/null
{
	op read 'op://Factory/Factory R2 backup/access_key_id' &&
	op read 'op://Factory/Factory R2 backup/secret_access_key'
} | jq -nRe '{access_key_id: input, secret_access_key: input}
	| if (.access_key_id | length) > 0 and (.secret_access_key | length) > 0
	  then . else error("Missing R2 key") end' |
	ssh -T "${FACTORY_SSH_USER:-$USER}@$FACTORY_GPU" 'sudo install -o root -g root -m 0600 /dev/stdin /etc/credstore/factory-r2'
op read 'op://Factory/Factory SQLite backup age identity/recipient' |
	ssh -T "${FACTORY_SSH_USER:-$USER}@$FACTORY_GPU" 'sudo install -o root -g root -m 0644 /dev/stdin /etc/factory-backup/age-recipient.txt'
gpu-ssh 'sudo stat -c "%U:%G %a %n" /etc/credstore /etc/credstore/factory-r2 /etc/factory-backup/age-recipient.txt' </dev/null
```

Expect `root:root` and modes `700`, `600`, and `644`. Do not print the JSON.
`jq` emits JSON only after both nonempty input reads succeed. However, SSH's
`install` can still open and truncate the destination before an upstream read
fails. The pipeline's failure is fatal with `PIPE_FAIL`. If any delivery fails,
leave R2 disabled, repeat delivery successfully, and rerun the synthetic drill
before activation. File ownership and mode alone do not prove valid contents.

### 3. Run the synthetic real-R2 drill

This is the first real-R2 operation. It uses only a synthetic SQLite DB under
`v1/daily/drill-synthetic/`. The resulting object stays locked for 35 days.
Do not try to remove the locked object after the drill.

Verify `/run` is tmpfs. Deliver the private identity to a root-only temporary
file, then run the drill with file-path arguments. The exit trap deletes the
identity even if the drill fails. If delivery or the SSH session fails before
the trap is installed, delete `/run/factory-r2-drill` before doing anything else.

```sh
gpu-ssh 'test "$(findmnt -n -o FSTYPE -T /run)" = tmpfs && sudo install -d -o root -g root -m 0700 /run/factory-r2-drill' </dev/null
op read 'op://Factory/Factory SQLite backup age identity/credential' |
	ssh -T "${FACTORY_SSH_USER:-$USER}@$FACTORY_GPU" 'sudo install -o root -g root -m 0600 /dev/stdin /run/factory-r2-drill/identity.txt'
gpu-ssh 'sudo bash -s <<\REMOTE
set -Eeuo pipefail
cleanup() {
	rm -f /run/factory-r2-drill/identity.txt
	rmdir /run/factory-r2-drill
}
trap cleanup EXIT
trap "exit 1" HUP INT TERM
bash /tmp/factory-main/deploy/backup/r2-drill.sh \
	/etc/credstore/factory-r2 \
	/etc/factory-backup/age-recipient.txt \
	/run/factory-r2-drill/identity.txt
REMOTE' </dev/null
gpu-ssh 'sudo test ! -e /run/factory-r2-drill/identity.txt' </dev/null
```

Require a PASS summary for upload, restore with `integrity_check=ok`, denied
overwrite, and denied delete. The drill uses the fixed endpoint and bucket
above and `/opt/factory-backup-r2/bin/python`. It shreds its scratch files.
On any failure, leave R2 disabled and investigate before uploading real DBs.

### 4. Reinstall backup artifacts with R2 disabled, console first

Use the same reviewed commit on both nodes. This is the only shared-node loop.
It stages the detached worktree on console and checks that the source config
is still disabled on both nodes. It does not install artifacts yet.

```sh
REV=$(gpu-ssh 'sudo -iu agent git -C /tmp/factory-main rev-parse HEAD' </dev/null | tail -n 1)
[[ $REV =~ ^[0-9a-f]{40}$ ]]
# Both nodes: stage and verify the reviewed backup artifacts.
for n in gpu console; do
	printf '\n== %s: stage backup artifacts ==\n' "$n"
	"$n-ssh" 'sudo -iu agent bash -s -- '"$REV"' <<\REMOTE
set -Eeuo pipefail
cd /home/agent/work/factory
if [[ ! -e /tmp/factory-main ]]; then
	git fetch origin main
	git worktree add --detach /tmp/factory-main origin/main
fi
test "$(git -C /tmp/factory-main rev-parse HEAD)" = "$1"
test -z "$(git -C /tmp/factory-main status --porcelain)"
unset R2_ENABLED
source /tmp/factory-main/deploy/backup/nodes.conf
test "$R2_ENABLED" = 0
REMOTE' </dev/null
done
console-ssh 'sudo bash /tmp/factory-main/deploy/backup/install-backup.sh' </dev/null
gpu-ssh 'sudo bash /tmp/factory-main/deploy/backup/install-backup.sh' </dev/null
console-ssh 'sudo /usr/local/lib/factory-backup/restore-check.sh all' </dev/null
gpu-ssh 'sudo /usr/local/lib/factory-backup/restore-check.sh all' </dev/null
```

Each installer stops and restarts backup units, replaces installed `nodes.conf`,
runs a local backup with peer replication, and enables the timer. It never writes
the operator-owned `/etc/factory-backup/r2.conf`. On a reinstall after activation,
that file preserves R2 settings. Record each
printed configuration rollback path. Require checksum and integrity success
on both nodes. Atuin may be skipped if its database has not been created.
Do not change ownership or modes to bypass a failed check.

### 5. Enable R2 on GPU and run one backup

Write these non-secret overrides to GPU's operator-owned `r2.conf`,
`root:root 0644`. `nodes.conf` sources it after the R2 defaults; artifact
reinstalls and configuration rollback never write it. Leave console disabled.
Re-running this block replaces the file with the same settings.

```sh
gpu-ssh 'sudo install -o root -g root -m 0644 /dev/stdin /etc/factory-backup/r2.conf <<\CONFIG
# MET-334 approved off-site backup settings.
R2_ENABLED=1
R2_ENDPOINT=https://25c7d5cf9a2dbcd9238a95f54cfeedff.r2.cloudflarestorage.com
R2_BUCKET=factory-sqlite-backups
R2_PYTHON=/opt/factory-backup-r2/bin/python
R2_RECIPIENT_FILE=/etc/factory-backup/age-recipient.txt
CONFIG' </dev/null
gpu-ssh 'sudo systemctl start factory-backup.service' </dev/null
gpu-ssh 'sudo journalctl -u factory-backup.service -n 80 --no-pager' </dev/null
```

A successful unit alone does not prove R2 success. Require no `r2.error`, a new
`r2.last_success_ms`, and a fresh `r2.recovery_point_ms` in step 7. Keep the
recorded object keys from the upload log for the next step.

### 6. Restore every active DB from R2

Repeat the tmpfs identity delivery below. The restore helper downloads and
verifies remote data into private scratch and never writes a live database.
Use an encrypted scratch volume with enough room for all intermediate copies.
The example uses `/var/tmp`; confirm that its backing volume is encrypted and
has enough free space before proceeding.

```sh
gpu-ssh 'test "$(findmnt -n -o FSTYPE -T /run)" = tmpfs && sudo install -d -o root -g root -m 0700 /run/factory-r2-drill' </dev/null
op read 'op://Factory/Factory SQLite backup age identity/credential' |
	ssh -T "${FACTORY_SSH_USER:-$USER}@$FACTORY_GPU" 'sudo install -o root -g root -m 0600 /dev/stdin /run/factory-r2-drill/identity.txt'
gpu-ssh 'sudo bash -s <<\REMOTE
set -Eeuo pipefail
umask 0077
scratch=
cleanup() {
	if [[ -n $scratch ]]; then rm -rf -- "$scratch"; fi
	rm -f /run/factory-r2-drill/identity.txt
	rmdir /run/factory-r2-drill
}
trap cleanup EXIT
trap "exit 1" HUP INT TERM
scratch=$(mktemp -d /var/tmp/factory-r2-restore.XXXXXX)
source /etc/factory-backup/nodes.conf
export CREDENTIALS_DIRECTORY=/etc/credstore
export TMPDIR="$scratch"
for entry in "${DBS[@]}"; do
	name=${entry%%:*}
	if [[ $name == atuin && ! -e ${entry#*:} ]]; then
		printf "Skipping atuin: database not created\n"
		continue
	fi
	directory="$LOCAL_ROOT/$BACKUP_HOST/$name"
	stamp=$(find "$directory" -maxdepth 1 -type f -name "*.db.zst" -printf "%f\n" | LC_ALL=C sort | tail -n 1)
	test -n "$stamp"
	stamp=${stamp%.db.zst}
	key="v1/daily/$BACKUP_HOST/$name/$stamp.tar.age"
	printf "Restore-check %s\n" "$key"
	timeout --kill-after=10s 15m "$R2_PYTHON" /usr/local/lib/factory-backup/offsite.py \
		--endpoint "$R2_ENDPOINT" --bucket "$R2_BUCKET" restore \
		--key "$key" --identity /run/factory-r2-drill/identity.txt
done
REMOTE' </dev/null
gpu-ssh 'sudo test ! -e /run/factory-r2-drill/identity.txt' </dev/null
```

Check that each selected stamp matches a successful upload from step 5. Avoid a
scheduled backup during this drill. Require both checksum checks and
`factory-gpu/<db>: integrity_check=ok` for meter, requests, pricing, ups-control,
and atuin if present. Record keys, checksums, versions, and results without DB
contents. If delivery fails before the trap is installed, delete the tmpfs
identity immediately. This GPU drill is authorized for activation. Use a clean
recovery workstation for a compromise investigation.

### 7. Verify backup:status and remove temporary worktrees

Check the published status through the API's account without printing database
contents or credentials:

```sh
gpu-ssh 'sudo -u factory-api python3 - <<\PY
import json
import time
from pathlib import Path

status = json.loads(Path("/var/lib/factory-backup-status/status.json").read_text())
now = time.time() * 1000
assert status and "r2" in status, "Missing backup status or r2 entry"
for name, entry in status.items():
	assert not entry.get("error"), f"{name}: backup error"
	field = "recovery_point_ms" if name == "r2" else "last_success_ms"
	stamp = entry.get(field)
	assert stamp is not None and 0 <= now - stamp <= 26 * 3600 * 1000, f"{name}: stale or missing {field}"
	if name == "r2":
		assert entry.get("last_success_ms") is not None, "No R2 upload success"
	print(f"{name}: fresh {field}, no error")
PY' </dev/null
gpu-ssh 'systemctl list-timers factory-backup.timer --no-pager' </dev/null
```

Wait for the API's next background evaluation. Check `GET /v1/alerts` through
the normal authenticated API route and confirm no active `backup:status`
warning. If a warning was active, confirm its recovery notification in Slack.
Do not alter live DB or status permissions to manufacture an alert. The
temporary-fixture alert tests described above cover failure and recovery paths.
Record separately if real Slack delivery has not been verified.

After all checks pass, remove both temporary worktrees as `agent`. Keep the
deployed release-tag checkout unchanged.

```sh
console-ssh 'sudo -iu agent git -C /home/agent/work/factory worktree remove /tmp/factory-main' </dev/null
gpu-ssh 'sudo -iu agent git -C /home/agent/work/factory worktree remove /tmp/factory-main' </dev/null
```

### Disable or roll back R2

To disable R2, replace GPU's `/etc/factory-backup/r2.conf` with the explicit
override below, keeping it `root:root 0644`. Run the
backup service once to remove the off-site status entry and verify that the
local and peer path still succeeds. Preserve remote objects, old identities,
and receipts. Revoke upload credentials separately.

```sh
gpu-ssh 'sudo install -o root -g root -m 0644 /dev/stdin /etc/factory-backup/r2.conf <<\CONFIG
R2_ENABLED=0
CONFIG' </dev/null
gpu-ssh 'sudo systemctl start factory-backup.service' </dev/null
```

If an artifact install needs rollback, use its recorded snapshot with
`rollback-backup-config.sh SNAPSHOT` on that node. First disable R2 using
`r2.conf` above; rollback deliberately preserves that operator-owned file.
To re-enable it later, repeat step 5. Configuration rollback
includes `offsite.py`, but never deletes vault items, credstore files,
encryption keys, or remote backups. To roll back the runtime, first disable R2
and wait for any running backup to finish. Then run
`sudo bash /tmp/factory-main/deploy/backup/rollback-offsite-runtime.sh SNAPSHOT`
through `gpu-ssh`, using the root-owned runtime snapshot
`/opt/factory-backup-r2-snapshots/install.*` recorded in step 1. Pass the exact
snapshot directory, not the wildcard. These rollback
scripts live in the temporary worktree. If it has been removed, recreate the
same reviewed commit before using them. Runtime rollback changes only the
runtime and leaves credentials and backups intact.
