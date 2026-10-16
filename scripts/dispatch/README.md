# Linear factory dispatcher (MET-80)

Single-user, outbound-only automation of [PLAYBOOK §4](../../docs/PLAYBOOK.md#4-agent-prompt-template).
No dependencies, database, webhook, OAuth app, new credential, or runner changes.
Node **24.21.0** in `.node-version` remains the preferred and CI version; runtime
accepts Node 24.x at **24.12.0** or newer. Requires Linux `flock` and the agent's
existing Amp login. This is not the MET-120 hardening project.

```sh
node scripts/dispatch/dispatch.ts poll --dry-run
node scripts/dispatch/dispatch.ts issue MET-123 --dry-run
node --test scripts/dispatch
```

## Observational stage policy (MET-194)

Every issue/poll pass, including dry-run, emits six `stage-policy` JSON records
per hydrated issue before lifecycle actions: `spec`, `dispatch`, `merge`,
`deploy`, `verify`, and `recovery`. These are stage views, not inferred lifecycle
transitions. **`observational: true` and `authorized: false` always apply.**
`nextAction: blocked` describes missing policy prerequisites, not a new dispatcher
gate. The existing dispatcher still performs exactly its existing actions.
Even a fully evidenced synthetic decision says only `would-execute`; it cannot
authorize an action, approve a PR, or report verified completion.

Policy comes only from `.factory/stage-policy.json` at the pinned
`refs/heads/main` commit in `/home/agent/work/factory`. The observer uses two
read-only Git commands, never fetches, and never reads the working-tree policy,
the proposed PR's tree, task text, or an environment policy override. This is
the locally installed trusted main, not a claim that remote main is current.
Each Git read has a five-second timeout and 64 KiB output limit. The revision is
SHA-256 of the trusted-main SHA, a NUL byte, and the exact policy UTF-8 content;
whitespace changes and unrelated main commits therefore change the revision.

Version 1 requires exactly `version`, `defaults`, and `repositories`. Defaults
must name all six stages: spec=`Human`, dispatch=`Auto-pilot`, and
merge/deploy/verify/recovery=`Agent` initially. The committed `repositories` map
is empty, so every known repo inherits. Explicit overrides use existing
`repos.json` names, for example `"repositories": {"factory-access": {"merge": "Human"}}`.
Unspecified stages inherit defaults; identities and routing still belong to
`repos.ts`/`repos.json`. Unknown keys, stages, modes or repositories, duplicate
keys (including escaped equivalents), and task-level overrides are rejected.

The pure evaluator accepts trusted caller-supplied evidence and classification,
bound to repository, stage, exact target ID/SHA, and policy revision. Security,
authority, or irreversible actions require Human. Unknown classification blocks
deployment (and conservatively blocks other stages too). Mandatory evidence
checks cover specification; task validity/dependencies; CI/independent review;
artifact/deployment plan; deployment receipt/independent verification; and
reconciled outcome/safe recovery plan. Human adds `human-approval`, Agent adds
`agent-review`. Missing, failed, mismatched or ambiguous evidence blocks.
Executor and control availability are required; approval capability is required
for Human/Agent and deployer capability for deploy.

Supplied dispatch-snapshot fixtures retain the stricter stage mode, ordered
Human > Agent > Auto-pilot. Tightening applies immediately; loosening cannot
lower an existing snapshot. Missing legacy snapshots produce `baseline-missing`;
only an explicitly new dispatch can evaluate without a baseline. No snapshots
or authenticated approvals are captured or persisted in this slice.

Output contains only allowlisted identifiers: issue, repository, recorded runner,
observed Linear state type, stage, target, evidence identifiers, classification,
snapshot status, trusted-main SHA/revision, required mode, mandatory checks,
blocker codes, and next action. Unrecorded runners, exact target SHAs, evidence,
classifications and snapshots remain unknown (`null` SHA, empty evidence list).
PR identifiers are attachment observations only, not proof of a current head or
merge. Done and QA/approval comments never establish verified completion or
authenticated approval. Live views currently block because trusted evidence,
classification and approval/control/deployer integrations are unavailable.

Missing/invalid policy produces fixed `policy-diagnostic` / `policy-unavailable`
output plus unavailable stage views. An observer exception produces a fixed
`observer-unavailable` diagnostic/view; neither failure changes lifecycle actions.
No database, endpoint, background process, control write, enforcement, live
controls, or deployment is added. MET-160 retains these later capabilities;
Devon owns protected/self-deploying review, merge, activation and verification.

`node --test scripts/dispatch` discovers parser/evaluator tests and fake-server
trace comparisons for eligible, blocked, claimed, QA and wrap-up issues. The
comparisons run normal poll and dry-run issue with the observer off, valid,
missing, malformed and throwing, checking identical mutations and Amp calls.
No production issue/poll is used for development verification.

`poll` handles team issues carrying `dispatch`, priority 1–4 then unprioritized
(0), oldest first within a priority. `issue` ignores only the label requirement.
Both also check QA, pending wrap-ups and archives. Blockers must be completed or canceled;
one waiting comment survives subsequent polls. Invalid tasks lose the label and
get reasons. `>` hint lines do not count as section content. Required sections:
Goal, Context, Isolation, Build, Sandbox check, Done means. Empty Link type means
contributes. Link type section must contain only `closes` or `contributes`; put notes in Context. Tests get the playbook
defaults when empty. Exactly one Bug/Feature/Improvement and at least one
`area:*` label are required. Group labels use `parent.name` plus the child name;
flattened `runner/gpu`-style labels also work. Factory refuses orb explicitly.

## Other repositories (MET-184)

The lifecycle documented below remains the default `factory` full flow. One
optional grouped or flat `repo/<name>` label selects `repos.json`; multiple or
unknown repos are refused. The file validates on startup before API calls.
`full` is supported only for factory; other allowlisted repos use `simple`.
Each entry names its GitHub `slug`, `ampProject`, flow, default runner, required
checks, and allowed local `fallbackRunners` with checkout paths. The local map
includes the default runner when it is local. Only an orb default allows `orb`;
`maxActiveOrbs` sets its positive per-repo capacity (factory-access: one).

Factory-access uses plain `amp -ox` with its project, medium orb size and issue
title. The live URL/ID and private-checkout probe is recorded in
[Amp CLI §3](../../docs/amp-cli.md#3-orbs-and-billing). Orb claims reserve capacity
until archive, including failed or unknown submissions. Factory runner capacity
and GPU-to-console overflow are unchanged. Simple flows never overflow: explicit
`runner/gpu` uses `/home/agent/work/factory-access-<branch>` instead. Failed starts
keep `dispatch` off and mention Devon on the issue; there is no Slack alert path.
Claims prevent all automatic retries, even after relabeling. Inspect the outcome
before manual recovery; adding a fallback label does not erase a failed claim.
Simple claims also pin the repo name, so later label edits cannot switch lifecycle
or cleanup to factory. Removing that repo from the allowlist defers its lifecycle.

Simple builders open contributes PRs and post URL/SHA/file-list evidence only.
GitHub's ruleset and Devon enforce required checks/review; the dispatcher never
starts QA, sends wrap-up, or merges for these repos. It accepts one matching
merged PR attachment newer than the dispatch claim, confirms GitHub's merge to
main, and reads the latest configured `applyWorkflow` run for that merge SHA,
restricted to `push` on `main`. PR test runs cannot satisfy the apply gate.
Missing/pending/unreadable runs wait. Failed terminal runs mention Devon once
per run ID without changing state; a successful rerun can still complete.
Success posts `Applied` with the run URL and an `applied` marker, then moves to
the team's completed `Done` state. The marker recovers an interrupted state move.
Done alone cannot archive a simple builder without the apply marker.

The existing five-quiet-minute archive path, markers and shared attempt budget
apply unchanged. GPU fallback worktrees are removed only after recorded archive,
with a clean/untracked check and no force. Dirty or failed cleanup retries on
later polls; local branches remain. No installer or deployment artifact changes.
The deployed issue-to-PR-to-apply lifecycle remains unverified until Devon merges
and updates main, then the next eligible factory-access issue completes.

Configuration:

- `LINEAR_API_KEY_FILE`: `/etc/factory-dispatch/linear-api-key`; read, never logged.
- `DISPATCH_TEAM`: `MET`.
- `DISPATCH_MAX_ACTIVE_PER_RUNNER`: fallback for runners without an override;
  positive integer, default `2`. Existing deployments using only this variable
  keep the same cap on both runners.
- `DISPATCH_RUNNER_CAPS`: optional comma-separated overrides, e.g.
  `gpu=4,console=2`. Keys are `gpu` and `console`, not Amp runner IDs. Each value
  must be a positive safe integer written with decimal digits only. Unknown or
  duplicate keys, whitespace, empty entries and malformed values fail startup
  before API calls. Omit this variable rather than setting it to an empty string.
- `DISPATCH_RUNNERS`: `gpu=factory-gpu,console=factory-console`.

For each runner, precedence is `DISPATCH_RUNNER_CAPS`, then
`DISPATCH_MAX_ACTIVE_PER_RUNNER`, then `2`. A partial override such as `gpu=4`
leaves console on the fallback. Overflow starts only when gpu reaches its own
effective cap, and stops when console reaches its own cap. Every pass logs one
JSON `caps` decision with both effective values, including idle passes.

After merge and the wrap-up pull, Devon replaces the old global-cap entry in
`/etc/systemd/system/factory-dispatch.service.d/cap.conf` with:

```ini
[Service]
Environment=DISPATCH_RUNNER_CAPS=gpu=4,console=2
```

Run `sudo systemctl daemon-reload` and confirm with
`systemctl show factory-dispatch.service -p Environment`. No timer or runner
restart is required; the next service pass uses the new caps.

The committed `modes` map sends Amp low/medium/high unchanged; Claude always
uses `external-agent:claude-code` with `--features model:claude-opus-5-5,effort:<low|medium|high>`
(default medium); ChatGPT low uses `gpt56l`,
medium/high use `gpt61s` (**proposed, unverified**). See [Amp CLI evidence](../../docs/amp-cli.md).
`engine/ultra` explicitly selects `--mode ultra` regardless of `agent-effort`;
the claim states that effort is ignored and includes
"Engine ultra: bills Amp credits (or OpenCode Go)". Ultra is never the default;
unlabeled issues still use Amp medium. Under Devon's ChatGPT Only preset,
`engine/amp` means GPT through ChatGPT; ultra retains Amp routing. Never trust
a thread's self-reported model; check usage metadata.
Submission success is not execution success. Inspect the thread for results.

CLI evidence, 2026-10-13: `amp --help` confirms `--features <value>` accepts
comma-separated features. A tiny runner probe with the exact Claude features
returned `OK`; its exported metadata records `model:claude-opus-5-5` and
`effort:low`. Usage metadata was unavailable, so the serving model/provider
remains unverified. The ultra probe initially failed with `permission-denied`;
Devon's thread-page screenshot identified Claude Usage: Subscription Only,
which blocks Claude outside Claude Code. After Devon changed that setting,
the same thread returned `OK`. Usage metadata shows `anthropic/claude-fable-5-1`
(Fable 5.1), Via Amp, $0.92 in covered Amp paid-tier cost across two requests
(Devon's retry and our confirmation). Ultra's Claude routing requires
Allow Paid-Per-Token Usage in Settings → Model Routing; enabling paid usage
is an operator decision, not a dispatcher action. Both attached to the
factory project from a disposable detached worktree, which was removed after
the check.

- [Ultra probe](https://ampcode.com/threads/T-01a133dc-100b-72c8-bce7-b77d3d2d4998)
- [Claude low probe](https://ampcode.com/threads/T-01a133dc-1b2d-744f-9db0-1d2e62b9119c)

## Project-attached worktrees (MET-134)

The dispatcher creates each checkout **after its durable claim and before Amp
submission**, then passes that absolute path as `--runner-dir`. Amp matches the
Git remote to `metacomet/factory` at creation. Never pass `--project` to a runner;
continuing a thread cannot repair its original project association.

Builders get `/home/agent/work/factory-<slug>` on branch `<slug>`, created with
`git -C /home/agent/work/factory fetch origin` followed by `worktree add -b
<slug> <path> origin/main`. An existing branch, directory or dangling symlink
is refused and commented on the issue. Fetch/create failures also retain the
claim and disable automatic retry. The prompt says the worktree already exists;
the builder only verifies its directory/branch. Post-merge wrap-up still removes it.

Commands run locally for GPU and through noninteractive SSH as
`agent@factory-console` for console, with strict host-key checking and timeouts.
Runner ID overrides do not change these physical hosts. No SSH key, login,
access rule or runner configuration is installed or changed. Before any console
builder or QA start claim, a side-effect-free `true` command checks that same SSH
transport. Its result is shared across dispatch, QA and cleanup for one pass.
Failure logs `console-unavailable` once, leaves builders labeled and QA unclaimed,
and quietly skips console cleanup. A later pass retries; there are no failure
comments or Amp submissions. Failures after a successful preflight still retain
the durable claim for manual inspection.

Agent-to-console SSH is set up; the preflight passed and QA reviews launched on console on 2026-10-14; builder overflow to console is not yet exercised.

QA gets `/home/agent/work/factory-qa-<pr>-<first-12-sha-characters>`, detached at
freshly fetched `origin/main`, as both its initial directory and `QA_BASE`.
It fetches the PR ref for inspection without checking it out. The trusted merge
gate runs from this worktree, not from PR code or a new temporary clone.
The dispatcher marks ownership/creation time with Git's native worktree lock
reason `factory-qa:<UTC-ms>`. Reviewers must not unlock, remove or write artifacts
into it. No PR code runs merely to prepare the checkout.

Each pass attempts at most five QA removals across both hosts, including failures.
Delivered changes, a human handoff, a superseded ready verdict or observed merge
qualify immediately. Owned worktrees with no retained claim qualify only when
older than 24 hours. Active, ready and interrupted claims retain their checkout
even past 24 hours: age alone does not prove a reviewer stopped. Only exact QA
paths with the ownership lock qualify. Dirty/untracked files refuse removal;
the dispatcher re-locks and reports pending cleanup. A crash between unlock and
remove leaves an unlocked checkout for manual inspection, never force deletion.
Dry-run previews preparation without creating/removing worktrees or calling Amp.

Live creation probe, 2026-10-13: Devon verified all three threads in the factory
project in MET-134's 05:04 UTC comment; the runner discovered the new checkout
without restarting. Probe worktree was removed and absence checked with
`git worktree list`:

- [low](https://ampcode.com/threads/T-01a133a4-eb1d-76ae-862e-3b204b068952)
- [Claude Code](https://ampcode.com/threads/T-01a133a4-f364-74e5-bc99-45dd51fd67a4)
- [gpt56l](https://ampcode.com/threads/T-01a133a4-fd63-713a-80d0-bec37000e42e)

## Automated QA and merge (MET-128)

The dispatcher remains the control plane; fresh reviewer threads perform
PLAYBOOK §5 review. Clean dispatched PRs may now merge as Devon's GitHub identity
without per-merge human review (the MET-120 identity/privilege risk remains).
Builders never merge. Devon owns deploys, self-deploying merges and irreversible
production actions. No native thread-finished trigger is assumed.

Only this repository's open, non-draft PRs targeting main and attached strictly
after the dispatch claim qualify. `git ls-remote
https://github.com/Metacomet-Technologies/factory refs/pull/<n>/head` resolves the
head. Each PR/SHA gets a fresh review, GPU first then console, with a separate
cap of **one review per runner** regardless of builder labels/capacity. An
unconfirmed start reserves a slot. Changes release it; ready retains it until
merge, handoff to Devon, or a new head before any merge continuation. Unresolved
older reviews retain their slot; a new head may use the other runner. Finished QA
threads use the shared archive path described below, including legacy claims.

After a delivered changes round, a Linear diff comment newer than the round's
delivery comment can trigger one fresh review without a push. It must contain
the same PR URL, head SHA and file list (Markdown list or fenced text block),
with no standalone control markers. Legacy fenced evidence is still accepted.
The dispatcher does not execute this evidence; the reviewer checks the SHA and
complete file list against the PR, then reads the actual diff and files with git.
The new key appends
`round:2` after the SHA in start, claim, verdict and completion markers. Its
worktree appends `-round-2`, so a retained first checkout is never reused.
Repeated polls or comments cannot start another review for that key. Both new
heads and evidence-only reviews count toward the existing two-changes-round stop;
missing or invalid delivery timestamps and interrupted follow-ups defer the re-review.

The builder's grouped/flat engine label determines the reviewer: amp, chatgpt or ultra
gets claude; claude gets amp; missing/unknown gets claude. Reviews use high effort
through the shared engine arguments; Claude reviewers get
`--features model:claude-opus-5-5,effort:high`. `review-prompt.md` requires the full diff and full
changed deploy/migration/script files, Isolation/Build/Done-means checks, current
CI, and contributes/closes correction via `update_diff`. Reviewers never edit code.

State transitions under the existing exclusive dispatcher lock:

1. Write `factory-qa:start pr:<n> sha:<sha> runner:<runner>` before worktree creation and Amp.
   After one thread ID returns, write
   `factory-qa:review-claim pr:<n> sha:<sha> thread:<T-review>`.
2. Accept exactly one `factory-qa:review pr:<n> sha:<sha> thread:<T-review>
   verdict:ready|changes` matching that claim. Markers use the `<!-- … -->`
   wrapper on one standalone unfenced line. Duplicate, conflicting, inline,
   fenced and wrong-thread verdicts fail closed. Shared Linear identity means
   this is correlation, **not authenticated authorship**: an agent able to copy
   the markers could spoof them. MET-120 remains the hardening work.
3. For changes, write a follow-up claim, always deliver the final
   `## Builder follow-up` section using `amp threads continue <builder> -ox
   <prompt>`, then record a round. Even overtaken verdicts are delivered with
   their original SHA for reconciliation. After two rounds, the same comment
   records a stop marker and @-mentions Devon. Later pushes cannot restart it.
4. For ready, inspect all changed paths, including deleted and renamed sources.
   `qa-config.json` lists self-deploying paths (`scripts/dispatch/` and
   `scripts/usage/`), the Linear document ID and Devon's profile
   mention URL. Self-deploying PRs get one “ready; merging deploys it” ping,
   never a merge continuation.
5. Otherwise precheck CI for that SHA with `gh api`, then claim a continuation to the
   **reviewer**. It reconfirms Isolation and runs the trusted-main QA worktree's
   `node "$QA_BASE/scripts/dispatch/qa.ts" check <n> <sha>` after refreshing main.
   That independently runs `gh pr checks`, requires all checks to pass including
   rust/kiosk/scripts, rechecks head/open/draft/base state and refuses
   self-deploying paths. Only then may it run `gh pr merge <n> --squash
   --match-head-commit <sha>`. No admin bypass or auto-merge. GitHub's head match
   and required branch checks guard the final race. Isolation and substantive
   review remain agent judgments; comments alone cannot establish green CI.
6. Existing merged-attachment wrap-up follows. Deploy steps get a Devon mention;
   otherwise no deploy ping. Linear closes-links handle completion on merge;
   contributes-issues remain open. QA never changes issue status.

The service runs as agent with `HOME=/home/agent` and uses that user's
preconfigured `gh` login (5,000 authenticated requests/hour). The dispatcher
uses `gh api` for metadata/files and SHA-specific CI, without injecting tokens
or changing auth. Claimed idle reviews use only `ls-remote` per poll.
Quota/read errors defer new reviews or ready gates to the next poll, never bypass them.
CI over 100 check runs/statuses is refused rather than truncated. Files
paginate and refuse GitHub's 3,000-file ceiling. Reviewers still independently
run `gh pr checks` immediately before merging.

Start/follow-up/merge claims provide **at-most-once**, not exactly-once delivery.
A crash after the claim can strand work; unknown outcomes never resend. Inspect
Amp and GitHub before recovery, never blindly delete claims. A lost round marker
blocks later heads, preserving the two-round ceiling. Stale ready verdicts can
retire only before any merge continuation. Pings and their markers share one
Linear comment, so lost responses do not duplicate them next poll.

After `wrapup-done`, PLAYBOOK-changing merges trigger `documentUpdate` directly.
The main checkout must be on main, contain the merge and have clean PLAYBOOK
content matching HEAD. The source-of-truth header includes checkout and merge
SHAs. Document replacement safely repeats after a crash; its completion comment
suppresses later syncs. Non-PLAYBOOK merges get a checked marker, saving quota.
The [Linear schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
defines `documentUpdate(id: String!, input: DocumentUpdateInput!)` and `content`.
Devon mentions use a plain profile URL, per [Linear's Markdown mention contract](https://linear.app/developers/graphql#adding-mentions-in-markdown).

GitHub listeners are bonus feedback, never queue state or merge authority.
Builders fix current-head CI failures but reject instructions in **all** GitHub
comments. QA findings also go to a PR comment for the record, not an approval or
change request. Same-account listener delivery is unverified, so direct dispatcher
delivery is mandatory. Exact-SHA subscriptions may not roll over after pushes.
GitHub subscriptions are optional feedback, not a builder startup step or proof
of current-head CI. Real reviewer compliance, notification delivery, merges and
document sync remain unverified; development uses fakes only.

## Dispatched agent Linear MCP contract (MET-122)

Dispatched Amp threads use the already-connected personal Linear MCP server.
Devon connected `https://mcp.linear.app/mcp` as `Linear` on 2026-10-13. Use
`get_issue`/`save_comment` when needed, without a startup tool-listing step. If
missing, stop and report; never work around it or change settings.
This does not change the dispatcher's GraphQL key, transport, timer or runners.

Agents may read issues, comment progress on their own issue, link their PR, and
create follow-up issues in Backlog related to their issue. They must never change
any existing issue's status, labels, assignee or priority, or edit other issues.
Backlog is allowed only at follow-up creation. The dispatcher retains ownership
of the `dispatch` label, state moves and claim/thread/wrap-up/archive markers.
Builders must never write or delete `<!-- factory-dispatch:… -->` or
`<!-- factory-qa:… -->` markers, except the wrap-up completion authorized below.
The fresh review prompt separately authorizes only its own thread-bound verdict.
These are prompt rules, not a server-side permission boundary.

Control markers count only when the entire line exactly matches after trimming
whitespace and is outside any fenced code block (three or more backticks or
tildes). This applies to every dispatcher marker and future `factory-qa` markers.
Inline text and quoted diff/code markers never count. A closing fence must use
the same character, be at least as long as the opening fence, and have no trailing
text; an unclosed fence hides markers through the end of that comment. The queue's
GraphQL substring filter only selects candidates; local parsing determines which
markers count. All dispatcher-written markers already occupy standalone unfenced
lines; their output format is unchanged. Future QA consumers must use the shared
`commentMarkers` parser, not raw comment substring or regex searches.

After opening the PR and after each later push, post one short Linear comment
on the task issue with only the PR URL, current head SHA and complete file list
from `git diff --name-only origin/main...HEAD`. Call out deleted and renamed
files, including rename sources. Use a Markdown list or fenced text block for
the file list. No pasted diff or file contents. Never write a control marker as
a standalone line; never include secrets or production data. Redact them and
identify any omissions. Reviewers must match the comment's SHA and file list to
the PR. A missing or stale evidence comment is a `changes` finding only when its
SHA or file list is missing or wrong, never a reason to request pasted diffs.

Only after all wrap-up steps succeed, the wrap-up prompt authorizes one comment
on the task issue with exactly this body:

```text
Wrap-up finished

<!-- factory-dispatch:wrapup-done -->
```

This is the builder's sole marker exception. It reports wrap-up completion, not deployment
verification or permission to mark Done. Archive logic still uses Done and five
quiet minutes; QA document sync consumes the completion marker.

Dry-run takes the same read-only lock and performs GraphQL/authenticated GitHub/Git reads, but never
mutates Linear, invokes Amp, or writes files. It prints JSON decisions, exact
mutation documents/variables and shell-quoted Amp flags. To honor the no-prompt
logging rule, `$PROMPT`/`$WRAPUP_PROMPT`/`$QA_*` stand for the rendered text; the future
thread ID is represented by `T-00000000-0000-0000-0000-000000000000`. These are
previews, not runnable commands or real thread links. Normal logs contain only
decisions/identifiers; Amp stdout is captured for the ID and stderr is discarded
because it can include prompts or credentials. Errors report exit/signal or a
fixed diagnostic, never raw API/CLI bodies.

## Console overflow (MET-127)

An issue without a runner label uses gpu while it has capacity, then console
while it has capacity. If both are full, `dispatch` stays on and no comment is
posted. Explicit `runner/gpu` and `runner/console` labels always win and never
overflow, including grouped labels. `runner/orb` remains refused.

Capacity counting is unchanged: thread markers and unresolved dispatch claims
reserve a slot on their recorded runner until a wrap-up marker exists. Selection
accounts for earlier submissions in the same pass. Console overflow claims say
`Dispatch claimed on console (overflow).`; the claim marker, thread marker,
Amp executor and generated prompt all record the chosen runner.

## Crash safety is at-most-once submission

Every CLI pass holds an exclusive `flock` on the existing
`/home/agent/work/factory/scripts/dispatch/dispatch.lock` inode through its final
mutation. The file is committed so even the first dry-run needs no filesystem
write. Never replace/remove it while a pass runs. All manual invocations use
this same main-checkout lock, including invocations from another worktree.

Order: read under lock; check blockers, shape, capacity, previous markers;
remove `dispatch` and await success; post and await a durable
`<!-- factory-dispatch:claim runner:gpu -->` (or console) comment; fetch origin
and create the worktree on that runner's host; call Amp with that worktree;
post URL plus `<!-- factory-dispatch:thread T-… runner:gpu -->`; move to
In Progress. The claim also stores the original worktree slug, so renaming the
issue does not change cleanup paths.

A crash between worktree creation and submission leaves a claim plus checkout
for inspection, never an automatic second thread. Do not remove either to retry
without establishing the original submission outcome. QA start claims follow
the same rule; retained claims are exempt from stale-worktree cleanup.

**Why label removal alone is insufficient:** manual `issue` deliberately ignores
the label. A crash after Amp succeeds but before its URL comment would otherwise
allow a second thread. The prior claim closes that gap. Crashes before the claim
cannot have submitted Amp; crashes after it never retry automatically, including
when someone re-adds the label. Confirmed threads and unresolved claims each
reserve one slot until a wrap-up marker exists. This is conservative: a failed
submission can hold a slot. Legacy thread markers without runner identity count
against both runners rather than accidentally freeing capacity.

Wrap-up uses the same pattern: await `<!-- factory-dispatch:wrapup-claim -->`,
send `amp threads continue <id> -ox <prompt>`, then post
`<!-- factory-dispatch:wrapup -->`. An interrupted/failed send does not retry.
The completion marker means submitted, not that the build or deployment passed.
Wrap-ups run after dispatch decisions; a freed slot is available next pass.

Linear and Amp have no shared transaction or submission idempotency key here.
Thus **exactly-once delivery is not promised**: a crash can strand work, but cannot
create a duplicate through these entry points. Recovery is manual: stop the timer,
inspect the private Amp thread and Linear comments, then record a missing thread
marker/state or finish wrap-up by hand. Only after establishing no submission
occurred may Devon remove a claim and retry. Do not delete markers or blindly
relabel a failed issue. If the outcome is unknown, retain the claim. A state move
lost after the thread comment is not automatically repaired.
After finishing failed-wrap-up recovery by hand, archive the builder thread: `amp threads archive <T-id>`.

## Archive Done threads after five quiet minutes (MET-127)

After wrap-ups, each pass considers recorded builders and labeled threads on
issues with `state.type === "completed"`. A builder with a GitHub PR attachment
newer than its dispatch claim requires the wrap-up marker before archiving;
unknown attachment/claim chronology also waits. Done builders without such a PR
need no wrap-up marker. Pending archive claims cannot bypass this gate.
Canceled issues archive QA/probe threads but never their recorded builder. Done is the human-controlled
merge/deploy-verification gate: closes PRs mark Done at merge, while contributes
PRs remain open until deployment verification. The wrap-up marker alone does not
prove deployment or task completion.

The thread's `updated` timestamp from `amp threads list --json` must be at least
five minutes old relative to the dispatcher clock. Each pass rereads it; new
updates restart the quiet period. Wrap-up comment age is irrelevant. Missing
threads, missing/invalid/future timestamps and unreadable listings stay
`archive-pending` and retry next pass. That decision means Done but five quiet
minutes have not been established. At most five eligible archive attempts run
per pass, including failed attempts; pending threads do not consume that budget.

Under the existing exclusive lock, the order is:

1. Check Linear eligibility and Amp quiet/archive state.
2. Post and await `<!-- factory-dispatch:archive-claim thread:<T-id> -->`, unless it exists.
3. Run `amp threads archive <T-id>` only if the thread is still unarchived in
   the listing.
4. After success or confirmation that it is already archived, post
   `Thread archived.` with `<!-- factory-dispatch:archived thread:<T-id> -->`; log `archived`.

Unlike dispatch/wrap-up claims, an archive claim permits automatic recovery.
A crash before Amp leaves a retryable claim. A crash after Amp but before the
completion marker is recovered by checking the listing and posting the missing
marker without archiving again. A crash after the marker is a no-op next pass.
An archive command failure logs `error` with `action: archive`, leaves no
completion marker, and retries next pass after rereading quiet/archive state.
Linear write failures stop the pass; an acknowledged or lost-response marker
is read on the next pass before any retry.

**Repeat-call behavior is not assumed.** CLI help was checked on 2026-10-13 with
Amp `0.0.1791849701-g1448da`: `amp threads archive [options] <thread>`;
`--unarchive` restores a thread. Help does not promise that repeated archive
commands succeed. The dispatcher therefore paginates `amp threads list --json
--limit 100 --offset <n>`; if absent, it also checks `--include-archived`. A thread
present only in the latter is already archived. Neither absence from the normal
list alone nor a failed command is treated as success. The JSON array's `id` and
`updated` fields match [the earlier CLI observation](../../docs/amp-cli.md#5-thread-records-archiving-and-visibility).
That probe observed `updated` not tracking the final reply: this requested quiet
time rule is a timestamp heuristic, not proof that the agent is idle. Real archive
calls, listing consistency and timestamp freshness during agent execution remain
unverified here. These are CLI snapshots, not an atomic quiet-time-and-archive
transaction; a concurrent update can race a pass.

Dry-run preserves its no-Amp-call contract. It logs `archive-pending` with an
explicit quiet-time-unchecked reason and previews the first listing pages and
conditional archive command for up to five candidates. It does not claim an
archive succeeded or preview completion markers without a timestamp check.

### Archive finished QA threads (MET-136)

Every standalone `review-claim` identifies a reviewer, including existing claims
from before this change. A review finishes on delivered changes (matching verdict
and round), human handoff, retirement, observed PR merge, or a Done/Canceled
issue. Active reviews and ready reviews awaiting merge stay open. Canceled
builders still stay open; their QA and labeled probe threads qualify.

QA uses the same quiet-time check, retry/recovery logic and **shared five-attempt
budget** as builders. All roles now use the thread-ID archive markers above;
legacy builder and per-PR/SHA QA completion markers still suppress retries.
A crash after archive repairs the missing marker from
the archived listing without a second archive command. Existing finished reviews
qualify on the first deployed pass, subject to quiet time and the shared cap.
The queue includes QA-only marked issues, not just builder-marked issues.

### Shared label and probe groups (MET-138, MET-146)

After recording each successful builder/reviewer launch, the dispatcher adds
the single label with `amp threads label <T-id> factory`. Failures log
`error` with `action: label` and retry next pass without blocking dispatch/QA.
Builders move to In Progress and log `dispatched` before any label attempt.
A per-thread `factory-dispatch:labeled <T-id> factory` marker records success; existing
builder/review-claim IDs backfill once on open issues only (not Done/Canceled),
including threads with the old issue-label success marker. A crash
between labeling and its marker safely repeats the additive label command.
Known archive completions skip backfill: the CLI refuses labels on archived threads.
After a label failure, presence only in the `--include-archived` listing records
`factory-dispatch:label-skipped-archived <T-id>` and stops later attempts/logs.
Missing or unreadable listings do not prove archive state; those failures retry.
Prompts require: "Title scratch/probe/test threads `MET-<n> probe: …` and label
them `factory`." Archive before the final reply and list them.
Builder and wrap-up also say: "Commands that read `/home/agent` paths run as
agent (`sudo -u agent …`); admins can't read `/home/agent`." This tells admins
how to read agent-owned artifacts, not permission for builders to use sudo.

For seven days after `completedAt`/`canceledAt`, `amp threads search
'label:factory author:me archived:false' --json --limit 500` discovers probes,
keeping only full titles starting with the exact identifier plus a space:
`MET-14 ` never matches `MET-141 —`. The same window also searches
`label:met-<n> author:me archived:false` for threads from before this deploy;
legacy discovery stops after seven days from each issue's closure. No new
issue labels are created, and existing add-only labels are not removed.
Historical issues and missing/invalid/future close timestamps make no search
call. Archived threads leave the search window; pending archive claims remain
candidates for crash repair even after that window. Every candidate uses
the existing listing-based quiet check and shared five-attempt cap. CLI search
has no offset and a maximum limit of 500: more than 500 recently active threads
can defer discovery of older ones until that window drains. Dry-run previews
search/label commands but never invokes Amp or discovers probes live.

MET-146 live CLI probe, 2026-10-13: after adding `factory` to
[the builder](https://ampcode.com/threads/T-01a13598-be1b-727a-a349-21292ef6c1f7),
`amp threads search 'label:factory' --json --limit 500` returned its full title:
`MET-146 — Use one Amp label and fix small dispatcher prompt gaps`.
No extra probe thread was created; the builder remains open for QA/wrap-up.

Live CLI check, 2026-10-13: add-only label syntax is verified; no remove/list
subcommand is exposed. Listings omit labels; search returns `id`, `title` and
`updatedAt`, including archived threads unless filtered. The disposable
[probe](https://ampcode.com/threads/T-01a1343c-ec9f-756d-a50b-fef6fda1d4aa)
was found with `label:met-138-label-check`, then returned
`✓ Thread archived successfully`; its detached scratch worktree was removed.
An empty preliminary thread was not searchable and was also archived. Search
index consistency and timestamp freshness during active execution remain unverified.
Read-only author-filter check from `/tmp`: the same test label with
`author:me archived:false` returned `[]`; `author:me archived:true` returned the
owned probe above; a nonexistent-author control returned `[]`. Probe searches
now use `author:me`; no cross-author live fixture was available.

## Verified Linear fields; one unverified integration convention

Checked against Linear's [official GraphQL guide](https://linear.app/developers/graphql),
[filtering](https://linear.app/developers/filtering),
[pagination](https://linear.app/developers/pagination), and
[published schema](https://github.com/linear/linear/blob/6f99687aa115c8d82528231d7ec1ca48124f92a0/packages/sdk/src/schema.graphql)
on 2026-10-12. No authenticated Linear API request was made by the dispatcher.

- Endpoint `https://api.linear.app/graphql`, `Authorization: <key>` (not Bearer
  for a personal API key). HTTP success alone is insufficient; check `errors`.
- `issues(filter: IssueFilter, first, after, includeArchived)` and `issue(id)`;
  `id`, `identifier`, `title`, `description`, `priority`, `createdAt`, `team.id/key`, `state.type`.
  Filters: `team.key.eq`, `labels.some.name.eq`, `comments.some.body.contains`, `or`.
- `labels.nodes.{id,name,parent.name}` and `comments.nodes.{body,createdAt}`.
- `inverseRelations.nodes.{type,issue.identifier,issue.state.type}`. A relation's
  `issue` is its source, `relatedIssue` its target, and type `blocks` means the
  source blocks the target. Incoming `blocks` therefore supplies blockers.
  State `type`, not its customizable name, determines completed/canceled.
- `workflowStates(filter: WorkflowStateFilter)` with `team.key.eq`, `name.eq`;
  require exactly one `In Progress` with `type: started`, use its `id`.
- `issueRemoveLabel(id: String!, labelId: String!)`,
  `commentCreate(input: CommentCreateInput!)` with `issueId/body`,
  `issueUpdate(id: String!, input: IssueUpdateInput!)` with `stateId`;
  all mutation payloads must report `success: true`.
- `attachments.nodes.{url,metadata,createdAt}`. Connections use `nodes` and
  `pageInfo.{hasNextPage,endCursor}`. Queue pages and initial nested pages have
  20 entries; overflow connections paginate separately, never silently truncate.
  Archived marked issues remain visible for deduplication and capacity.

Wrap-up considers only attachments whose `createdAt` is strictly later than the
dispatch claim comment's `createdAt`. Both fields are `DateTime!` in the cited
schema. Older or equal-time attachments cannot trigger wrap-up; a missing claim
or unknown timestamp also leaves it pending. Newly posted claims acquire their
server timestamp from the next poll, not the dispatcher's clock.

[Attachment docs](https://linear.app/developers/attachments) and the schema
describe `metadata: JSONObject!` as integration-specific. **They do not specify
GitHub's merge-state key.** `isMergedGitHubPR` provisionally accepts only a GitHub
`/owner/repo/pull/<number>` URL with `metadata.status === "merged"`. Open, closed,
missing/unknown status, and other URLs never trigger wrap-up. This convention is
fixture-tested, **not live-verified**. Verify a real merged attachment before
enabling the timer. Neither issue completion nor attachment subtitle is treated
as evidence of merge. The wrap-up prompt also requires confirming the PR merge.

## Administrator deployment from Mac, after merge

GitHub auth is preconfigured for agent (gh + git credential helper); don't set GH_TOKEN or run gh auth commands. If `gh auth status` fails, stop and report.

The AGENTS.md contract owns auth restrictions without naming token variables.
Each generated prompt checks `gh auth status` exactly once. Issue sections pass
through unchanged; their text is not counted against the fixed prompt budget.

For an already-installed dispatcher, MET-128 adds no deployment artifact, build,
installer invocation or restart. The post-merge wrap-up's `pull --ff-only` in
`/home/agent/work/factory` on factory-gpu deploys the code; the next existing
60-second timer pass uses it. Merge and that pull remain Devon's gates. From Mac,
after confirming the merge and a clean main checkout:

```sh
gpu-ssh 'sudo -iu agent bash -s' <<'EOF'
set -e
gh auth status
test -z "$(git -C /home/agent/work/factory status --porcelain)"
test "$(git -C /home/agent/work/factory branch --show-current)" = main
git -C /home/agent/work/factory pull --ff-only origin main
EOF
gpu-ssh 'sudo -iu agent node /home/agent/work/factory/scripts/dispatch/dispatch.ts poll --dry-run'
```

The preview does not delay the running timer or verify Amp quiet time. For an
emergency rollback, the existing removal command below stops/removes only the
dispatcher units; it does not unarchive threads or remove Linear markers. No
console change is required. None of these deployment/rollback commands ran in
development. The following installation steps are only for a new installation.

Artifacts only; these commands were **not run**. Have the task thread update the
main checkout first; no runtime build is needed for this dispatcher. Both runners
must serve `/home/agent/work`. GPU CLI `amp runner list --json` confirms
`factory-gpu`; Amp's account-wide runner listing also confirmed `factory-console`.
The CLI is machine-local, so the installer takes a **fresh console CLI listing on
stdin** instead of trying unauthorized GPU-to-console administrative SSH.

First open an interactive GPU shell from Mac (so `opin` can prompt):

```sh
gpu-ssh
```

In that shell, replace the secret reference with Devon's **existing** Linear key
item/field in 1Password. No key creation, shell tracing, or key printing:

```sh
set -euo pipefail
set +x
umask 077
temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT
opin read 'op://Factory/<existing Linear item>/<key field>' > "$temporary"
test -s "$temporary"
sudo install -d -o root -g agent -m 0750 /etc/factory-dispatch
sudo install -o root -g agent -m 0640 "$temporary" /etc/factory-dispatch/linear-api-key
rm -f "$temporary"
trap - EXIT
exit
```

Back on Mac, first inspect an intended issue without dispatching (replace MET-123):

```sh
gpu-ssh 'sudo -iu agent node /home/agent/work/factory/scripts/dispatch/dispatch.ts issue MET-123 --dry-run'
```

Before installation, verify the merge metadata convention above using a read-only
Linear attachment query with Devon's key; this remains a human gate. Ensure only
intended issues carry `dispatch`: enabling the timer can dispatch immediately
when the two-minute boot deadline has already passed. Then, from Mac:

```sh
set -o pipefail
console-ssh 'sudo -iu agent amp runner list --json' |
  gpu-ssh 'sudo bash /home/agent/work/factory/deploy/install-dispatch.sh'
gpu-ssh 'systemctl is-enabled factory-dispatch.timer; systemctl is-active factory-dispatch.timer; systemctl list-timers factory-dispatch.timer'
gpu-ssh 'sudo journalctl -u factory-dispatch -f'
```

The pipe must transport JSON without a PTY or helper banner on stdout. If the Mac
helper prints status, use PLAYBOOK §8's plain SSH transport with the same remote
commands; invalid JSON stops preflight without installing anything. The installer
checks root:agent 0640, resolves absolute Node/Amp paths as agent, bakes PATH into
the unit, prints `poll --dry-run`, snapshots units under
`/var/backups/factory-dispatch`, and enables only the dispatcher timer. It never
installs credentials, changes login/settings, or restarts either runner or any
production application service. Network/CLI timeouts are 30/120 seconds; the
oneshot has a one-hour ceiling. A timeout preserves claims for manual recovery.

Rollback from Mac removes only the dispatcher units and stops its timer/service:

```sh
gpu-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-dispatch.sh'
gpu-ssh 'systemctl is-active factory-dispatch.timer; systemctl is-enabled factory-dispatch.timer'
```

Expect inactive/not-found and nonzero status after rollback. Key, snapshots,
Linear comments and already-running Amp threads remain. Rollback is removal, not
restoration of a previous dispatcher version. It does not cancel submitted work.

## Offline verification

`node --test scripts/dispatch` runs the real CLI under an isolated environment,
in-process `node:http` fake Linear/GitHub servers and fake Amp/Git/gh executables
on PATH. The main-checkout playbook read is replaced with a synthetic fixture.
It exercises label removal, comment/status results, blockers, validation,
caps/order, all twelve engine/effort mappings, Claude feature passing, ultra billing
claims and explicit-only selection, slugs/hints, pagination, dry-run, real flock
contention, Amp errors and SIGKILL at dispatch/wrap-up/archive mutation boundaries.
Archive fixtures cover exactly five quiet minutes, ongoing updates, missing and
unreadable timestamps/listings, canceled/non-Done states, missing markers,
failure/retry, the five-attempt limit and already-archived recovery. Fake Amp
deliberately rejects duplicate archives. Overflow fixtures fill gpu, then console,
then wait; explicit grouped/flat labels never overflow. Rendered prompt checks
cover byte ceilings, scoped reads, one startup auth check, on-demand Linear MCP,
shared agent permissions, diff posting and the wrap-up
completion marker exception without real Linear writes. Tests print fake-server
poll timings. The test child clock is fixed without any production clock override.
There is no live Linear/Amp sandbox; these are external services covered by fakes.
Root installation and real merge metadata remain unverified by this suite;
the tiny Claude/ultra live probe results are recorded above.
QA coverage includes per-SHA deduplication, new pushes, independent capacity,
engine fallback, thread-bound verdict parsing, direct two-round follow-up,
current-head CI races, self-deploying rename/deletion paths, trusted gate CLI,
document sync and SIGKILL before/after each submission/sync marker boundary.

### Slim prompt contract (MET-144)

AGENTS.md owns shared rules (≤ 1,500 UTF-8 bytes); database and kiosk rules load
only for their areas (each ≤ 4,000 bytes). Builders read Isolation READMEs, not
the root README/full PLAYBOOK by default. Builder fixed text stays ≤ 1,800 bytes;
review carries §5 without another mandatory playbook read. Wrap-up/merge prompts
grant only their narrow exceptions to the shared contract.

Measured with MET-123, title `Build the useful widget today`, gpu/medium,
contributes and no issue content. Builder excludes the complete block from
`## Goal` through `## Done means`, including headings/default bodies. Wrap-up
uses the same fixture; review counts the template with placeholders unchanged.

| UTF-8 bytes | Before | After |
| --- | ---: | ---: |
| AGENTS.md | 4,007 | 1,473 |
| Builder fixed text | 3,512 | 1,607 |
| Wrap-up | 2,509 | 2,143 |
| Review template | 4,154 | 3,948 |

Test-only overrides: `DISPATCH_LINEAR_URL` accepts only loopback
`http://127.0.0.1:<port>/graphql`; `DISPATCH_LOCK_FILE` selects a pre-existing test
lock; `DISPATCH_GITHUB_URL` accepts only a loopback HTTP origin and receives no
credential. Never override the lock for deployed/manual runs. Tests use synthetic key
text, not a credential. No production endpoint, DB or runner is exercised.

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
bash -n deploy/install-dispatch.sh deploy/rollback-dispatch.sh
shellcheck -x deploy/install-dispatch.sh deploy/rollback-dispatch.sh
```
