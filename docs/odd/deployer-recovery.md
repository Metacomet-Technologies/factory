# Recover the automatic deployer after v0.2.10

Operator procedure, not an instruction for an agent to execute. Nothing in this
patch authorizes a host change, deployment, publication, or recovery issue write.
Run the Mac commands below only after approving the corrected tools commit and
the backlog deployment (including any DB migrations). Replace `FIX_SHA` with
that exact reviewed, merged commit, never a moving `origin/main` expression.

The incident has two separate observations: the timer cannot load `deploy.ts`
after its checkout of v0.2.10, and the old meter installer rejected the full-SHA
artifact before creating a snapshot. `lastTag=v0.2.10` / meter `health=fail`
records a handled failed attempt, not the identity or health of the live meter.
Do not roll back a service merely because that field is red.

The deployer selects stable published tags **oldest first above `lastTag`**.
That is why it chose v0.2.10, not the newest release. Recovery preserves this
ordering and drains the backlog to the newest eligible release containing both
this fix and PR #201; it does not jump the ledger to that release. The corrected
tools stay pinned while source moves in a separate worktree. Never copy scripts
into an old checkout, checkout an old release over the tools, or force a dirty
tree clean. A source checkout aliasing the tools is explicitly refused.

## Release prerequisite: both fixes must be published

PR #201 merged as `dcc0b84e02c00cfa2d7ef76ce3a74542fdacacef`. At the
2026-10-25 investigation, published releases ended at v0.2.44 and none contained
it. In the current patch-only sequence #201 would first be v0.2.51, but this is
not a confirmed published tag. Do not use that prediction as a deployment
target. The ancestry and immutable-bundle checks below determine the real tag.

Pause the timer and preserve evidence (step 1) before approving publication.
Merge the deployer fix only after review and green PR CI, then require successful
exact-merge-SHA main CI (`rust`, `kiosk`, `scripts`, `sandbox`). Let the existing
publisher reconcile and continue its batches. If it stalls, inspect its error
and reservations using [release recovery](../release.md); do not skip a failed
predecessor, move a tag, delete a draft, or change the activation baseline.
If a publication wakeup is needed, the operator may separately approve and run
this **publishing** command on the Mac (not during patch development):

```sh
gh workflow run release.yml --ref main --repo Metacomet-Technologies/factory
```

Leave `tag` empty: that input only verifies an existing release. Existing hidden
drafts or release-less reservations need the explicit, inspected recovery inputs
documented in `docs/release.md`, not a blind retry. Keep GPU's timer paused until
a verified target containing both commits exists. Publication alone does not
install backup infrastructure: #201's API backup-health monitoring also needs
the existing backup timer/log prerequisites. Do not run unrelated installers as
part of this repair.

## 1. Pause launches, let any current attempt finish, preserve evidence

```sh
gpu-ssh 'sudo systemctl disable --now factory-deploy.timer; systemctl show factory-deploy.service -p ActiveState -p SubState -p MainPID; systemctl list-timers --all factory-deploy.timer'
```

