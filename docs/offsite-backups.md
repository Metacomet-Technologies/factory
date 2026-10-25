# Off-site SQLite backups (MET-308)

Investigated 2026-10-25. This is a disabled-by-default prototype, not a
production rollout. All experiments used synthetic SQLite data, disposable
credentials, and moto on loopback on factory-gpu. No production database,
`/var/backups` tree, live unit, or real R2 endpoint was accessed. Devon's
expanded request supersedes MET-308's older docs-only isolation.

## Recommendation per database

Use the existing verified snapshots first. The two hosts share a house and
power supply; cross-host replication does not protect against whole-house loss.
The following RPOs are **proposed acceptable data-loss budgets**, not measured
SLAs. A daily backup gives roughly 24 hours of loss between successful runs.
The 03:15 host-local schedule adds up to ten minutes of jitter, snapshot/upload
time, and a possible 25-hour interval at the DST transition. Failures extend
the recovery-point age until another upload succeeds. The proposed maximum
recovery-point age is **26 hours** for each active daily database, including
that schedule margin. Both local freshness and off-site recovery-point alerts
use this threshold. A stricter accepted RPO requires a shorter backup interval
or a separately evaluated Litestream deployment.

| Name | Host | Path | Covered today | System of record | RPO | Mechanism | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| meter | factory-gpu | `/srv/factory/meter/meter.db` | yes | yes: original request facts, GPU history and rollups | 26 h; daily snapshots | snapshot-to-R2 | Historical observations cannot be recollected, but about a day of operational telemetry loss is the proposed disaster budget. |
| requests | factory-gpu | `/var/lib/factory-api/requests.db` | yes | yes: frozen costs, aggregates, UPS/device/network histories and settings; not just a meter cache | 26 h; daily snapshots | snapshot-to-R2 | Explicitly accept losing up to 26 hours of cost/operational history after whole-house loss. No current requirement establishes a minutes-level billing ledger. |
| pricing | factory-gpu | `/var/lib/factory-api/pricing.db` | yes | yes: historical prices and operator selections | 26 h; daily snapshots | snapshot-to-R2 | Refetching current prices cannot restore old rates or confirmations. Preserve the DB even though writes are infrequent. |
| ups-control | factory-gpu | `/var/lib/factory-ups-control/audit.db` | yes | yes: action audit, confirmations, cooldowns and notification state | 26 h for history; daily snapshots | snapshot-to-R2 | Restore with control disabled and reconcile physical actions first. A fresher asynchronous copy alone cannot make physical-action replay safe. |
| dispatch | factory-gpu | `/home/agent/.local/state/factory-dispatch/dispatch.db` | no | yes: local claims, decisions, thread and QA/recovery state | 26 h; manual reconciliation before restart | snapshot-to-R2 | Linear/GitHub are reconciliation inputs, not a complete copy of the decision ledger. Add to inventory in rollout. |
| atuin | factory-gpu, conditional on activation | `/var/lib/atuin/atuin.db` | yes in config; skipped if not created | no for history, assuming clients retain full encrypted history; yes for account/sync metadata | 26 h for server state; daily snapshots | snapshot-to-R2 | Cheap server recovery; no continuous replication needed for a client-encrypted sync hub. Client retention is an assumption to confirm in the drill. |
| meter-v0 | factory-gpu | `/var/backups/factory-db/factory-gpu/meter-v0/` | no: outside `DBS`, pruning and restore checks | yes: immutable historical archive | zero further loss after a verified one-time copy | snapshot-to-R2 | Upload every approved archive generation once, keep indefinitely, and include in restore drills. Do not silently discard history. |

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

**Requests RPO decision:** daily loss is acceptable for this recommendation,
not an assertion that the data is reconstructible. Meter replay cannot restore
co-resident telemetry or every historical cost decision, and both source and
API copies disappear in a house loss. If requests becomes authoritative for
customer invoicing or its loss budget becomes 15 minutes, choose Litestream
for requests and separately reassess meter/pricing consistency. None of the
current evidence justifies operating continuous replication for every DB.
No database is recommended as `none`; no Litestream daemon is part of this PR.

