# Exact-SHA immutable releases (MET-157)

This publisher contributes MET-157. It does not deploy anything. Devon owns
workflow/security approval, merge, activation and the first merged canary.
MET-158 must independently verify a release before proposing any installation.
The enabled auto-deploy allowlist is empty. Shipping an installer is not
authorization to run it.

## Immutability relies on organization/repository enforcement

Devon approved relying on the organization and repository immutable-release
settings. The publisher does not query policy before reservation or publication;
no Administration:read credential or additional GitHub App is required. Owners
must keep enforcement enabled. This contract cannot prevent publication if
someone disables enforcement beforehand.

The publisher still requires `immutable: true` on the published release and
validates its complete receipt, assets and tag. A missing or false immutable flag
fails verification after publication; it cannot undo that publication. Preserve
remote state and investigate rather than deleting, replacing or retagging it.
This policy decision does not itself prove the live canary succeeded.

## Publishing credential

The publish step requires the repository Actions secret `FACTORY_RELEASE_TOKEN`.
Devon provisions an expiring fine-grained personal access token restricted to
`Metacomet-Technologies/factory`, with Contents and Workflows read/write,
Actions and Pull requests read, and the mandatory Metadata read permission.
No Administration permission is needed. Store the token directly in GitHub's
Actions secret form, never in an issue, thread, checkout or command argument.
Approve this credential separately before merging the workflow change; merging
activates publication and the existing host deploy timer consumes new releases.

