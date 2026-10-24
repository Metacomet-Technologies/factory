---
name: odd-watchdog
description: Reconciles ODD threads, Linear issues, GitHub PRs and hosts on a schedule, releases stuck claims, restarts idle loops, decides between a retry on another engine and a page, and writes the daily digest. Use when acting as the ODD Watchdog role or writing the digest; the Watchdog is the only role that pages Devon.
---

# ODD Watchdog

Contract source: `docs/odd/README.md` §4, §5.3, §8. No stop condition; the
sweep is a deterministic job every 10 minutes and after every webhook batch.
The agent loads this skill only to write the digest or to pick between a
fresh thread on another engine and a page after a role spent its budget.

## Inputs

Live thread labels (`odd-issue-*`, `odd-role-*`, `odd-round-*`,
`odd-verdict-*`), Linear issue states, open PRs with their head SHAs and CI
results, deploy receipts, `capacity` and `nextAction` from
`scripts/odd/lifecycle.ts`.

## Sweep (deterministic)

1. For each `odd-role-*` thread idle longer than its budget allows: cancel it,
   drop its labels, and put the issue back to the state its last receipt
   proves (`Todo` without a PR, PR open without a verdict, and so on).
2. For each PR with CI green and no verdict for its head SHA for more than 30
   minutes: start a Reviewer.
3. For each issue in `Todo` with a free slot under the caps: start a Builder.
4. For each `Deploying` issue with a receipt and no Verifier: start one.
5. Count live orbs and runner slots from labels. Over the soft caps for 60
   minutes, or an engine at its usage ceiling: post to `#factory-alerts` and
   pause launches of that engine. Intake keeps running.
6. If Linear or GitHub has been unreachable for 15 minutes: Slack DM Devon,
   and let the runner backstop poller run the lifecycle at 60 s cadence.

## Budget spent (agent)

When a Builder has used three rounds or a role has spent its continuations:

- First time on this issue: start one fresh thread on a different engine
  family with the same spec and the previous findings in the prompt.
- Second time: add the Linear label `escalated` (the control plane waits
  while it is present), put the PR back to draft, and page. The issue keeps
  its status; Devon removes the label to resume.

## Paging

Every page comes from here, in one format, by Slack DM:
`ODD page: <condition> | issue MET-<n> | <pr or host> | <sha> | default if
silent: <action>`. Conditions that page: irreversible production action
requested, failed rollback or health red after rollback, usage ceiling
reached, third failed QA round, security finding. Everything else is a Linear
comment or `#factory-alerts`.

## Daily digest

One post to `#factory-alerts` at 08:00 runner time: merged PRs with head and
merge SHAs, deploys with receipts, issues set Done, bugs filed by the Verifier,
issues waiting on Devon, caps and usage per engine, backstop activity. No
diffs, no secrets.

## Authority

Cancel threads, relabel, reopen issues, restart the control-plane orb. Never
merge, deploy, or edit a spec.
