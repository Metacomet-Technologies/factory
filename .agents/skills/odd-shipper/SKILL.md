---
name: odd-shipper
description: Merges a PR whose current head SHA has CI green and a ready verdict, using the deterministic qa.ts check and a head-pinned squash merge, then tags the release and posts a merge receipt. Use when acting as the ODD Shipper role or when an agent must stand in for the deterministic shipper job; the stop condition is merged.
---

# ODD Shipper

Contract source: `docs/odd/README.md` §4, §7; merge gate in
`docs/agents/orchestrator.md`. Stop condition: `merged`.

The Shipper is a deterministic job. An agent loads this skill only when the
job refuses for a reason outside its known list and someone must read why.

## Inputs

PR number, head SHA, thread label `odd-verdict-ready-<sha12>` for that SHA,
CI green at that SHA.

## Steps

1. From a worktree at trusted `origin/main`, run
   `node scripts/dispatch/qa.ts check <PR> <SHA>`. Exit code other than 0
   blocks the merge; post the refusal text on the issue.
2. Merge only with `gh pr merge <PR> --squash --match-head-commit <SHA>`.
   Never `--admin`, never `--auto`. A mismatch means a new push happened; stop
   and let the Reviewer run again.
3. Tag and publish the release per `docs/release.md` for every component the
   PR touched. Release notes list components and issue identifiers.
4. Comment the merge receipt on the issue: `odd-merge pr=<n> head=<sha>
   merge=<sha> release=<tag|none>`. Close PRs superseded by this merge with a
   comment naming the replacement.
5. Set the issue status to `Deploying` if a component has a deploy script,
   otherwise hand to the Verifier directly.

## Self-deploying paths

PRs that touch `scripts/dispatch/` or `scripts/usage/` deploy on merge.
`qa.ts check` refuses them with `Ready; merging deploys it`. Under ODD these
merge through the same gate when the spec's risk is `ordinary` and the
Deployer has a canary and rollback for the component. Until phase 5 of
`docs/odd/README.md` §10 ships, hand them to Devon with head SHA and deploy
path, as the orchestrator does today.

## Authority

Merge, tag, close superseded PRs. Never deploy, never edit the spec, never
push to the PR branch.

## Escalation

An irreversible production action named in the spec (data deletion, live DB
migration, infrastructure beyond the listed scripts) is not merged. Post
`ui.confirm({ requireHuman: true })` through the control thread and Slack DM
Devon with the PR and the action. Default when silent: not executed.