The built-in `GITHUB_TOKEN` cannot request Workflows write in workflow YAML.
GitHub can require that permission when creating a tag for an older commit whose
workflow files differ from current main, even with Contents write. This matches
the historical `POST git/refs` 403: the first unreleased commit's `ci.yml` differs
from main. See [GitHub's explanation](https://github.com/cli/cli/issues/9514).
Do not work around the denial by tagging current main or skipping old SHAs.
The publish step fails explicitly if its secret is missing; there is no fallback
to the built-in token or automatic write retry. Rotate the secret before expiry.

Only the trusted publish step receives this credential. Builds, dependency
installation, sandbox runs, checkout and artifact download continue using the
read-only built-in token. Existing tag, draft, asset and immutable-receipt
validation remains unchanged. Provisioning the secret does not prove the repair:
confirm exact-SHA tag creation and immutable publication on the next approved run.

## Source version and release identity are different

`VERSION`, workspace package versions and `kiosk/package.json` remain coherent
checked-in source versions. Their equality assertions are never disabled.
OpenAPI and CLI/package versions continue to describe that source version.

One build-only override, `FACTORY_RELEASE_VERSION=MAJOR.MINOR.PATCH`, sets the
release identity reported by meter/API health and the kiosk. It accepts only
stable numeric SemVer, no leading zeroes, suffixes, whitespace or components
above u32, and never a version below source VERSION. Normal builds without the
override retain their source version, short Git SHA and wall-clock build time.
Release builds use the full Git SHA and commit timestamp as reproducible build
metadata. Cargo tracks override changes/unsetting; Vite evaluates it each build.
The release timestamp is therefore source commit time, not upload time.

## Eligibility, ordering and recovery

The activation baseline is recorded in `deploy/components.json`.
Walk first-parent `origin/main` after that baseline. Merges before the inventory
first exists are preactivation and ineligible; removing it afterward fails.
Every later first-parent commit needs one verified merged PR whose exact merge
SHA and base repository/main match. Rebase intermediates without their own
verifiable merge identity stop reconciliation; never infer approval from ancestry
alone. Both PR association and detail reads use REST API `2022-11-28`,
which retains `merge_commit_sha`; other requests use `2026-03-10`. Missing or
mismatched merge evidence still fails closed. Bump intent comes only from merged
PR labels: `bump:minor`, `bump:major`, or optional `bump:patch`; no label means
patch. Multiple/unknown bump labels fail.

Allocate above the greatest valid existing vMAJOR.MINOR.PATCH tag and source
VERSION floor. Non-v tags are unrelated; malformed v tags fail. An annotated tag
reserves repository, source SHA/version, bump, PR and successful CI run/attempt.
One SHA has one version. Reservations are never moved, overwritten or skipped.
Future tag reservations ahead of a missing eligible SHA fail rather than invert
release order. Changing intent on an incomplete reservation requires investigation.

The publisher requires successful exact-SHA `push`/`main` CI from `ci.yml`, with
successful `rust`, `kiosk`, `scripts` and `sandbox` jobs. PR test-merge checks,
skipped jobs, older successful runs hiding newer failures and partial evidence
do not qualify. Existing merge-required checks are unchanged; publishing is not
a merge check. A pending predecessor stops planning at that SHA, prints
`waiting for CI on <sha> run <id>` and exits successfully without reserving or
publishing it. This covers queued, in-progress, waiting, requested and pending
runs, including a CI rerun starting between build and publication. Missing CI,
mismatched evidence, missing required jobs and completed failed/cancelled runs
still fail with actionable errors; none permit skipping to a later SHA.
Main pushes run CI in one concurrency group per SHA, so a later merge no longer
cancels an earlier SHA's CI. A failed or older cancelled run still needs Devon to
inspect and rerun the printed exact-SHA CI run (`gh run rerun RUN_ID --repo
Metacomet-Technologies/factory`) when appropriate, then reconcile. The publisher has actions:read, not CI-rerun power.

Main updates, successful or failed main CI completion events, and manual reconcile
are wakeups. One fixed non-cancelling concurrency group serializes publication.
Each run walks history; replaced pending workflow events cannot drop eligible
SHAs. Completed history is checked against its immutable manifest receipt and
GitHub asset sizes/digests without rebuilding or downloading all old binaries.
CI retention does not invalidate an already completed immutable release.

The read-only job takes at most the first five pending plans, builds exact-SHA
bundles and verifies them before uploading `plans.json` and the bundles through
a SHA-pinned artifact action. This bounds each build instead of rebuilding the
entire backlog before any release can publish. A failed CI beyond the batch
does not prevent earlier eligible releases from publishing, but the next batch
still stops at that failed predecessor. No plans means no publish job.
The dependent publish job downloads only this run's artifact and recomputes
the first five pending plans from GitHub/main. The downloaded plans must fit
the batch limit and equal the first plans of the current batch, in order (an
empty handoff must match exactly). `planned()` walks first-parent history and
each plan depends only on earlier history and existing tags, so an eligible
merge during the build only appends plans. The publisher publishes just the
downloaded plans, reports any newer plans seen within the current batch to
stderr and leaves later SHAs unreserved. Any other difference, including a changed plan inside the
prefix, an extra downloaded plan or a current list starting later because a
downloaded release already completed, requires a fresh build; pending CI instead
waits without writes. It verifies every bundle and its plan before the first
remote write.
Its builder callback only copies those verified files, never executes them.

After successful non-empty publication, a separate continuation job dispatches
`release.yml` on main in the same concurrency group, carrying forward any
explicit recovery inputs. It uses the built-in token with only Actions write,
has no checkout and never receives the publishing credential. The build and
publish jobs retain Actions read. The next run skips completed releases and
builds the next batch, even without another push or CI event. Once drained,
one no-op run finds no plans and stops. A pending-CI wait or failed publication
does not dispatch another run. A failed continuation dispatch needs inspection
and an approved reconcile; it never undoes already published releases.

Crash recovery is monotonic: build and verify, reserve tag, create draft, upload manifest and
six assets, download and validate all assets, then publish with a manifest digest
receipt. Every upload inspects existing assets first. There is no automatic write
retry: lost write acknowledgements stop the attempt; rerunning inspects remote
state before another write. Authenticated GET reads (never writes, uploads or
4xx responses) retry an `HTTP 5xx` response after a short fixed pause, at most
three attempts in total; a persistent failure still stops with "inspect remote
state before retry". Anonymous verification reads do not retry. A reserved
tag absent from release listings now requires explicit operator recovery, including
a crash after tag reservation but before draft creation. Identical
content is reused; conflicting, duplicate or starter/partial assets stop with the
draft retained. Never delete a conflicting asset, use `--clobber`, force a tag,
recycle a release version, or hide a failure by releasing the next SHA.

### Dormant historical backup-group recovery

`ci-recovery.yml` is a separate acceptance policy, **not historical push/main CI**.
It supports only source `dcc0b84e02c00cfa2d7ef76ce3a74542fdacacef`, original failed
push/main run `40227924006` attempt 1, and repair `dcc0b84-backup-group-v1`.
That source's offsite test assumes the `factory-backup` group exists; #202 repairs
newer source, but cannot change this historical run. An unchanged ordinary rerun
on the same standard runner does not repair the missing fixture. No tag, check
name, manifest success flag, source overlay or test assertion substitutes for CI.

Support ships with `scripts/release/ci-recoveries.json` equal to `{}`. Normal
exact-SHA push/main eligibility is unchanged. An empty record cannot authorize
recovery, and neither support merge nor a successful recovery run fills it.
There are three distinct future approvals:

1. **Support merge:** review/merge this dormant policy and workflow. Commit,
   push, PR creation and merge need their own delivery authorization. The
   existing publisher may wake up, but still stops at the failed predecessor.
2. **Hosted execution:** Devon separately authorizes and dispatches Historical
   CI recovery on `main`, supplying its reviewed full tip SHA as
   `expected_controller`. A race moving main fails the controller check; inspect
   and approve a new dispatch, rather than silently testing another revision.
   Dispatch does not publish, write approval records or invoke host operations.
3. **Evidence approval/publication activation:** only after all tests finish,
   review the live evidence and open a PR changing **only** the record file.
   Devon must merge it himself; the numeric GitHub identity is checked. This
   merge authorizes consumption of precisely that run/attempt and wakes the
   existing publisher. It is publication activation, not a harmless evidence
   upload. Coordinate it separately from host/deployer reconciliation (#203).

The workflow checks out trusted controller code and the fixed historical source
in separate directories, with checkout credentials disabled and only contents:read.
It has no publishing secret. All four release-required jobs (`rust`, `kiosk`,
`scripts`, `sandbox`) repeat that source's recipes, action/tool/dependency pins
and runner families. The Mac `client` job is not release-required. Build caches
are omitted and job caps are 30 minutes. Tool versions remain in normal job
logs; receipts record the hosted image/version. Runner images and apt repositories
are rolling inputs, not a claim of a bit-reproducible historical environment.

Only the disposable scripts runner receives the added group fixture. It creates
a real system group, adds the runner user, then launches the **unchanged** pinned
offsite command through native `setpriv --init-groups`, dropping to the original
non-root UID/GID, removing capabilities, and setting no-new-privileges. Merely
editing `/etc/group` would not update the existing process's supplementary groups.
The wrapper checks actual process membership and records it after test success;
backup code still performs real group ownership and 0640 installation. Source
HEAD/tree, index and tracked worktree changes are checked before and after tests.
No production backup configuration, owner, permissions or assertion is changed.
Provisioning and the complete hosted lane require the separately approved live
execution; local fixture tests do not establish their success.

The evidence-only PR must use actual GitHub API results, not guessed IDs. Its
closed-schema record contains `source_sha`, `repair`, `workflow_sha`, numeric
`workflow_id`, `run_id`, `attempt`, `approval_pr`, and exactly four `jobs` entries.
Each job entry holds its `job_id`, `artifact_id`, `artifact_sha256` (ZIP digest,
without the `sha256:` prefix), and the downloaded `receipt` object unchanged.
Each receipt binds repository ID, source SHA/tree, repair, controller SHA,
run/attempt, job, non-root UID/GID, image/version and scripts-only offsite
credentials. The workflow uploads one `receipt.json` per job under the name
`ci-recovery-RUN-ATTEMPT-JOB`, without overwrite, with 30-day retention.
Open the PR only after execution; use that PR's real number in its final record.
There is deliberately no command to create an approval or accept a generic flag.

Before planning, reservation and final publication, the publisher independently
reads GitHub's run, attempt, jobs/steps, artifacts, approval PR and main policy.
It requires the fixed original failure, same-repository main dispatch by Devon,
exact successful required steps in order, and one complete attempt. GitHub run
`head_sha` is the **controller**, not the tested source; the pinned workflow,
source checks and receipts supply that separate binding. GitHub artifact metadata
has no attempt field, so artifact ID/name, digest, receipt, originating run and
creation/update interval within the approved job are checked together. Bounded
single-file ZIP parsing does not extract or execute downloaded content.

The controller must be on first-parent main after the source, with an empty
approval file. Its workflow/helper bytes must match the trusted publisher's
checkout. The later evidence-only merge must be on first-parent main, match the
current/local record, and follow all job completions. Missing/deleted/replaced/
expired artifacts, failed/skipped/missing steps, mixed attempts, another actor,
changed approval/controller, and contradictory API evidence stop acceptance.
The newest recovery run wins: a pending run waits; a newer failed run or attempt
invalidates older approval. No automatic rerun or dispatch is performed.

Recovery adds typed `historical-ci-recovery-v1` provenance to schema-1 reservation
and manifest evidence, retaining both original failure and approved dispatch
identities. Older manifests need no recovery field; historical packaging already
preserves the whole reservation. The reservation pins recovery evidence immutably.
An interrupted publication may reuse identical artifacts/evidence, but cannot
replace its run, attempt or approval. Preserve tags/drafts on any mismatch.
If evidence expires or is superseded **after reservation**, stop for a separately
reviewed recovery; this implementation intentionally has no replacement escape.
Completed immutable releases remain verifiable without retained CI artifacts.

Before reservation, a failed/expired recovery can be replaced only by separately
authorized execution of **all jobs** and a new evidence-only approval; partial-job
reruns cannot mix previous successes into a new attempt. If an approved record
already exists, rerunning the original controller uses that run's frozen revision;
a new main dispatch requires the support/evidence separation to be restored first.
Approve promptly within retention and avoid superseding runs during publication.
The publisher resumes at the same historical SHA, then handles each successor in
first-parent order under its own normal gates. It never skips the predecessor.
A future environment failure needs its own diagnosis and reviewed source-specific
support change plus fresh execution/approval, preserving validation of already
published provenance, not another arbitrary record here.

### Recovering a draft omitted from release listings

A successful create response supplies the release ID. The publisher validates its
positive numeric ID, exact tag and draft state, retains that ID, and refreshes the
release and its assets directly by ID before uploading. It never rediscovers a
newly created draft through the release collection. Direct-read denial or an
identity mismatch stops without another create or any upload. The acknowledged
ID is printed for operator recovery; a lost POST response still requires inspection.

For an existing draft that the collection omits, obtain its numeric ID from an
owner-visible release/API record and confirm its intended tag. After approved
activation, a manual workflow run may supply `resume_release` as
`vMAJOR.MINOR.PATCH=NUMERIC_ID` (leave the verification-only `tag` input empty).
An automatic event has no recovery intent and fails closed on any previously
reserved tag whose release is absent from the collection. Therefore merging this
fix does not race a manual recovery run into another create attempt for that tag.
New tags reserved in the current publication call can still create their first draft.

If owner inspection confirms a reserved tag genuinely has no release, including
hidden drafts, `create_reserved_releases` accepts a comma-separated list of those
exact tags. This is explicit creation intent, not a way to recover an existing
draft. Each tag needs its own inspection and intent; never include a tag with a
known draft. The equivalent CLI flag is `--create-reserved-release TAG`, repeated
for each inspected reservation. Release-list access errors still stop the run,
and all exact reservation checks remain mandatory. Collection absence alone
cannot establish that creation is safe: owner inspection is a prerequisite.
Without intent for every release-less reservation, planning stops before any
build or publication, even when a prior draft's ID was supplied. This includes
reservations left by a crash immediately after creating a tag reference.

The read-only build job parses the tag/ID as an untrusted planning hint and checks
the exact annotated reservation and CI evidence. It does not fetch the draft ID
or its assets: GitHub may hide drafts from the contents:read credential. If the
collection explicitly identifies that tag as non-draft, the build job may read and
verify that public completed release, making a completed recovery retry a no-op.
An omitted release is never assumed complete. If it completed but remains hidden
from the read-only job, the downloaded plans are no longer a prefix of the current
plans, so the publisher rejects them without writes;
inspect visibility before retrying; completed-history verification needs a
publicly readable release. The hint
only permits planning that reserved tag; it is never permission to create a draft.
The publish job must independently read the ID using its existing contents:write
credential and validate the exact ID, tag and state before recomputing plans or
performing any write. Verified IDs remain pinned across collection reads. The
publish job then requires the downloaded plans to be a prefix of the recomputed
plans and verifies every bundle before publication. No new credential or permission is
needed or requested. If the publish credential cannot read the release or assets,
recovery stops; owner-browser visibility alone does not prove workflow access.

This hint selects an existing identity, not permission to change tags, replace
assets or skip history. Full plan/CI, downloaded bundle, byte-for-byte existing
asset and final immutable-receipt checks still apply. A completed release is
verified without mutation on retry. Never guess an ID from a tag, infer creation
time from the UI's drafted timestamp, delete the draft, or retry creation because
a collection lookup did not show it. Recovery still reconciles all eligible
history and may publish subsequent reserved versions; it is not a single-tag
publication mode. Existing tags and drafts must be preserved while investigating.

### Baseline moves (MET-266)

The baseline only moves forward, by a PR that changes nothing else in
`deploy/components.json` and sets it to the exact first-parent main tip the PR
merges onto. The merge commit is then the first eligible SHA. Any later commit
still carrying the old value stops planning with `activation baseline changed`,
so a stale move fails closed instead of skipping. Existing tags and releases are
never rewritten: SHAs before the baseline are not planned, and the next tag is
still allocated above the highest existing tag.

2026-10-24: the baseline moved from `95a1d3beac77e9503cc0d11bff019eb76aa33b67`
to `cfbfacf3b1e5327bc34b67b0a05fc9f3250baed0` (MET-206's merge, the main tip MET-266
merges onto), by Devon's decision. v0.2.0–v0.2.3 are
unchanged. The first-parent SHAs after v0.2.3 (`cccac737d6cd032e690f769ae64fe9400efc96ae`)
through the new baseline are never released. Concurrent main CI cancelled 11 of
them and 2 failed on flakes (MET-265), and exact-SHA builds from `4475aa8`
onward cannot package because their own inventory omits the devices units
(MET-240). MET-240's merge `d24539c` and the merges after it (`89480f4`,
`cfbfacf`) can package, but they carry the old baseline, so they are skipped
too. Merging MET-266 publishes its merge commit as the next patch release once
that commit's CI succeeds.

## Build and consumer contracts

`scripts/release/build.sh FULL_SHA PLAN_JSON OUTPUT_DIRECTORY` requires a clean,
fresh disposable checkout at the exact SHA. The publisher clones committed source
without changing its own checkout. Rust 1.99.0 uses locked dependencies; each SHA's
exact Node/Bun pins and Vite+ 1.1.0 are installed outside source. Rust paths and
archive metadata are normalized. Any byte difference on retry fails rather than
replacing an uploaded asset; OS/compiler system-library changes may require human
recovery. The source is never rewritten or bumped. Builds require Linux x86_64
and working Bubblewrap namespaces.

Cargo output lives in `.amp/in/cargo-target`, a sibling of the deleted checkout,
and is reused by every plan in a run and across runs through `actions/cache` in
the read-only build job only. The key is
`release-target-v2-<os>-<arch>-<hash of rust-toolchain.toml>-<hash of Cargo.lock>`
and the only restore key is that key through the toolchain segment, so a changed
`Cargo.lock` restores the same toolchain's output and a toolchain change starts
cold. v1 hashed both files together, so its fallback could never match. Reuse is
only a speed path: a cached artifact that changed any byte would still be refused
by the immutable-asset comparison on retry.

The credential boundary is job-level separation, not environment filtering.
All dependency installation, builds and sandbox execution run in a job with
contents:read, actions:read and pull-requests:read. The dependent publication job
also has a read-only built-in token; only its publish step receives
`FACTORY_RELEASE_TOKEN` with the permissions listed above. It installs no tools
and executes no repository code except trusted main `release.py`. Checkout and
artifact actions are SHA-pinned. Downloaded bundles remain data, outside the
trusted checkout. Publication relies on organization/repository immutability
enforcement and verifies `immutable: true` afterward.

The existing synthetic sandbox validates real meter/API health. Kiosk emitted JS
must contain the allocated identity; its generated receipt is included in the
archive. Source-clean status is checked before and after building. Pricing and
UPS-control lack equivalent version interfaces and remain checksum/manifest-bound.
No real database, installer, production endpoint or power operation is used.

Schema 1 manifest includes the repository, full SHA, source/release versions,
tag, bump and reservation evidence; complete component/target/installer/health/
rollback policy; each artifact's size and SHA-256; per-component tracked-source
fingerprints; embedded health/build identities; and every archive member's digest.
The meter/API/kiosk inputs fingerprints retain their existing narrower build-input
algorithm; component fingerprints additionally cover declared deployment inputs.
Deployment packaging reads tracked `deploy/` and `scripts/` files from the same
checkout only. Untracked runtime databases and credentials are never inputs.
UPS audit migrations, power control and trusted identity remain human-only;
UPS rollback must not restore or delete the audit database.

Consumer acceptance requires a trusted expected SHA and inventory from that
reviewed SHA, a non-draft immutable GitHub release, matching tag reservation and
completion receipt, exactly the full artifact set, all sizes/digests, complete
archive inventories and safe regular entries. Links, devices, traversal, duplicate
names, special mode bits and excessive archive sizes fail before extraction.
The verifier never extracts or executes an installer. A release title, `latest`,
manifest state alone, or locally fabricated publication JSON is not authorization.
`--publication` is only for a separately trusted saved API response/offline fixtures.

## Checks without live publication

From the assigned feature worktree, run the fixture tests, then commit reviewed
source before the real build fixture so its SHA and clean identity are meaningful:

```sh
python3 scripts/release/test-release.py
bash -n scripts/release/build.sh
shellcheck -x scripts/release/build.sh
actionlint .github/workflows/release.yml .github/workflows/ci.yml
python3 scripts/release/test-release.py --build-fixture .amp/in/release-fixture
```

The second command mode builds all real artifacts and uses only FakeGitHub for
publication, prints complete verification, then rejects tampered and incomplete
controls. Output stays local. Normal Rust/kiosk/workspace CI runs without the
override; override tests use an isolated generated Cargo/TypeScript fixture.

Cache byte identity (MET-368), from a committed checkout:

```sh
python3 -B scripts/release/prove-cache.py --sha "$(git rev-parse HEAD)" --parent "$(git rev-parse HEAD^)"
python3 -B scripts/release/prove-cache.py --release-run-evidence
```

The first command clones disposable checkouts at one path and runs build.sh's
own `RUSTUP_TOOLCHAIN`, `RUSTFLAGS` and `cargo build` lines with one fixed
`FACTORY_RELEASE_VERSION` (default: the target's `VERSION`; build time is the
commit time). It builds the target warm (parent first), cold, and seeded by the
commit before the last `Cargo.lock` change (same toolchain, override with
`--seed`), then prints each build's elapsed time and the SHA-256 of meter,
factory-api, pricing and factory-ups-control. It exits nonzero on any byte
difference, on meter/factory-api `--build-info` that is not the exact SHA, fixed
version, clean state and commit time, or on a parent/seed SHA embedded in any
binary. Pricing and UPS control embed no release identity. It needs `ld.lld` on
PATH. Nothing is published, dispatched or deployed.

The second command uses authenticated `gh` reads only. It finds the first main
commit whose `release.yml` has the v2 key, then the first completed push or
`workflow_run` release run from that commit onward whose build job built at least
two plans. It prints the run URL and ID, every plan's tag, SHA, wall time and cargo
`Finished` lines from the job log, then runs authenticated `release.py verify` on
the first plan's bundle. Until such a run occurs naturally it exits nonzero with
"evidence pending"; never dispatch or rerun one to produce it. MET-331's
no-cross-run-cache design is superseded: Devon may close it once both commands'
output (a passing identity proof and a verified multi-plan run) is recorded on
MET-368. This tooling never changes MET-331.

## Operator handoff from Mac

No host installer or service restart applies to the publisher. Merging this fix
into main activates automatic release reconciliation and publication:
`.github/workflows/release.yml` is already active on every push to main and
each main CI completion. There is no separate approval
step after merge. Devon must explicitly approve the merge as activation of live
publication, including pending eligible history, before it proceeds. Publication
still requires successful exact-SHA main CI, a verified build and all existing
publication checks; a merge does not guarantee those checks succeed. It does not
authorize deployment.

Merging PR #85 starts reconciliation immediately for all eligible first-parent
SHAs after the activation baseline:
first `5c17159bbd397c669ccce425511398ad1e760c51`, then the PR #85 merge commit
once its exact-SHA CI succeeds. This reconciliation publishes live immutable
releases with no further approval step. **The merge is the activation and must
be Devon's own action.**

Manual reconciliation is optional recovery, not an activation or approval gate.
After that approval and merge, Devon can request a manual reconcile/retry from Mac:

```sh
gpu-ssh "sudo -u agent bash -lc 'cd /home/agent/work/factory && gh workflow run release.yml --repo Metacomet-Technologies/factory --ref main'"
```

Emergency rollback of publisher activation disables future workflow starts:

```sh
gpu-ssh "sudo -u agent bash -lc 'cd /home/agent/work/factory && gh workflow disable release.yml --repo Metacomet-Technologies/factory'"
```

Disabling does not cancel an in-flight publication. Inspect `gh run list --workflow
release.yml --repo Metacomet-Technologies/factory` and cancel the identified run
with `gh run cancel RUN_ID --repo Metacomet-Technologies/factory` if needed. Then
inspect any reserved tag/draft; never assume cancellation undid a completed write.
Rollback source through a reviewed revert PR, not by rewriting immutable releases.
No console command applies because this feature changes no console service.

After the first eligible merged canary, record the exact merged SHA, allocated tag
and successful anonymous download/verification from factory-gpu. Using the trusted
inventory from that SHA and a new empty destination:

```sh
git show "$EXPECTED_SHA:deploy/components.json" > .amp/in/canary-inventory.json
python3 scripts/release/release.py verify --anonymous --tag "$RELEASE_TAG" --sha "$EXPECTED_SHA" \
  --inventory .amp/in/canary-inventory.json --directory .amp/in/canary-download
```

A nonexistent requested tag prints `tag not found`. Do not mark MET-157 finished
until this live canary and anonymous verification succeed. Local fixtures do not
prove GitHub token access, native immutability enforcement, or public downloads.

## Automatic host deploy (MET-280)

`factory-deploy.timer` on factory-gpu runs `scripts/odd/deploy.ts` as `agent`
every two minutes (`deploy/factory-deploy.service`, `flock` so runs never
overlap, 30 minute cap). The job reads every page of the GitHub releases API,
excludes drafts/prereleases, and verifies stable tags newer than the ledger's
`lastTag` oldest first with `release.py verify`, using the existing authenticated
`gh api` transport. Manual reconciliation uses the same transport; neither path
falls back to anonymous access on failure. This avoids exhausting GitHub's
60-request/hour anonymous quota as annotated release tags accumulate, without
new credentials or privileges. It detaches
`~/.local/state/factory-odd/source` at the release SHA, and installs each enabled
component whose sources or installer changed since the SHA the host already
runs: `meter`, `factory-api`, `kiosk`, in that order, through the
sudoers allowlist (`deploy/sudoers/README.md`). Three health probes 20 s apart
must report the release SHA; red runs the component's rollback script once and
re-probes, and the receipt names the snapshot only when the previous release is
back and healthy. The result is one `odd-deploy` receipt per issue the release closes
(`docs/odd/README.md` §7). The enabled set lives in `deploy.ts`, not in
`deploy/components.json`, because `release.py inventory_check` keeps
`enabled_auto_deploy` empty and eligibility human-only.

`/home/agent/work/factory` stays at the operator-approved tools commit. The job
never checks out a release there or moves its branch. Its deployer, release
verifier, installers, helpers and matching rollbacks therefore survive releases
that predate them. Only the separate source worktree moves; a source checkout
aliasing the tools' Git directory is refused before checkout or installation.
The allowlisted installer paths accept a leading `--source-checkout PATH`; default
manual invocations still use their own checkout. Artifact SHA and clean-tree
checks apply to that source, and meter/API units come from it. Full-SHA release
artifacts and short-SHA local builds retain the existing prefix-of-full-HEAD
check; historical installers are never executed or copied over the tools.
Inventory still comes from the exact release commit, and publication,
immutability, digest, archive and health verification are unchanged.

Tradeoff: deployment machinery upgrades are explicit operator maintenance, not
part of the release backlog. Pause the timer and wait for the service to finish
before updating the tools checkout. Keep it clean; never overlay current scripts
on a historical checkout or exclude them from Git's dirty-tree checks. Stable
installers may refuse a genuinely incompatible old binary/schema; investigate
that refusal rather than falling back to historical installers or relaxing checks.
Rollback arguments and snapshots are unchanged, including an interrupted old
attempt; do not discard its `inFlight` or `receipt` state.

Not deployed by the job: dispatcher, usage (until it has a rollback that
restores the previous timer; `rollback-usage.sh` removes the units), pricing,
ups-control, alerts, backup, reboot, nut, devices-agent. Those stay with Devon.

One-time install from the Mac, after the merge is on main and the host
checkout is at or past it (the script refuses any other root path or host):

```sh
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/install-deploy.sh'
```

The first run only records the newest published tag as `lastTag`; the next
release is the first automatic deploy. Expect that release to reinstall
meter, factory-api and kiosk once, because the host baselines predate
it.

Watch and recover:

```sh
gpu-ssh 'journalctl -u factory-deploy --since -1h -o cat'
gpu-ssh 'cat /home/agent/.local/state/factory-odd/deploy.json'
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-deploy.sh'   # removes the timer; ledger kept
```

A failed component stops the release and exits non-zero; `lastTag` still
advances and the failed record is not a baseline, so the next release is the
retry even when it touches only docs. A target older than or divergent from any
known live/healthy recorded baseline is refused before installation or a new
receipt; reverse Git diffs must never authorize a downgrade. A run killed
mid-component resumes that component after checking the whole plan; a run killed
while posting receipts posts the rest without redeploying, never twice to the
same issue. A failed `gh pr view` keeps the
release pending until the issues can be found. Deleting the ledger makes the next
run bootstrap again without deploying: never delete it as recovery. A dirty tools
or source checkout blocks deployment until reviewed, and the job logs it each tick.

GPU is now manually recovered to healthy immutable v0.2.49, with the original
failed-but-handled v0.2.10 ledger and timer paused. Do not replay the older backlog.
Use the separate [operator reconciliation procedure](odd/deployer-recovery.md).
`reconcile-manual TAG` freshly verifies the immutable bundle and all live component
identities/health, then previews a digest-bound adoption. Separate approval adds
`manualBaseline` without changing `lastTag` or erasing failed records. This explicit
no-replay floor preserves the old ledger and inventories deferred releases/issues
as requirements-unverified, with no historical success receipts or Linear writes.
Ancestry alone does not prove an issue's Done means. Forward deployment, deferred
issue verification/receipts and timer resumption each need operator approval.
`install-deploy.sh --install-only` snapshots prior enablement and installs the
units with the timer persistently disabled and inactive, without running the job
or changing the ledger. Both states are verified: merely stopping an enabled
timer would allow its boot trigger to bypass reconciliation approval.
`rollback-deploy.sh` still removes the units and retains all state, now including
the source worktree; it does not rewind application deployments or the ledger.
