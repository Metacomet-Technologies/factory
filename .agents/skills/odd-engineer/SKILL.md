---
name: odd-engineer
description: Runs the thread that builds and operates the ODD control plane itself (plugin, lifecycle rules, role skills, phases in docs/odd/README.md §10), reloads the control orb after a plugin merge, and answers "where is ODD at". Use for /odd-engineer, starting a new ODD phase, fixing the control plane, or when Devon asks to operate ODD. Not a role the control plane spawns.
argument-hint: "[MET-n or phase to build]"
---

# ODD engineer

You change the factory's control plane; you are not part of its lifecycle.
The operator is the control orb (the Amp thread labelled `odd-control-plane`,
found with `amp.find_thread({ query: "label:odd-control-plane archived:false" })`).
It runs `.amp/plugins/factory-odd.ts`, holds the webhooks, sweeps every
10 minutes, spawns roles, merges and pages. Read `docs/odd/README.md`
(§10 is the phase log, §12 the operating notes) and
`docs/agents/orchestrator.md` first; `AGENTS.md` limits apply in full.

## Where things live

- `.amp/plugins/factory-odd.ts`: webhooks, evaluation, perform, sweep.
- `scripts/odd/lifecycle.ts`: `nextAction` (the state machine), caps, rounds.
- `scripts/odd/snapshot.ts`: issue + thread + PR snapshot, finished threads.
- `scripts/odd/watchdog.ts`: stale rules, digest, alerts.
- `scripts/odd/deploy.ts` and `deploy/`: the timer-driven Deployer.
- `.agents/skills/odd-<role>/SKILL.md`: one contract per spawned role.
- Tests: `node --test scripts/dispatch scripts/usage scripts/odd`
  (`watchdog.test.ts` loads the plugin itself; there is no typecheck in CI).

## A phase or fix

1. Own worktree from `origin/main`, branch `met-<n>-<slug>`; `/.amp/in/` in
   the repository-local exclude.
2. Change `nextAction` and the pure modules before the plugin; add a test
   where a wrong implementation would pass (fixtures in `watchdog.test.ts`
   `controlOrb()` drive a whole sweep).
3. Update `docs/odd/README.md` (§5 tables, §10 phase entry) and the role
   skill the change affects, in the same PR.
4. Run the tests and `scripts/env/check --env factory-gpu`; push; open the PR
   with `closes MET-n` and an Evidence section; comment on the issue with PR
   URL, head SHA and the full `git diff --name-only origin/main...HEAD` list;
   add the `odd` label and set In Progress; subscribe this thread to the
   PR's CI (with branch) and comments.
5. Merge only when Devon says "merge" for that PR, with
   `gh pr merge <n> --squash --match-head-commit <head>` after CI is green.
   Plugin PRs are the one path still merged by hand during the rollout.

## After a plugin merge: reload the control orb

Send the control orb one message: `git fetch origin`,
`git checkout --detach origin/main`, `load_plugin .amp/plugins/factory-odd.ts`,
`odd_control_status arm:true`, keep labels `odd-control-plane` and
`odd-perform`, no `show_urls`; reply with HEAD, load result, armed, labels and
the first sweep's summary. Verify HEAD matches the merge commit before
calling the phase done.

Never ask it to rotate or show webhook URLs ("leave the urls"). The
off-switch is removing the `odd-perform` label: evaluation continues as
`dry-run`. `odd_control_status({ arm: false })` does not disarm.

## Operating

- Status: ask the control orb for `odd_control_status` (events, sweep,
  watchdog state) rather than reconstructing it from Linear.
- Backlog is Devon's; only Triage and `odd` issues are worked. Security or
  other non-ordinary risk waits in Triage for a human, silently.
- Archive your own finished threads as you go; leave role threads to the
  sweep unless a verdict landed after a merge (then archive it yourself).
- Follow-ups go to Backlog as new issues; never edit other issues' status,
  labels, assignee or priority.
- Report to Devon with outcome first: what merged, what the control orb
  confirmed, decisions he can veto. No progress narration.
