# Exact-SHA immutable releases (MET-157)

This publisher contributes MET-157. It does not deploy anything. Devon owns
workflow/security approval, merge, activation and the first merged canary.
MET-158 must independently verify a release before proposing any installation.
The enabled auto-deploy allowlist is empty. Shipping an installer is not
authorization to run it.

## Activation is blocked pending the policy-read decision

The repository reported immutable releases enabled and owner-enforced during
read-only implementation inspection. The publisher nevertheless checks the live
`GET /repos/Metacomet-Technologies/factory/immutable-releases` setting before its
first write and again before publication. Unknown, disabled or unreadable policy
fails closed. It also requires `immutable: true` after publication.

GitHub documents Administration:read for this preflight, which standard Actions
`GITHUB_TOKEN` cannot request. No new credential, permission grant or bypass is
included. **Do not consider the live publisher activated or the canary complete
until Devon resolves this gate.** Devon can review an explicit reliance on the
existing owner-enforced policy or a separately approved verification arrangement;
neither is silently substituted here. Even an authorized preflight cannot make
the policy read atomic with publication. Owner policy must remain enabled.

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

The immutable activation baseline is recorded in `deploy/components.json`.
Walk first-parent `origin/main` after that baseline. Merges before the inventory
first exists are preactivation and ineligible; removing it afterward fails.
Every later first-parent commit needs one verified merged PR whose exact merge
SHA and base repository/main match. Rebase intermediates without their own
verifiable merge identity stop reconciliation; never infer approval from ancestry
alone. Bump intent comes only from merged PR labels: `bump:minor`, `bump:major`,
or optional `bump:patch`; no label means patch. Multiple/unknown bump labels fail.

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
Existing CI cancels superseded main runs: Devon must inspect and rerun the printed
exact-SHA CI run (`gh run rerun RUN_ID --repo Metacomet-Technologies/factory`) when
appropriate, then reconcile. The publisher has actions:read, not CI-rerun power.

Main updates, successful or failed main CI completion events, and manual reconcile
are wakeups. One fixed non-cancelling concurrency group serializes publication.
Each run walks history; replaced pending workflow events cannot drop eligible
SHAs. Completed history is checked against its immutable manifest receipt and
GitHub asset sizes/digests without rebuilding or downloading all old binaries.
CI retention does not invalidate an already completed immutable release.

The read-only job computes plans, builds exact-SHA bundles and verifies them before
uploading `plans.json` and the bundles through a SHA-pinned artifact action. No
plans means no publish job. The dependent publish job downloads only this run's
artifact, recomputes the current plans from GitHub/main and requires an exact
match. A changed plan requires a fresh build; pending CI instead waits without
writes. It verifies every bundle and its plan before the first remote write.
Its builder callback only copies those verified files, never executes them.

Crash recovery is monotonic: build and verify, reserve tag, create draft, upload manifest and
six assets, download and validate all assets, then publish with a manifest digest
receipt. Every upload inspects existing assets first. Lost write acknowledgements
stop the attempt; rerunning inspects remote state before another write. Identical
content is reused; conflicting, duplicate or starter/partial assets stop with the
draft retained. Never delete a conflicting asset, use `--clobber`, force a tag,
recycle a release version, or hide a failure by releasing the next SHA.

## Build and consumer contracts

`scripts/release/build.sh FULL_SHA PLAN_JSON OUTPUT_DIRECTORY` requires a clean,
fresh disposable checkout at the exact SHA. The publisher clones committed source
without changing its own checkout. Rust 1.99.0 uses locked dependencies; each SHA's
exact Node/pnpm pins and Vite+ 1.1.0 are installed outside source. Rust paths and
archive metadata are normalized. Any byte difference on retry fails rather than
replacing an uploaded asset; OS/compiler system-library changes may require human
recovery. The source is never rewritten or bumped. Builds require Linux x86_64
and working Bubblewrap namespaces.

The credential boundary is job-level separation, not environment filtering.
All dependency installation, builds and sandbox execution run in a job with
contents:read, actions:read and pull-requests:read. The dependent publication job
has contents:write, actions:read and pull-requests:read, installs no tools, and
executes no repository code except trusted main `release.py`. Checkout and
artifact actions are SHA-pinned. Downloaded bundles remain data, outside the
trusted checkout. The immutable-policy checks still run before writes and again
before publication; job separation does not resolve the policy-read gate.

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

## Operator handoff from Mac

No host installer or service restart applies to the publisher. Deployment means
Devon's protected PR merge and separately approved workflow activation. After the
policy gate is resolved, Devon can request reconciliation from Mac:

```sh
gpu-ssh "sudo -u agent bash -lc 'cd /home/agent/work/factory-met-157-publish-immutable-release-assets && gh workflow run release.yml --repo Metacomet-Technologies/factory --ref main'"
```

Emergency rollback of publisher activation disables future workflow starts:

```sh
gpu-ssh "sudo -u agent bash -lc 'cd /home/agent/work/factory-met-157-publish-immutable-release-assets && gh workflow disable release.yml --repo Metacomet-Technologies/factory'"
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
