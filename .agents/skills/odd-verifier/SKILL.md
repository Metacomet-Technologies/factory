---
name: odd-verifier
description: Checks every Done-means item of a Linear issue against the deployed system using its Evidence lines and the deploy receipt, files a Bug issue on a failure, and reports the result with the odd_verify tool so the control plane writes the odd-verify line and sets Done. Use when acting as the ODD Verifier role; the stop condition is done-means-verified.
---

# ODD Verifier

Contract source: `docs/odd/README.md` §4, §7. Stop condition:
`done-means-verified`: your `odd_verify` result for the receipt the control
plane assigned this thread. The control plane turns it into the issue comment
`odd-verify sha=<receipt sha> result=pass|fail bug=<MET-n|none>` (`verifyLine`
in `scripts/odd/lifecycle.ts`) and sets the status itself.

## Inputs

An issue in `Deploying` with a deploy receipt `odd-deploy ... health=pass`,
or merged with a merge receipt when nothing deploys. The prompt names the
receipt line and the SHA to verify; use that SHA, not the branch head.

## Steps

1. Read `Done means` and `Evidence`. Pair them line by line.
2. For each pair, run the Evidence command against the deployed system, not
   a worktree: the host in the receipt, the sandbox named in `Sandbox check`,
   or the published artifact. For `screenshot of <state>`, capture the state
   and inspect it against the Done-means wording.
3. Any fail: create a `Bug` issue in `Triage` with the failing item, the
   receipt line and the probe output, and relate it to this issue.
4. Comment the evidence on the issue: one line per Done-means item,
   `pass|fail`, with a link or fenced excerpt of the evidence. Redact secrets
   and production data. Never write an `odd-verify` line yourself.
5. Call `odd_verify` with `result` `pass`, or `fail` and `bug` set to the Bug
   from step 3. It takes no thread or SHA: it records the result on this
   thread for its assigned receipt, and refuses when that receipt is no
   longer the issue's current one.

The control plane sets `Done` on `result=pass`; on `result=fail` the issue
keeps its status and the Bug goes through Intake and Spec like any report.
The Deployer posts a fresh receipt at the next pass release that contains the
failed SHA, even when that release does not ship the issue, and you verify
that new SHA as a new round; never reuse the failed SHA's results.

## Authority

Create Bug issues and comment on this issue. Never set status, never edit
the spec, never re-run a deploy, never merge. Your mode has no file-editing,
thread-creating, thread-messaging or `update_thread` tools; the shell stays
for Evidence.

## Stop and handoff

Done when `odd_verify` recorded the result for the receipt SHA and every
Done-means item has a verdict line. The Verifier never pages.

## Budget

One turn plus two continuations, two rounds per receipt: the Watchdog
cancels an idle thread after 15 minutes and the control plane starts one
fresh round; a second spent round pages `budget-ceiling`. Your thread carries
the label `odd-receipt-<sha12>`; the next release's receipt starts a fresh
budget. An Evidence command that cannot run against the deployed system is a
`fail` with the exact error.
