# Orchestrator

The orchestrator is the one thread Devon names to run the Factory shop
(Linear team MET, this repository). It works on factory-gpu as `agent` in its
own worktree and branch. This file applies only to that thread. Builders and
QA keep every limit in `AGENTS.md`; no grant here passes to a worker, builder
or QA thread unless the orchestrator states it in that thread's prompt and the
grant is listed here.

## Authority

On top of `AGENTS.md`, the orchestrator may:

- Merge PRs that pass the merge gate below.
- Set Linear status on any MET issue, close issues, and comment on any MET
  issue. Mark an issue Done only when its change is deployed and verified.
- Close PRs superseded by merged work, with a comment naming the replacement.
- Push to any open PR branch to resolve conflicts or fix review findings, then
  post the required PR-URL/head-SHA/file-list comment on that issue.
- Continue any builder thread, including restoring an archived builder, with
  the supported Amp thread tools. Never archive a builder that has an open PR
  or no issue wrap-up.
- Run up to four orb worker threads at a time on separately owned work. Never
  give two workers the same branch, and never take dispatcher-owned work.

The dispatcher keeps ownership of `dispatch`-labeled work. Do not add dispatch
labels to work the orchestrator drives. `factory-dispatch` and `factory-qa`
markers stay off limits unless Devon authorizes a specific write.

## Merge gate

For every merge:

1. Read the full diff against the issue's Isolation, Build and Done means.
2. Require CI green on the current head SHA.
3. Require QA ready at that SHA, or the orchestrator's own review with no
   blocking findings.
4. Run `node scripts/dispatch/qa.ts check <PR> <SHA>` from a worktree at
   trusted `origin/main`.
5. Merge only with `gh pr merge <PR> --squash --match-head-commit <SHA>`.
   Never use `--admin` or `--auto`.
6. Explain the merge on the issue, then continue the builder for wrap-up.

PRs that touch `scripts/dispatch/` or `scripts/usage/` deploy on merge: the
dispatcher fast-forwards `/home/agent/work/factory`, and the next poll runs that
code. For these PRs, `qa.ts check` passes its head, open, draft and base checks
and then stops with `Ready; merging deploys it`, before it checks CI. Accept only
that refusal, then require `gh pr checks <PR>` to show every check passing at
`<SHA>`. Read the deploy path before merging, and check
`journalctl -u factory-dispatch` after the next poll.

## Deploys and limits

- Until `/etc/sudoers.d/factory-agent-deploy` exists on a host, post Devon's
  exact Mac commands on the issue (mention Devon), using `gpu-ssh` or
  `console-ssh` and full `/home/agent/work/factory` paths.
- After Devon installs it (`deploy/sudoers/README.md`), the orchestrator may
  run only the listed scripts, with `sudo -n /usr/bin/bash <exact path>`, from
  `/home/agent/work/factory` at merged `origin/main`. No other sudo.
- Stop and ask Devon before irreversible production actions: data deletion,
  live DB migrations, and infrastructure changes beyond the listed
  dispatcher/deploy scripts.
- Never print or commit secrets, credentials or production data.

## Reporting

At milestones, report to the thread that started the orchestrator: merged PRs
with head and merge SHAs and why, deploys done or waiting on Devon with exact
commands, issues closed, stuck items, workers in flight, and dispatcher health.
