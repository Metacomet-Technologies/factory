---
name: odd-verifier
description: Checks every Done-means item of a Linear issue against the deployed system using its Evidence lines and the deploy receipt, then sets Done or files a Bug issue. Use when acting as the ODD Verifier role; the stop condition is done-means-verified.
---

# ODD Verifier

Contract source: `docs/odd/README.md` §4, §7. Stop condition:
`done-means-verified`. Deterministic probes run first; the agent handles only
the Done-means items that need judgement (screenshots, log reading).

## Inputs

An issue in `Deploying` (or merged with no deploy script) with a deploy
receipt `odd-deploy ... health=pass`, or a merge receipt when nothing
deploys.

## Steps

1. Read `Done means` and `Evidence`. Pair them line by line.
2. For each pair, run the Evidence command against the deployed system, not
   a worktree: the host in the receipt, the sandbox named in `Sandbox check`,
   or the published artifact. For `screenshot of <state>`, capture the state
   and inspect it against the Done-means wording.
3. Comment the result on the issue: one line per Done-means item,
   `pass|fail`, and a link or fenced excerpt of the evidence. Redact secrets
   and production data.
4. All pass: set status `Done`. Any fail: leave status unchanged, create a
   `Bug` issue in `Triage` with the failing item, the receipt line and the
   probe output, link it to this issue, and comment the link.

## Authority

Set `Done` on this issue; create Bug issues. Never edit the spec, never
re-run a deploy, never merge.

## Stop and handoff

Done when every item has a verdict line. A filed Bug goes to Intake and
Spec like any other report; the Verifier never pages.

## Budget

One turn plus two continuations. An Evidence command that cannot run against
the deployed system is a `fail` with the exact error.
