# Reconcile the manually recovered v0.2.49 host

**Keep `factory-deploy.timer` paused.** This replaces the earlier blind-backlog
recovery instructions. Neither this document nor PR #203 authorizes host access,
deployment, ledger writes, receipt writes, publishing, merging or timer resumption.
Commands below are for Devon to run from the Mac with `gpu-ssh`, only after the
specific approval named in each section. Agents must not run them.

## Actual baseline and preserved recovery evidence

Devon manually installed verified immutable **v0.2.49**, source
`6c157fe65cb9e4c4e07d55548b4cd3f6f2253240` (PR #199), on 2026-10-25.
No agent accessed or changed the host. This is operator-reported acceptance,
not historical CI evidence or a claim that automation has recovered.

- `/home/agent/work/factory` is clean and detached at v0.2.49, **not current
  main**. No local changes were discarded. It contains neither #201 nor #203.
- The timer was stopped and confirmed inactive/dead throughout verification.
  The old service had failed with exit 1 because `scripts/odd/deploy.ts` was
  missing after the historical checkout. It was still boot-enabled: stopped
  is not disabled, and a reboot can reactivate it. Corrected `--install-only`
  must persistently disable it before recovery is considered safely paused.
- The ledger is **unchanged**: `lastTag=v0.2.10`, meter `health=fail`. That is a
  failed-but-handled preflight with no snapshot, not current meter health.
- Original ledger and installed deploy units:
  `/var/backups/factory-recovery/20261025T231919Z`.
- Verified downloads and verifier/inventory copies:
  `/home/agent/.local/state/factory-odd/recovery-v0.2.49.OQJGo1Eu`;
  assets in `assets/`, extracted kiosk in `kiosk/`. Anonymous verification said
  `complete: exact SHA, inventory and every digest verified`.
- Meter snapshot: `/var/backups/meter/20261025T232402.354793393Z.4w93jR`.
- API snapshot: `/var/backups/factory-api/20261025T232511.471622044Z.vLvf4i`.
  Private install log:
  `/var/backups/factory-recovery/20261025T231919Z/factory-api-install-20261025T232511Z.log`.
  Do not publish its fleet or production contents.
- Kiosk snapshot: `/var/backups/factory-kiosk/20261025T232610.784694875Z.QpszNR`.

Meter reported preflight mode=v2; API requests=v6, pricing=v1. No schema-version
upgrade was indicated. Meter's fresh archive checksum, restored-copy integrity/
counts and rollup checks passed. API exited 0 with health/pricing/fleet/service-user
checks passing. Kiosk's atomic install and GET `/` comparison passed. Ollama was
not restarted; kiosk needed no restart.

Three checks 20 seconds apart found all three components at the full v0.2.49
SHA, `git_dirty=false`; meter/API version=0.2.49 and status=ok. API expected and
observed meter OpenAPI fingerprints matched meter. Meter, API, Ollama and
amp-runner were active, and the deploy timer remained inactive. The refreshed
dashboard showed matching versions/SHAs and live data. A synthetic inference
through meter on the existing qwen2.5-coder:14b returned `FACTORY_OK` (36 input,
4 output tokens); the same request appeared in Live requests (45.9 seconds).
Preserve this evidence and the snapshots; do not rerun the installations as
part of reconciling deployment bookkeeping.

## Why neither replay nor an edited cursor is acceptable

The old deployer chose the oldest pending stable tag above `lastTag`, hence
v0.2.10 rather than the newest release. After manual recovery, replay beginning
at v0.2.11 would downgrade all three components: a reverse Git diff still lists
changed files. Runtime isolation alone did not prevent this.

The revised planner refuses a target older than, or divergent from, any known
installed/recorded baseline before an installer or new receipt can run. Dirty
or unresolvable reported identities are not treated as absent to evade that
guard. An approved manual baseline also supplies a minimum SHA, and unexpected
live drift below it or unavailable/degraded baseline evidence stops deployment
(an already recorded in-flight component retains its probe/rollback recovery).
Because factory-api also serves kiosk, an unreachable kiosk endpoint may be
deferred only while recovering a recorded in-flight API attempt. Usable identities
still undergo ancestry/clean checks. After API reinstall or rollback, the job
rechecks dependent health and replans before any other installation or success
receipt; a continued outage or unsafe identity stops forward progress.

`reconcile-manual v0.2.49` previews an explicit adoption. It fetches tags, verifies
a fresh immutable release bundle with the current verifier, then checks all
three live components three times 20 seconds apart. All must report the full SHA
and clean flag. Meter/API version, timestamp and input fingerprint must match the
verified manifest, health must be good and their OpenAPI contracts must agree.
Kiosk `/version.json` exposes only `build`, `git_sha` and `git_dirty`: its 64-digit
bundle hash must match `version.json` read from the freshly verified kiosk archive.
That archive's digest and member inventory are manifest-bound; its separate
`release-build.json` metadata is already checked by the bundle verifier. Do not
expect version/timestamp/input fields from the live kiosk endpoint. Mixed versions,
dirty tools/source, incompatible ledger identities, pending receipts/in-flight
installs, missing PR lookups and non-monotonic ancestry stop reconciliation.
It does not install, roll back, change services, write the ledger or contact Linear.
It writes only verification scratch files and its preview output.

With a separately reviewed `--approve PREVIEW_SHA256`, it repeats verification
and atomically **adds** `manualBaseline`: exact approved tag/SHA, tools commit,
manifest digest, a preserved copy of the original ledger, and a per-release issue
inventory. `lastTag`, failed component records and snapshots remain unchanged.
Changes to the ledger, tools, release/issue inventory or manifest invalidate the
approval. An interrupted acknowledgement can be retried with the same hash; it
does not rewrite an existing adoption. A second adoption needs a new reviewed
recovery design, not replacement of the first record.

This recorded adoption is an explicit no-replay floor, **not a historical success
receipt**. v0.2.10 remains `prior-attempt`; intervening releases are `not-replayed`;
v0.2.49 is `manual-install`. Every entry's requirements remain `unverified`.
Only a later real forward deployment and receipt delivery advance `lastTag`.

## Approval 1: install corrected machinery, without starting it

After PR #203 has separately passed review and been merged, approve its exact
merged tools commit. Pause any other operator changes. First confirm the timer
is inactive and the service has `MainPID=0`; do not interrupt an active installer.

```sh
gpu-ssh 'systemctl show factory-deploy.timer -p ActiveState -p SubState; systemctl show factory-deploy.service -p ActiveState -p MainPID'
```

Preserve a new copy without overwriting the original recovery evidence:

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
umask 0077
state=/home/agent/.local/state/factory-odd
exec 9>>"$state/deploy.lock"
flock -n 9
audit=$(mktemp -d "$state/reconciliation.XXXXXX")
test -s "$state/deploy.json"
python3 -m json.tool "$state/deploy.json" >/dev/null
cp -p "$state/deploy.json" "$audit/ledger-before.json"
sha256sum "$state/deploy.json" > "$audit/ledger-before.sha256"
git -C /home/agent/work/factory rev-parse HEAD > "$audit/tools-before.sha"
printf 'AUDIT_DIR=%s\n' "$audit"
AGENT
```

Keep that printed `AUDIT_DIR`. A missing/corrupt ledger is a stop, not permission
to bootstrap. Install the approved tools by Git checkout, never by copying files
over historical source or relaxing the clean-tree checks. This changes deployment
machinery, not the healthy running binaries or kiosk.

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
FIX_SHA=REPLACE_WITH_REVIEWED_MERGED_COMMIT
cd /home/agent/work/factory
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = 6c157fe65cb9e4c4e07d55548b4cd3f6f2253240
git fetch --quiet --tags origin
git merge-base --is-ancestor "$FIX_SHA" origin/main
git checkout --detach "$FIX_SHA"
test "$(git rev-parse HEAD)" = "$FIX_SHA"
test -z "$(git status --porcelain)"
scripts/env/check --env factory-gpu
AGENT
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/install-deploy.sh --install-only'
gpu-ssh 'bash -s' <<'CHECK'
set -euo pipefail
systemctl cat factory-deploy.service
systemctl show factory-deploy.timer -p UnitFileState -p ActiveState -p SubState
test "$(systemctl show factory-deploy.timer -p UnitFileState --value)" = disabled
test "$(systemctl show factory-deploy.timer -p ActiveState --value)" = inactive
CHECK
```

Require `UnitFileState=disabled` **and** `ActiveState=inactive`. The installer
snapshots prior unit files and enablement before disabling; do not restore old
enablement during reconciliation. Default installation still starts the job and
enables the timer, so do not use it here. If the tools were already updated,
inspect the exact HEAD and unit rather than bypassing the v0.2.49 precondition
or reinstalling blindly.

## Approval 2: preview, review every deferred issue, then adopt

Approve read-only service probes, GitHub reads and temporary verification
downloads first. Both preview and adoption must hold the job's existing lock.

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
umask 0077
AUDIT_DIR=REPLACE_WITH_PRINTED_AUDIT_DIRECTORY
state=/home/agent/.local/state/factory-odd
cd /home/agent/work/factory
sha256sum -c "$AUDIT_DIR/ledger-before.sha256"
flock -n "$state/deploy.lock" node scripts/odd/deploy.ts reconcile-manual v0.2.49 > "$AUDIT_DIR/preview.json"
cmp "$AUDIT_DIR/ledger-before.json" "$state/deploy.json"
jq '{tag,sha,toolsSha,manifestSha256,priorLedger,releases,approval}' "$AUDIT_DIR/preview.json"
AGENT
```

Review all `releases[].issues`, **including v0.2.10's failed attempt**. Ancestry
establishes source containment only: it cannot establish Done means, prove a
change was not reverted, install disabled components on another host, apply a
migration, or prove operational behavior. For each issue, read its current
Isolation/Build/Done means/Evidence and latest merge, check the deployed source
still implements it, and identify which evidence can be rerun on v0.2.49.
Evidence requiring #201, #203, another host or an undeployed installer remains
outstanding. Unmapped PRs, incomplete issue references and skipped earlier
receipts require investigation; an empty list is not proof of completion.

Before approving adoption, explicitly accept and assign the deferred verification
work in this inventory. Keep findings in the private audit record. Approve any
live evidence execution separately. Do not turn ancestry or the synthetic
inference alone into blanket acceptance. Preserve the original red receipt and
escalation until its actual requirements are checked.

Only after Devon approves **this exact preview hash and its no-replay floor**:

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'AGENT'
set -euo pipefail
umask 0077
AUDIT_DIR=REPLACE_WITH_PRINTED_AUDIT_DIRECTORY
APPROVAL=REPLACE_WITH_REVIEWED_PREVIEW_SHA256
state=/home/agent/.local/state/factory-odd
cd /home/agent/work/factory
flock -n "$state/deploy.lock" node scripts/odd/deploy.ts reconcile-manual v0.2.49 --approve "$APPROVAL" > "$AUDIT_DIR/adoption.json"
jq -e --arg approval "$APPROVAL" '.lastTag == "v0.2.10" and .components.meter.health == "fail" and .manualBaseline.tag == "v0.2.49" and .manualBaseline.approval == $approval' "$state/deploy.json"
jq -e --slurpfile before "$AUDIT_DIR/ledger-before.json" '.manualBaseline.priorLedger == $before[0] and (del(.manualBaseline) == $before[0])' "$state/deploy.json"
AGENT
```

This is the sole approved ledger mutation in this step: adding the bound adoption
record. No hand-edit, reset or cursor rewrite. The command makes no Linear writes.
Any eventual issue comment, status change or deploy/verify receipt needs explicit
per-issue approval, names the **actual deployed v0.2.49 SHA**, and cites that
issue's executed evidence. Never emit `odd-deploy health=pass` for an uninstalled
historical SHA. Machine receipts trigger the control plane; their effects must
be included in that approval. Adoption itself leaves requirements unverified.

## Forward deployment remains a separate approval

Do not start the service or enable the timer merely because adoption passed.
Historical exact-SHA CI/publishing recovery is independently owned by
[the release recovery thread](https://ampcode.com/threads/T-d71886d4-9b1b-40d6-a00f-7ce0ea1e0cad).
Its historical CI gate is unresolved; #202's green CI and this manual acceptance
cannot replace #201's failed historical CI. This runbook does not rerun CI,
change publisher policy, move tags or skip unpublished commits.

After that blocker and the separate merge/publication steps are resolved, select
the newest published immutable stable release whose Git commit contains **both**
the reviewed #203 merge and #201 (`dcc0b84e02c00cfa2d7ef76ce3a74542fdacacef`).
Verify its exact bundle using `release.py verify --anonymous` with its source
inventory as described in [release verification](../release.md). Do not use the
predicted v0.2.51 number as evidence of publication. v0.2.49 contains neither fix.

Obtain explicit approval for the forward backlog above v0.2.49, its migrations,
backups/rollback prerequisites, normal receipt writes and deferred issue handling.
The service processes **all** newer published pending tags, not just one canary.
Only then may Devon authorize a service start. The first pending tag must be
above the adopted baseline; any attempt at v0.2.11 or another older target is a
stop. No resume commands are supplied here to execute prematurely.

Acceptance before separately enabling the timer:

- A completed `factory-deploy.service` run with `Result=success`,
  `ExecMainStatus=0`; unchanged clean tools HEAD at the approved commit.
- Ledger `lastTag` and the clean source worktree identify the handled forward
  release; no pending `inFlight` or `receipt`. The `manualBaseline.priorLedger`
  still contains the original failed attempt, and its deferred issues remain
  accounted for independently.
- Three healthy identity/contract probes 20 seconds apart. Components unchanged
  in a later release may run an older SHA, but no component may fall below the
  adopted floor; the healthy API must contain #201. Inspect `backup:status` via
  `/v1/alerts` and its status file, not `/v1/health` alone.
- Match actual issue comments to forward receipts. Retry delivery after resolving
  errors without reinstalling; do not forge success or edit delivery state.
- After explicit timer approval, confirm a subsequent scheduled run succeeds.
  Timer `active` alone is not deployment/receipt evidence.

## Rollback: preserve tools and evidence, do not restore an old ledger

If any step fails, keep the timer paused, preserve the new journal/ledger and
investigate. A failed preview/adoption does not require an application rollback.
Do not restore `ledger-before.json` after adoption or forward work: that can
replay deployments and receipts. Do not checkout an old release over fixed tools.

To remove corrected timer machinery only, after separate approval and after
confirming the service has finished (`MainPID=0`):

```sh
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-deploy.sh'
```

This retains the ledger, downloads, source worktree and running applications.
Reinstallation later must use `--install-only` and a newly reviewed plan.

The v0.2.49 application snapshots above are real but would restore the versions
**before** manual recovery. Do not run them merely because v0.2.10 remains red.
For a separately approved application rollback, use only its matching script
(`rollback-meter-v1.sh`, `rollback-factory-api.sh`, `rollback-kiosk.sh`) from the
fixed tools checkout, with the exact inspected complete snapshot. Review DB
restore/data-loss consequences first, and never bypass schema/snapshot refusal.
Verify the restored SHA and service health. A rollback below the adopted floor
intentionally blocks automatic forward deployment until a new recovery plan is
approved; leave the timer paused and preserve all ledger history.