Require the service to be `inactive` or `failed`, with `MainPID=0`. If it is
`activating`, wait and repeat the read-only `systemctl show`; the unit has a
30-minute cap. Do not use `systemctl stop` to interrupt an installer. Keep other
operators from running manual deploys or changing the tools checkout throughout
this procedure. The job's lock is also used for the evidence copy:

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
umask 0077
state=/home/agent/.local/state/factory-odd
exec 9>>"$state/deploy.lock"
flock -n 9
backup=$(mktemp -d "$state/recovery-v0.2.10.XXXXXX")
test -s "$state/deploy.json"
python3 -m json.tool "$state/deploy.json" >/dev/null
cp -p "$state/deploy.json" "$backup/deploy.json"
sha256sum "$state/deploy.json" > "$backup/ledger.sha256"
git -C /home/agent/work/factory rev-parse HEAD > "$backup/tools-before.sha"
journalctl -u factory-deploy --since '2026-10-24' -o cat > "$backup/deploy.journal"
printf 'Preserve recovery directory: %s\n' "$backup"
AGENT
```

Keep that printed path as `RECOVERY_DIR` below. Preserve release downloads,
snapshots, `inFlight`, pending `receipt` and its `delivered` list. Never delete,
reset, or advance the ledger to bootstrap past pending releases.

## 2. Check what is actually running before changing anything

```sh
gpu-ssh 'systemctl show meter.service factory-api.service -p Id -p ActiveState -p MainPID -p ExecMainStartTimestamp; curl -fsS --max-time 10 http://127.0.0.1:11434/meter/health; echo; curl -fsS --max-time 10 http://127.0.0.1:8080/v1/health; echo; curl -fsS --max-time 10 http://127.0.0.1:8080/version.json; echo'
```

Save the reported SHAs, dirty flags, statuses and start times with the recovery
evidence. A healthy pre-existing SHA is consistent with rejection before any
deployment changes. An unreachable/degraded service requires investigation;
do not infer that v0.2.10 replaced it or invent a rollback snapshot. Correlate
with the saved journal's identity rejection and “No deployment changes made;
no rollback snapshot exists.” Do not restart meter/API just to repair the timer.

## 3. Install corrected machinery without starting the backlog

After the patch is separately merged and approved, update only the clean tools
checkout. The following stops on local changes; preserve and review them rather
than forcing checkout, resetting, or cleaning the tree.

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
FIX_SHA=REPLACE_WITH_REVIEWED_MERGED_COMMIT
cd /home/agent/work/factory
test -z "$(git status --porcelain)"
git fetch --quiet --tags origin
git merge-base --is-ancestor "$FIX_SHA" origin/main
git checkout --detach "$FIX_SHA"
test "$(git rev-parse HEAD)" = "$FIX_SHA"
test -z "$(git status --porcelain)"
scripts/env/check --env factory-gpu
AGENT
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/install-deploy.sh --install-only'
gpu-ssh 'systemctl cat factory-deploy.service; systemctl is-active factory-deploy.timer'
```

The final `is-active` should print `inactive` and return nonzero. The unit still
executes `/home/agent/work/factory/scripts/odd/deploy.ts`, under its existing
`flock`; sudoers is unchanged. `--install-only` snapshots/replaces the units,
but does not start the job, enable the timer or touch the ledger. It refuses an
active deploy service. Compare the preserved ledger before proceeding:

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
RECOVERY_DIR=REPLACE_WITH_PRINTED_RECOVERY_DIRECTORY
sha256sum -c "$RECOVERY_DIR/ledger.sha256"
cmp "$RECOVERY_DIR/deploy.json" /home/agent/.local/state/factory-odd/deploy.json
AGENT
```

Select and verify the newest stable immutable published release containing both
commits. This reads every release page; GitHub's “latest” flag or a limited list
is not an ancestry check. Run with the timer still stopped. The target is a
minimum recovery goal, not a cap: a later eligible publication may also be
processed by the job. A verification failure stops recovery, not selects an older
target silently.

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
FIX_SHA=REPLACE_WITH_REVIEWED_MERGED_COMMIT
RECOVERY_DIR=REPLACE_WITH_PRINTED_RECOVERY_DIRECTORY
BACKUP_SHA=dcc0b84e02c00cfa2d7ef76ce3a74542fdacacef
cd /home/agent/work/factory
test "$(git rev-parse HEAD)" = "$FIX_SHA"
git fetch --quiet --tags origin
gh api --paginate --slurp 'repos/Metacomet-Technologies/factory/releases?per_page=100' > "$RECOVERY_DIR/releases.json"
python3 - "$RECOVERY_DIR/releases.json" <<'PY' > "$RECOVERY_DIR/candidates.txt"
import json, re, sys
releases = [r for page in json.load(open(sys.argv[1])) for r in page]
tags = [r['tag_name'] for r in releases if not r['draft'] and not r['prerelease']
        and r.get('immutable') is True and re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', r['tag_name'])]
print('\n'.join(sorted(tags, key=lambda t: tuple(map(int, t[1:].split('.'))), reverse=True)))
PY
target=
while IFS= read -r tag; do
    test -n "$tag" || continue
    sha=$(git rev-parse --verify "refs/tags/$tag^{commit}")
    if git merge-base --is-ancestor "$FIX_SHA" "$sha" &&
       git merge-base --is-ancestor "$BACKUP_SHA" "$sha" &&
       git merge-base --is-ancestor "$sha" origin/main; then
        target=$tag
        break
    fi
done < "$RECOVERY_DIR/candidates.txt"
test -n "$target" || { echo 'No published target contains both fixes; keep timer stopped and finish publication.' >&2; exit 1; }
git show "$sha:deploy/components.json" > "$RECOVERY_DIR/target-inventory.json"
bundle=$(mktemp -d "$RECOVERY_DIR/verified.XXXXXX")
python3 scripts/release/release.py verify --anonymous --tag "$target" --sha "$sha" --inventory "$RECOVERY_DIR/target-inventory.json" --directory "$bundle"
jq -n --arg tag "$target" --arg sha "$sha" --arg tools "$FIX_SHA" '{tag:$tag, sha:$sha, tools:$tools}' > "$RECOVERY_DIR/target.json"
cat "$RECOVERY_DIR/target.json"
AGENT
```

