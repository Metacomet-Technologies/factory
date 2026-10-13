# Linear factory dispatcher (MET-80)

Single-user, outbound-only automation of [PLAYBOOK §4](../../docs/PLAYBOOK.md#4-agent-prompt-template).
No dependencies, database, webhook, OAuth app, new credential, or runner changes.
Node **24.21.0** is pinned in `.node-version` and checked at startup, matching
[the existing eval run](../../evals/ask/README.md). Requires Linux `flock` and the
agent's existing Amp login. This is not the MET-120 hardening project.

```sh
node scripts/dispatch/dispatch.ts poll --dry-run
node scripts/dispatch/dispatch.ts issue MET-123 --dry-run
node --test scripts/dispatch
```

`poll` handles team issues carrying `dispatch`, priority 1–4 then unprioritized
(0), oldest first within a priority. `issue` ignores only the label requirement.
Both also check pending wrap-ups and archives. Blockers must be completed or canceled;
one waiting comment survives subsequent polls. Invalid tasks lose the label and
get reasons. `>` hint lines do not count as section content. Required sections:
Goal, Context, Isolation, Build, Sandbox check, Done means. Empty Link type means
contributes; accepted values are `contributes` and `closes`. Tests get the playbook
defaults when empty. Exactly one Bug/Feature/Improvement and at least one
`area:*` label are required. Group labels use `parent.name` plus the child name;
flattened `runner/gpu`-style labels also work. Orb is refused explicitly.

Configuration:

- `LINEAR_API_KEY_FILE`: `/etc/factory-dispatch/linear-api-key`; read, never logged.
- `DISPATCH_TEAM`: `MET`.
- `DISPATCH_MAX_ACTIVE_PER_RUNNER`: `2`, positive integer.
- `DISPATCH_RUNNERS`: `gpu=factory-gpu,console=factory-console`.

The committed `modes` map sends Amp low/medium/high unchanged; Claude always
uses `external-agent:claude-code` and ignores effort; ChatGPT low uses `gpt56l`,
medium/high use `gpt61s` (**proposed, unverified**). See [Amp CLI evidence](../../docs/amp-cli.md).
Submission success is not execution success. Inspect the thread for results.

## Dispatched agent Linear MCP contract (MET-122)

Dispatched Amp threads use the already-connected personal Linear MCP server.
Devon connected `https://mcp.linear.app/mcp` as `Linear` on 2026-10-13. Each
thread must first verify tool availability and report names without calling a
write tool; if missing, stop and report, never work around it or change settings.
This does not change the dispatcher's GraphQL key, transport, timer or runners.

Agents may read issues, comment progress on their own issue, link their PR, and
create follow-up issues in Backlog related to their issue. They must never change
any existing issue's status, labels, assignee or priority, or edit other issues.
Backlog is allowed only at follow-up creation. The dispatcher retains ownership
of the `dispatch` label, state moves and claim/thread/wrap-up/archive markers.
Agents must never write or delete `<!-- factory-dispatch:… -->` or
`<!-- factory-qa:… -->` markers, except the wrap-up completion authorized below.
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

After opening the PR and after each later push, post one Linear comment on the
task issue with the PR URL, head SHA and complete file list from
`git diff --name-only origin/main...HEAD`. If `git diff origin/main...HEAD` is
under 400 lines, include the full diff. At 400 lines or more, include the file
list plus the full contents of every changed file under `deploy/`, every changed
migration, and every changed script. Identify deleted files explicitly. Use
fenced code blocks; never include secrets or production data. Redact them and
identify any omissions. Reviewers must match the comment's SHA to the PR head.

Only after all wrap-up steps succeed, the wrap-up prompt authorizes one comment
on the task issue with exactly this body:

```text
Wrap-up finished

<!-- factory-dispatch:wrapup-done -->
```

This is the sole marker exception. It reports wrap-up completion, not deployment
verification or permission to mark Done. Archive logic still uses Done and five
quiet minutes; consuming this new marker is deferred to a later change.

Dry-run takes the same read-only lock and performs GraphQL queries, but never
mutates Linear, invokes Amp, or writes files. It prints JSON decisions, exact
mutation documents/variables and shell-quoted Amp flags. To honor the no-prompt
logging rule, `$PROMPT`/`$WRAPUP_PROMPT` stand for the rendered text; the future
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
`<!-- factory-dispatch:claim runner:gpu -->` (or console) comment; call Amp;
post URL plus `<!-- factory-dispatch:thread T-… runner:gpu -->`; move to
In Progress. The claim also stores the original worktree slug, so renaming the
issue does not change cleanup paths.

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

## Archive Done threads after five quiet minutes (MET-127)

After wrap-ups, each pass considers issues with a thread marker, a wrap-up marker,
no `<!-- factory-dispatch:archived -->` marker, and `state.type === "completed"`.
Canceled and other non-Done issues are never archived. Done is the human-controlled
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
2. Post and await `<!-- factory-dispatch:archive-claim -->`, unless it exists.
3. Run `amp threads archive <T-id>` only if the thread is still unarchived in
   the listing.
4. After success or confirmation that it is already archived, post
   `Thread archived.` with `<!-- factory-dispatch:archived -->`; log `archived`.

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

For an already-installed dispatcher, MET-122 adds no deployment artifact, build,
installer invocation or restart. The post-merge wrap-up's `pull --ff-only` in
`/home/agent/work/factory` on factory-gpu deploys the code; the next existing
60-second timer pass uses it. Merge and that pull remain Devon's gates. From Mac,
after confirming the merge and a clean main checkout:

```sh
factory-ssh 'sudo -iu agent bash -c '\''set -e; export GH_TOKEN="$AGENT_GH_TOKEN"; gh auth setup-git; test -z "$(git -C /home/agent/work/factory status --porcelain)"; test "$(git -C /home/agent/work/factory branch --show-current)" = main; git -C /home/agent/work/factory pull --ff-only origin main'\'''
factory-ssh 'sudo -iu agent node /home/agent/work/factory/scripts/dispatch/dispatch.ts poll --dry-run'
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
factory-ssh
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
factory-ssh 'sudo -iu agent node /home/agent/work/factory/scripts/dispatch/dispatch.ts issue MET-123 --dry-run'
```

Before installation, verify the merge metadata convention above using a read-only
Linear attachment query with Devon's key; this remains a human gate. Ensure only
intended issues carry `dispatch`: enabling the timer can dispatch immediately
when the two-minute boot deadline has already passed. Then, from Mac:

```sh
set -o pipefail
console-ssh 'sudo -iu agent amp runner list --json' |
  factory-ssh 'sudo bash /home/agent/work/factory/deploy/install-dispatch.sh'
factory-ssh 'systemctl is-enabled factory-dispatch.timer; systemctl is-active factory-dispatch.timer; systemctl list-timers factory-dispatch.timer'
factory-ssh 'sudo journalctl -u factory-dispatch -f'
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
factory-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-dispatch.sh'
factory-ssh 'systemctl is-active factory-dispatch.timer; systemctl is-enabled factory-dispatch.timer'
```

Expect inactive/not-found and nonzero status after rollback. Key, snapshots,
Linear comments and already-running Amp threads remain. Rollback is removal, not
restoration of a previous dispatcher version. It does not cancel submitted work.

## Offline verification

`node --test scripts/dispatch` runs the real CLI under an isolated environment,
an in-process `node:http` fake Linear GraphQL server and an executable fake Amp
on PATH. It exercises label removal, comment/status results, blockers, validation,
caps/order, all nine mode mappings, slugs/hints, pagination, dry-run, real flock
contention, Amp errors and SIGKILL at dispatch/wrap-up/archive mutation boundaries.
Archive fixtures cover exactly five quiet minutes, ongoing updates, missing and
unreadable timestamps/listings, canceled/non-Done states, missing markers,
failure/retry, the five-attempt limit and already-archived recovery. Fake Amp
deliberately rejects duplicate archives. Overflow fixtures fill gpu, then console,
then wait; explicit grouped/flat labels never overflow. Rendered prompt checks
cover Linear MCP availability, agent permissions, diff posting and the wrap-up
completion marker exception without real Linear writes. Tests print fake-server
poll timings. The test child clock is fixed without any production clock override.
There is no live Linear/Amp sandbox; these are external services covered by fakes.
Root installation, real merge metadata and actual model execution remain unverified.

Test-only overrides: `DISPATCH_LINEAR_URL` accepts only loopback
`http://127.0.0.1:<port>/graphql`; `DISPATCH_LOCK_FILE` selects a pre-existing test
lock. Never override the lock for deployed/manual runs. Tests use synthetic key
text, not a credential. No production endpoint, DB or runner is exercised.

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
bash -n deploy/install-dispatch.sh deploy/rollback-dispatch.sh
shellcheck -x deploy/install-dispatch.sh deploy/rollback-dispatch.sh
```
