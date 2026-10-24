---
name: odd-watchdog
description: Describes the deterministic ODD Watchdog sweep in the control-plane plugin (stale-thread cancellation, caps and blind alerts, the one page format, the daily digest) so an agent reading its comments, alerts or pages can interpret them. Use when acting on a Watchdog cancellation comment, an alert in #factory-alerts, or a page; the Watchdog is the only role that pages Devon.
---

# ODD Watchdog

Contract source: `docs/odd/README.md` §4, §5.3, §8. No stop condition and
no agent thread: the sweep is deterministic code in
`.amp/plugins/factory-odd.ts` (`sweep`) with its rules in
`scripts/odd/watchdog.ts`. Agents load this skill only to interpret what the
Watchdog wrote; nothing here is a step for an agent to perform.

## Inputs

Live thread labels (`odd-issue-*`, `odd-role-*`, `odd-round-*`,
`odd-verdict-*`) with each thread's state and `updatedAt`, Linear issue
states and comments, open PRs with head SHAs and CI results, deploy
receipts, `capacity` and `nextAction` from `scripts/odd/lifecycle.ts`.

## Sweep (deterministic, every `sweepMs` = 10 min)

The control plane evaluates every issue with a live role thread, every
`Backlog`/`Triage` issue, and every `odd` issue in `Todo`, `In Progress` or
`Deploying`, running `nextAction` for each; a webhook batch does not trigger
a sweep.

1. When an action waits on an idle thread of the stuck role for longer than
   `staleMs` (15 min, by thread `updatedAt`), the control plane archives the
   thread, comments `odd-watchdog cancelled role=<role> thread=<id> round=<n>`
   on the issue, restores the status `restoreStatus` names (a builder with no
   PR goes back to `Todo`; everything else keeps its status) and re-evaluates
   at once, which starts the next round or pages `budget-ceiling` when the
   role's rounds are spent. A delivered thread (a reviewer that carries a
   verdict label, a verifier labelled `odd-receipt-<sha12>` for an older
   receipt) holds no round and is never stale; a thread the search index has
   not dated yet is never stale. Verifier rounds and cancellations count per
   receipt: a new release's receipt starts a fresh verifier budget.
2. Load over the soft caps (`overCaps`) for `capsAlertMs` (60 min) posts
   one message to `#factory-alerts`; the episode resets when load drops.
3. Every sweep call failing for `blindMs` (15 min) pages
   `control-plane-blind` once per episode.
4. The daily digest posts once per `America/New_York` day at 08:00
   (`digestDue`); before posting, the sweep searches `#factory-alerts` for
   `ODD digest <day>`, so a plugin reload does not post the day twice.

The sweep reads every page of the Linear issue lists and the thread search.

Reviewer and verifier threads start from the lifecycle on the normal path;
the sweep only cancels and restores. Dispatcher-owned issues (no `odd` label
past `Todo`) are recorded as `ignored`, never spawned.

## Budget spent

`rounds` in `contracts` is the whole budget: builder 3, reviewer 2, verifier
2, intake and spec 1. When a round is spent the control plane adds the
Linear label `escalated`, pages `budget-ceiling` (PR back to draft when one
exists), and waits while the label is present. Devon removes the label to
resume; the next evaluation starts a fresh round. There is no retry on
another engine.

## Paging

Every page comes from the control plane in one format, by Slack DM, built by
`pageText` in `scripts/odd/lifecycle.ts`:
`ODD page: <condition> | issue MET-<n> | <PR #n or host> | <sha> | default if
silent: <action>. <detail>`. Conditions: `third-failed-qa-round`,
`failed-rollback`, `irreversible-action`, `security-finding`,
`budget-ceiling`, `control-plane-blind`; defaults are `pageDefaults`. A page
is a no-op while `escalated` is already on the issue. Everything else is a
Linear comment or `#factory-alerts`.

## Daily digest

`digest` in `scripts/odd/watchdog.ts` renders one post to `#factory-alerts`:
PRs merged that day with head and merge SHAs, issues set Done, Bugs filed,
issues waiting on Devon (`escalated`), load against the caps, and that day's
Watchdog cancellations. No diffs, no secrets.

## Authority

Archive threads, comment, restore issue status, add `escalated`, post
alerts and pages. Never merge, deploy, or edit a spec.