## 4. Explicitly reconcile the handled failure; do not rewrite it as success

Inspect the ledger as `agent` and resolve the immutable tag's full commit:

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
cd /home/agent/work/factory
sha=$(git rev-parse 'refs/tags/v0.2.10^{commit}')
jq --arg sha "$sha" -e '
  .lastTag == "v0.2.10" and .components.meter.tag == "v0.2.10" and
  .components.meter.sha == $sha and .components.meter.health == "fail" and
  (.components.meter.snapshot == null) and (.inFlight == null) and (.receipt == null)
' /home/agent/.local/state/factory-odd/deploy.json
git log --first-parent --format='%s' v0.2.9..v0.2.10
AGENT
```

This predicate is specific to the confirmed incident. If it fails, stop and
inspect the differing state. A pending receipt is resumed, not deleted; an
in-flight install may need its recorded snapshot. Do not apply these assumptions
to another failure.

For the PRs printed above, read their `closes`/`contributes` issue references
(`gh pr view NUMBER --repo Metacomet-Technologies/factory --json body`). Compare
the saved journal's `receipt`, `receipt-exists` or `receipt-skipped` entries with
the actual issue comments. `lastTag` means the job finished its delivery loop,
not that every issue was in Deploying or received a comment. Record which
issues received the exact v0.2.10 `health=fail rollback=none` receipt and which
were skipped. Missing promised delivery needs separate investigation, not a
forged pass receipt or a replay by editing the ledger.

Record the operator decision with the recovery evidence: **retain v0.2.10 as a
failed-but-handled attempt with no deployment changes; resume at the next
published tag in order.** Keep `lastTag=v0.2.10` and its failed meter record
untouched. The corrected machinery does not silently reattempt handled tags.
The failed record is not a healthy baseline; subsequent releases evaluate the
real healthy running SHA and retry missing component inputs. If an exact
v0.2.10 replay is required, stop for a separately reviewed recovery plan.

Do not clear an escalation or mark v0.2.10's issues Done from the ledger or a
later unrelated receipt. Later receipts cover their own release's issues;
earlier issues still need their own evidence-based reconciliation after health
is confirmed. Issue changes require separate operator authorization.

## 5. Resume, confirm deployment and receipts, then re-enable the timer

Starting this service deploys the pending backlog, not only one canary. Approve
that effect first, including migrations and their backup/rollback prerequisites.

```sh
gpu-ssh 'sudo systemctl reset-failed factory-deploy.service; sudo systemctl start factory-deploy.service'
gpu-ssh 'journalctl -u factory-deploy --since -1h -o cat; systemctl show factory-deploy.service -p Result -p ExecMainStatus'
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
cd /home/agent/work/factory
git rev-parse HEAD
git status --porcelain
git -C /home/agent/.local/state/factory-odd/source rev-parse HEAD
git -C /home/agent/.local/state/factory-odd/source status --porcelain
jq '{lastTag, components, inFlight, receipt}' /home/agent/.local/state/factory-odd/deploy.json
AGENT
```

Require the tools HEAD to remain `FIX_SHA`, both checkouts clean, no
`MODULE_NOT_FOUND`, and the pending log to start with the oldest tag after
v0.2.10 (not the newest published tag). Match each plan/install/probe/rollback
to its ledger result. Repeat step 2: successful changed components must report
their deployed full SHA (or valid short prefix), clean and healthy. Check the
actual recipient issue comments against the journal receipts; no duplicates,
and no unexplained skips. A delivery error leaves `receipt` pending; rerun the
service after resolving the error to finish delivery without reinstalling.
A new handled failure exits nonzero and retains its failed record: investigate
before allowing the next tick, never edit `lastTag` to get past it.

Require `Result=success` and `ExecMainStatus=0` from a completed service run,
then verify the deployed tag against the target and #201. Components unchanged
by later tags can correctly run an earlier SHA; the API itself must contain
#201, not just the tools or `lastTag`.

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
RECOVERY_DIR=REPLACE_WITH_PRINTED_RECOVERY_DIRECTORY
state=/home/agent/.local/state/factory-odd
cd /home/agent/work/factory
test "$(git rev-parse HEAD)" = "$(jq -r .tools "$RECOVERY_DIR/target.json")"
test -z "$(git status --porcelain)"
jq -e '(.inFlight == null) and (.receipt == null) and ([.components[].health] | all(. == "pass"))' "$state/deploy.json"
tag=$(jq -er .lastTag "$state/deploy.json")
sha=$(git rev-parse --verify "refs/tags/$tag^{commit}")
git merge-base --is-ancestor "$(jq -r .sha "$RECOVERY_DIR/target.json")" "$sha"
test "$(git -C "$state/source" rev-parse HEAD)" = "$sha"
test -z "$(git -C "$state/source" status --porcelain)"
curl -fsS --max-time 10 http://127.0.0.1:8080/v1/health > "$RECOVERY_DIR/api-after.json"
jq -e '.status == "ok" and .git_dirty == false' "$RECOVERY_DIR/api-after.json"
api_sha=$(jq -er .git_sha "$RECOVERY_DIR/api-after.json")
git merge-base --is-ancestor dcc0b84e02c00cfa2d7ef76ce3a74542fdacacef "$api_sha"
printf 'Handled deployed tag: %s (%s); healthy API: %s\n' "$tag" "$sha" "$api_sha"
AGENT
```

