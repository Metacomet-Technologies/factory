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
Both also check pending wrap-ups. Blockers must be completed or canceled;
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

Dry-run takes the same read-only lock and performs GraphQL queries, but never
mutates Linear, invokes Amp, or writes files. It prints JSON decisions, exact
mutation documents/variables and shell-quoted Amp flags. To honor the no-prompt
logging rule, `$PROMPT`/`$WRAPUP_PROMPT` stand for the rendered text; the future
thread ID is represented by `T-00000000-0000-0000-0000-000000000000`. These are
previews, not runnable commands or real thread links. Normal logs contain only
decisions/identifiers; Amp stdout is captured for the ID and stderr is discarded
because it can include prompts or credentials. Errors report exit/signal or a
fixed diagnostic, never raw API/CLI bodies.

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

## Verified Linear fields; one unverified integration convention

Checked against Linear's [official GraphQL guide](https://linear.app/developers/graphql),
[filtering](https://linear.app/developers/filtering),
[pagination](https://linear.app/developers/pagination), and
[published schema](https://github.com/linear/linear/blob/6f99687aa115c8d82528231d7ec1ca48124f92a0/packages/sdk/src/schema.graphql)
on 2026-10-12. No authenticated Linear API request was made by the dispatcher.

- Endpoint `https://api.linear.app/graphql`, `Authorization: <key>` (not Bearer
  for a personal API key). HTTP success alone is insufficient; check `errors`.
- `issues(filter: IssueFilter, first, after, includeArchived)` and `issue(id)`;
  `id`, `identifier`, `title`, `description`, `priority`, `createdAt`, `team.id/key`.
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
contention, Amp errors and SIGKILL at dispatch/wrap-up mutation boundaries.
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
