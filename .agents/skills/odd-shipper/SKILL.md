---
name: odd-shipper
description: Merges a PR whose current head SHA has CI green and a ready verdict, using the deterministic qa.ts check and a head-pinned squash merge, then posts a merge receipt; the publisher, not the Shipper, tags and publishes releases. Use when acting as the ODD Shipper role or when an agent must stand in for the deterministic shipper job; the stop condition is merged.
---

# ODD Shipper

Contract source: `docs/odd/README.md` §4, §7; merge gate in
`docs/agents/orchestrator.md`. Stop condition: `merged`.

The Shipper is a deterministic job inside the control plane
(`.amp/plugins/factory-odd.ts`, `merge`). An agent loads this skill only when
the job refuses for a reason outside its known list and someone must read
why, or when it stands in for the job by hand.

## Inputs

PR number, head SHA, reviewer thread label `odd-verdict-ready-<sha12>` for
that SHA, CI green at that SHA, issue labelled `odd`.

## Steps

1. From a checkout at trusted `origin/main`, run
   `node scripts/dispatch/qa.ts check <PR> <SHA> --self-deploying-ok`. Exit
   code other than 0 blocks the merge; the refusal is posted once per head on
   the issue as `odd-merge-refused pr=<n> head=<sha>`.
2. Merge only with `gh pr merge <PR> --squash --match-head-commit <SHA>`.
   Never `--admin`, never `--auto`. A mismatch means a new push happened; stop
   and let the Reviewer run again.
3. Comment the merge receipt on the issue: `odd-merge pr=<n> head=<sha>
   merge=<sha> release=<tag|none>`. The merged PR derives the issue's next
   status (`Deploying`) on the next evaluation.
4. Close PRs superseded by this merge with a comment naming the
   replacement. Never write release notes or publish a release: the
   publisher (`docs/release.md`) owns immutable releases whose body is only
   the manifest marker, and the Deployer's `odd-deploy ... tag=<vX.Y.Z>`
   receipt on each issue links the issue to its release.

## Self-deploying paths

PRs that touch `scripts/dispatch/` or `scripts/usage/` deploy on merge. The
dispatcher's `qa.ts check` refuses them with `Ready; merging deploys it`;
under the `odd` label the control plane passes `--self-deploying-ok` and
merges them through the same gate (`docs/odd/README.md` §1). Canary and
rollback for those paths arrive with the Deployer in phase 5.

## Authority

Merge, close superseded PRs. Never tag or publish a release (the publisher
owns them), never deploy, never edit the spec, never push to the PR branch.

## Escalation

An irreversible production action named in the spec (data deletion, live DB
migration, infrastructure beyond the listed scripts) is not merged. Post
`ui.confirm({ requireHuman: true })` through the control thread and Slack DM
Devon with the PR and the action. Default when silent: not executed.