Inspect `backup:status` in `GET /v1/alerts` and the API-readable
`/var/lib/factory-backup-status/status.json`; `/v1/health` does not expose backup
health. Correlate with the existing backup timer, log freshness and journal
([alert contract](../alerts.md)). A red backup status must be reconciled
on its own evidence; do not disable monitoring to obtain green health. Preserve
the final ledger, health responses, service result and actual issue receipts with
the recovery evidence. A no-op run or a green timer alone does not prove the
backlog or receipt delivery succeeded.

Once the backlog and receipts are accounted for:

```sh
gpu-ssh 'sudo systemctl enable --now factory-deploy.timer; systemctl is-enabled factory-deploy.timer; systemctl is-active factory-deploy.timer; systemctl list-timers --all factory-deploy.timer'
```

After at least two minutes, inspect `journalctl -u factory-deploy --since -5min
-o cat` and the ledger again. Confirm a subsequent timer invocation loads the
same tools and either reports no pending releases or processes the next release
normally. Timer `active` alone is not success. If recovery must stop, disable
the timer again and preserve state.

## 6. Roll back without restoring the broken runtime

First disable the timer as in step 1, wait for `MainPID=0`, and preserve a new
copy of the ledger and journal. Do not restore the pre-recovery ledger: it would
replay deployments and receipts. Do not check out v0.2.10 or the saved
`tools-before.sha` over the corrected tools. Keep `FIX_SHA` in place.

To remove the deploy machinery after the job has finished:

```sh
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-deploy.sh'
gpu-ssh 'systemctl list-timers --all factory-deploy.timer; systemctl show factory-deploy.service -p LoadState -p ActiveState -p MainPID'
```

This removes the units, not the ledger, downloads, source worktree or application
services. Reinstall later with `--install-only` from the same corrected tools;
never restore an old active timer pointing at missing code.

Application rollback is separate and requires the **actual complete snapshot**
printed for that component's failed/reverted install. A successful automatic
rollback needs a healthy re-probe; do not run it again merely because the receipt
is red. v0.2.10 had no snapshot and must not use any of these commands. For a
separately approved later rollback, run only the matching command, substituting
the inspected absolute snapshot path (not all three):

```sh
gpu-ssh 'sudo /usr/bin/bash /home/agent/work/factory/deploy/rollback-meter-v1.sh /var/backups/meter/REPLACE_WITH_ACTUAL_SNAPSHOT'
gpu-ssh 'sudo /usr/bin/bash /home/agent/work/factory/deploy/rollback-factory-api.sh /var/backups/factory-api/REPLACE_WITH_ACTUAL_SNAPSHOT'
gpu-ssh 'sudo /usr/bin/bash /home/agent/work/factory/deploy/rollback-kiosk.sh /var/backups/factory-kiosk/REPLACE_WITH_ACTUAL_SNAPSHOT'
```

Review each snapshot's DB migration/restore contract first; restoring old data
can lose newer writes. Never bypass an incomplete-snapshot or schema refusal.
Repeat step 2 and match each restored SHA with the snapshot's previous binary
and service state. Preserve and reconcile that manual rollback with the latest
ledger before any later resumption; leave the timer disabled until reviewed.