Rollout adds `dispatch` to GPU `DBS` and console `PEER_DBS`. Root's SQLite
`.backup` can read the `agent`-owned WAL database outside `/var/lib`; preserve
its ownership and modes, do not copy the live DB/WAL files or widen permissions.
Test a live WAL writer and an absent required dispatch DB before activation.
Keep the dispatcher disabled after restore until claims and in-flight work
are reconciled with Linear/GitHub. This prototype does not change `DBS`.

For `meter-v0`, inventory and validate the existing pairs under separate
approval. Verify checksums, decompress in scratch, and require SQLite integrity
before the first upload. Use `offsite.py push --archive` with each exact stamp.
If an archive lacks a sidecar, record a newly verified baseline explicitly;
do not pretend a new checksum proves historical authenticity. Do not add the
immutable archive to daily pruning or take recurring snapshots of it.

## Bucket layout, retention and cost

Proposed private bucket: **`factory-sqlite-backups`**, Standard storage, default
jurisdiction, `enam` location hint. The location hint is not a residency
guarantee ([data location](https://developers.cloudflare.com/r2/reference/data-location/)).
The S3 region is **`auto`**, endpoint
`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
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
is needed by the uploader. A separate read-only operator lists complete pairs.
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

Create these enabled rules, using an administrator credential kept off-host:

- Lifecycle `expire-daily-35d`: prefix `v1/daily/`, `Expiration.Days = 35`.
- Lifecycle `abort-incomplete-1d`: empty prefix, `AbortIncompleteMultipartUpload.DaysAfterInitiation = 1`.
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

**A normal R2 token is not write-only.** The narrowest long-lived upload
permission is **Object Read & Write**, API group
`Workers R2 Storage Bucket Item Write`, scoped only to `factory-sqlite-backups`.
It can read/list, overwrite and delete objects, and is therefore not the
credential to put on factory-gpu. `Admin Read & Write` can also change bucket
configuration and must stay off-host
([token permissions](https://developers.cloudflare.com/r2/api/tokens/),
[S3 operations](https://developers.cloudflare.com/r2/api/s3/api/)).

R2 now supports locally signed **temporary credentials with explicit actions**.
Mint a child credential off-host with bucket `factory-sqlite-backups`,
`actions: ["PutObject"]`, and `paths.prefixPaths: ["v1/daily/factory-gpu/"]`.
Do not include `scope` alongside `actions`. This denies GET, LIST, DELETE and
other buckets, but PUT alone still permits overwrite unless a bucket lock
prevents it. For the one-time archive import mint a separate child restricted
to `v1/archive/factory-gpu/meter-v0/`. The API's broad permission presets are
not a substitute for locally signed action restrictions
([temporary credential actions](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)).

The [Cloudflare signing example](https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/)
specifies HS256 JWT claims (`sub`, `iss`, `aud`, `iat`, `exp`, bucket, actions,
paths), temporary secret SHA-256(JWT), and session token base64(`jwt/` + JWT).
Keep the parent secret in **1Password → Factory → Factory R2 backup signer**.
Never copy that parent secret to either factory node. A compromised child
cannot mint new credentials. Revoking the parent revokes its children.

For rollout, use an off-house issuer to deliver a **48-hour child every 24 hours**.
This renewal/delivery mechanism is deliberately not implemented here and is a
production activation prerequisite. A manual child suffices for an approved
one-shot real-R2 drill. Do not replace renewal with a permanent read/write
token on the host. Rotate the parent every 90 days and immediately on suspicion
of compromise: create replacement, mint/deliver child, verify a new upload and
independent restore, revoke old parent, verify old child rejection, then update
the vault record. Alert on renewal failure before child expiry.

Store only the child on factory-gpu at `/etc/credstore/factory-r2`,
`root:root 0600`, inside a `0700` directory. Its JSON fields are
`access_key_id`, `secret_access_key`, `session_token`. The checked-in unit uses
**`LoadCredential=factory-r2`**, a name-only lookup; a missing credential does
not prevent the local backup from starting. An absolute missing source in
`LoadCredential=` would fail unit startup, so do not change it to that form
([systemd credentials](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#Credentials)).
The helper reads `$CREDENTIALS_DIRECTORY/factory-r2` directly. No credential
value is passed through environment variables, command arguments, shell config
or the repository. Missing/malformed credentials fail only the off-site step.
Restore operators use a separate **Object Read only** bucket-scoped credential,
stored as **Factory R2 backup restore** in the same vault, never on a scheduled
backup node. Factory-console needs neither credential.

## Encryption

Encrypt **every database**, including atuin, uniformly with age X25519.
Atuin's history is already client ciphertext, but the server also has account
and sync metadata. Uniform encryption avoids classifying individual tables.
The prototype uses **pyrage 1.4.0**, bindings to the Rust implementation of
the standard age format, with streaming file APIs
([pyrage](https://github.com/woodruffw/pyrage)). The S3 client is boto3 1.43.118.
These two dependencies are provisioned into a private Python environment by
the later rollout, not downloaded by the backup timer.

R2's [server-side encryption](https://developers.cloudflare.com/r2/reference/data-security/)
does not protect against a leaked object-read credential. Age encryption keeps
the recovery secret away from both backup nodes and Cloudflare. It provides
authenticated encryption, but is not a signature: anyone holding the public
recipient can fabricate a new valid archive. Bucket locks and independently
recorded recovery-point receipts remain necessary for origin-compromise recovery.

Create one age X25519 identity on a trusted administrator workstation. Save
the complete `AGE-SECRET-KEY-...` identity, public recipient, creation date and
recovery instructions in **1Password → Factory → Factory SQLite backup age
identity**. Store an offline recovery copy and 1Password recovery material
outside the house. Verify retrieval from a second authorized workstation.
Put **only** the `age1...` public recipient in
`/etc/factory-backup/age-recipient.txt`, root-owned, `0644`; the nodes never
need the private identity. Keep previous private identities until all their
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
prove R2 action-scoped JWT enforcement, bucket locks, lifecycle timing, actual
production recovery, or service-manager credential delivery. Those require
the approved real-R2 drill in MET-334. The uploader's success means both PUTs
were acknowledged; only an independent restore proves a usable remote copy.

### Fresh-host recovery procedure

Use a clean recovery workstation, not a production database host. Install the
pinned helper dependencies and SQLite/zstd tools in an isolated environment.
Retrieve the read-only R2 credential and age identity from the Factory vault
into a private, temporary directory. Never paste them into a shell command or
export their values. Place the credential JSON at `$CREDENTIALS_DIRECTORY/factory-r2`.
Set `TMPDIR` to a private directory on an encrypted recovery volume with enough
free space for ciphertext, tar, compressed and decompressed copies. Use a trusted
inventory to select the exact host, database and timestamp, not just the newest
object after a suspected host compromise.

```sh
CREDENTIALS_DIRECTORY=/path/to/private/credentials TMPDIR=/path/to/private/scratch \
  timeout --kill-after=10s 15m /path/to/venv/bin/python deploy/backup/offsite.py \
  --endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com \
  --bucket factory-sqlite-backups restore \
  --key v1/daily/factory-gpu/meter/UTC_STAMP.tar.age \
  --identity /path/to/private/identity.txt
```

Success prints the two checksum `: OK` lines and
`factory-gpu/meter: integrity_check=ok`. Failure is nonzero. The drill cleans up
downloaded and decrypted scratch files on normal exit and has no live-destination
option. It accepts at most 4 GiB ciphertext and 16 GiB decompressed SQLite.

For an actual recovery, separately download the selected pair into private
scratch with the read-only client, then use the standard age tool and the
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
All three conditions are implemented **in this PR**, using the existing
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
loss cannot be reported reliably by this in-house engine. An independent
off-house check must detect no complete daily R2 recovery point within 26 hours,
using the timestamp in the object key rather than the upload time. The immutable
meter-v0 archive has no daily freshness deadline; its complete approved inventory
must remain present and pass the recurring restore drill.

Run a **monthly independent restore drill for every active DB**, plus meter-v0,
and before/after encryption-key rotation. Record object keys, checksums,
integrity results, tool versions and drill time outside the house without
recording database contents. Keep the recovery identity off both backup hosts;
use a trusted operator workstation or separately authorized recovery executor.
Page on failed or overdue drills. A PUT receipt is not a restore-check receipt.

## Follow-up

[MET-334](https://linear.app/metacomet/issue/MET-334/roll-out-verified-encrypted-r2-backups-and-off-host-credential-renewal)
is the Backlog rollout issue related to MET-308. It owns production approval,
off-host credential renewal, R2 lock/lifecycle/permission checks, measured cost
inputs, dispatch inventory, meter-v0 import, independent freshness monitoring,
and real-R2 plus per-database restore/alert drills. Spec sections remain empty.
MET-115 is the older overlapping issue; its disposition remains Devon's decision.

### Administrator setup checklist and apply order

These are **future operator steps**, not actions taken by this investigation.

1. Review the daily RPO assumption, especially requests, and approve MET-334.
   Confirm the backup-permissions hotfix is deployed and verify current local
   and replica restores without broadening permissions.
2. Create private Standard bucket `factory-sqlite-backups`, default jurisdiction,
   `enam` location hint, S3 region `auto`. Add both lifecycle rules and both
   bucket locks above **before uploading anything**. Keep bucket-admin access
   off the hosts.
3. Create the bucket-scoped Object Read & Write parent in 1Password Factory
   item **Factory R2 backup signer** and the separate read-only recovery item.
   Build and verify off-host issuance/delivery of PutObject-only 48-hour children
   every 24 hours. Confirm that GET, LIST, DELETE, other buckets and overwrite
   under lock are denied. Do not give the parent to factory-gpu.
4. Generate the age X25519 identity on the administrator workstation. Store it
   in **Factory SQLite backup age identity**, with an off-house recovery copy.
   Verify the private key can be recovered before installing the public recipient.
5. Provision a root-owned Python environment with `boto3==1.43.118` and
   `pyrage==1.4.0`. Run the synthetic drill against real R2 with a temporary
   test prefix and the intended lock policy. Check credential expiry and denied
   upload behavior. No production data is required for this first test.
6. In an approved maintenance window, install the reviewed backup artifacts,
   console first, GPU second, **with R2 disabled**. The existing installer
   stops/restarts backup units; do not run it as a read-only check. Deploy the
   API monitoring changes through its normal release process. Repeat local
   and peer checks and verify the API-readable status file and notifications.
7. On GPU only, atomically deliver the child JSON to `/etc/credstore/factory-r2`
   (`root:root 0600`, parent `0700`). Install the public recipient file. Configure
   the following non-secret values in `/etc/factory-backup/nodes.conf`:

   ```sh
   R2_ENABLED=1
   R2_PYTHON=/opt/factory-backup-r2/bin/python
   R2_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
   R2_BUCKET=factory-sqlite-backups
   R2_RECIPIENT_FILE=/etc/factory-backup/age-recipient.txt
   ```

8. Approve one immediate backup, then independently download and drill each
   active DB. Check local/replica retention and both local and `r2` status.
   Exercise unavailable status, stale local success, denied off-site upload,
   and stale off-site recovery points using a separate temporary status fixture
   read by a test API instance. Never change live DB or status permissions to
   test alerts. Confirm delivery and recovery, then verify the production
   collector reads the published status successfully.
9. Add dispatch under its own verified rollout; inventory and upload meter-v0
   once with archive-scoped credentials. Record the complete object inventory
   off-house. Activate independent freshness/renewal monitoring and monthly
   restore drills before declaring the system protected.

To disable the prototype, set `R2_ENABLED=0`; the next run removes the off-site
status entry and uses only the existing local/peer path. Preserve remote objects,
old identities and receipts. Revoke upload credentials separately. Configuration
rollback includes `offsite.py`, but intentionally never deletes vault items,
credstore files, encryption keys or remote backups.
