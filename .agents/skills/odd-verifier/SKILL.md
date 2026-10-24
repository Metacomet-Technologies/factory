---
name: odd-verifier
description: Checks every Done-means item of a Linear issue against the deployed system using its Evidence lines and the deploy receipt, then posts the odd-verify line that lets the control plane set Done or files a Bug issue. Use when acting as the ODD Verifier role; the stop condition is done-means-verified.
---

# ODD Verifier

Contract source: `docs/odd/README.md` §4, §7. Stop condition:
`done-means-verified`: a comment on the issue whose first line is
`odd-verify sha=<receipt sha> result=pass|fail bug=<MET-n|none>` for the
receipt SHA named in the prompt. The control plane parses that line
(`parseVerify` in `scripts/odd/lifecycle.ts`) and sets the status itself.

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
4. Comment the result on the issue. First line, exactly:
   `odd-verify sha=<receipt sha> result=pass|fail bug=<MET-n|none>`.
   Then one line per Done-means item, `pass|fail`, with a link or fenced
   excerpt of the evidence. Redact secrets and production data.

The control plane sets `Done` on `result=pass`; on `result=fail` the issue
keeps its status and the Bug goes through Intake and Spec like any report.

## Authority

Create Bug issues and comment on this issue. Never set status, never edit
the spec, never re-run a deploy, never merge.

## Stop and handoff

Done when the `odd-verify` line for the receipt SHA is posted and every
Done-means item has a verdict line. The Verifier never pages.

## Budget

One turn plus two continuations, two rounds per receipt: the Watchdog
cancels an idle thread after 15 minutes and the control plane starts one
fresh round; a second spent round pages `budget-ceiling`. Your thread carries
the label `odd-receipt-<sha12>`; the next release's receipt starts a fresh
budget. An Evidence command that cannot run against the deployed system is a
`fail` with the exact error.
