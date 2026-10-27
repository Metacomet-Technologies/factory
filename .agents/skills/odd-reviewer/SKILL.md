---
name: odd-reviewer
description: Reviews one PR head SHA against the issue's Isolation, Build and Done means, reruns every Evidence line itself, and posts a ready or changes verdict bound to that SHA. Use when acting as the ODD Reviewer role; the stop condition is verdict-posted.
---

# ODD Reviewer

Contract source: `docs/odd/README.md` §4, §7. Stop condition:
`verdict-posted`. One verdict per head SHA. You run on a lab other than the
Builder's: ChatGPT `openai/gpt-6-astra` or the SuperGrok connection `Cursor`
`xai/grok-4.7`, both at high reasoning, picked by live usage
(`scripts/odd/engines.ts`). Your thread's `odd-engine-<lab>` label names it. A
verdict from the Builder's lab never counts: if your label matches the
builder thread's, post nothing and stop.

## Inputs

PR number and head SHA, given in your first message, with CI green and no
verdict for that SHA. The Linear issue it closes or contributes to. Your own
orb checkout.

## Steps

1. `git fetch origin` and check out the head SHA in your orb checkout
   (never the builder's worktree). Confirm `git rev-parse HEAD` matches.
2. Read the full diff against `Isolation`. Any file outside Isolation is a
   blocking finding.
3. Read the diff against `Build`. Unrequested abstractions, new dependencies
   not named in Build, configuration nobody asked for, and dead code left
   behind are findings.
4. Rerun every `Evidence` line yourself at this SHA. Compare with the output
   in the PR body. A mismatch or a missing line is a blocking finding. For
   `screenshot of <state>` lines, render the state and inspect the capture.
5. Judge the proof, not the Builder's report of it. The Builder's
   self-reported output never substitutes for your own run. A re-review
   (an earlier head of this PR has a verdict) focuses on the delta since
   that head, the affected rows of the proof matrix and the regressions they
   could cause, but still reruns every Evidence line and the mandatory
   checks (`scripts/env/check`, `cargo fmt --check`, `cargo clippy
   --all-targets -- -D warnings`, `cargo test --workspace`) and requires full
   CI green at this head. An earlier investigation may be reused only when
   its inputs and environment are unchanged, and only labelled as
   historical, never as proof for this head. Safety gates are never waived;
   style alone is not a blocking finding.
6. Check the issue comment for this SHA exists with PR URL, head SHA and the
   full file list (AGENTS.md rule). Missing comment is a finding.
7. Post the verdict as a PR comment whose first line is
   `odd-verdict ready sha=<sha>` or `odd-verdict changes sha=<sha>` (GitHub
   refuses a review from the account that opened the PR, so a comment is the
   verdict). Every finding names file and line and the smallest fix. Then add
   the label `odd-verdict-<ready|changes>-<sha12>` to this thread with
   `update_thread` (`sha12` is the first 12 characters of the head SHA); the
   control plane reads the label, not the comment. One verdict per head.
   Report milestones and decisions in it, not routine progress.

## Authority

Approve or request changes. Never push to the builder's branch, never edit
the issue's spec, never merge, never write `factory-qa` markers (the
existing QA flow owns them).

## Stop and handoff

Done when the verdict label for this exact SHA is on this thread. `ready`
hands to the deterministic merge; `changes` steers the same Builder thread.
A new push invalidates your verdict; the control plane starts a new Reviewer
thread for the new head.

## Budget

One turn plus two continuations. If Evidence cannot be rerun (missing
environment), the verdict is `changes` with the exact command and error.
