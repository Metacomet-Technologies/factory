---
name: odd-spec
description: Writes the Isolation, Build, Done means and Evidence sections of a Linear issue so a builder can work without asking a human, then moves it from Triage to Todo. Use when acting as the ODD Spec role; the stop condition is spec-complete.
---

# ODD Spec

Contract source: `docs/odd/README.md` §4, §7. Stop condition: `spec-complete`
(`specComplete` in `scripts/odd/lifecycle.ts`: every Done-means item has an
Evidence line).

## Inputs

A Linear issue in `Triage` with a type and an `area:*` label.

## Steps

1. Read `Goal` and `Context`. Read the code the issue touches and the
   `docs/agents/<area>.md` for each area label before writing anything.
2. Write `## Isolation`: the directories, services and hosts the builder may
   touch, and the ones it may not. Name the executor: orb by default; runner
   only when Isolation names a device, a production DB or Tailscale.
3. Write `## Build`: the smallest correct change. Follow the reuse ladder:
   existing code and repository pattern first, then standard library and
   platform features, then and only then something new. No speculative
   abstractions or unrequested configuration.
4. Write `## Done means`: observable outcomes, one per line, each checkable
   after deploy without reading the diff.
5. Write `## Evidence`: one line per Done-means item, same order. Each line is
   a command and its expected result, or `screenshot of <state>`. Prefer
   commands already in the repository (`cargo test -p <crate>`, `vp test
   --run`, `node --test scripts/<dir>`, `scripts/env/check --env <name>`).
6. Fill `## Sandbox check` from `docs/sandbox.md` when the change touches a
   service; otherwise write `none: <reason>`.
7. Set priority 1–4 from impact and urgency. Add a risk line to `Context`:
   `risk: ordinary | security | irreversible`. Set `engine/*` and
   `agent-effort/*` labels per `scripts/dispatch/README.md` §"Choosing engine,
   effort and advisor" only when the default round-robin is wrong.
8. If the work needs more than three build rounds, split into child issues,
   each with its own full spec, and mark blocked-by order.
9. Move the issue to `Todo`. The control plane does the same on its next
   Linear event once `specComplete` holds, and moves a `Todo` issue whose
   spec regressed back to `Triage`.

## Authority

Edit only this issue and children you create. Never push code, never add
`dispatch`, never mark `factory-dispatch` or `factory-qa`.

## Escalation

If risk is `security` or `irreversible` and no existing pattern in the
repository covers it, leave the issue in `Triage`, mention Devon in a comment
with the specific question, and post the same line to `#factory-alerts`.
Nothing builds until he answers.

## Budget

One turn plus three continuations. If the spec cannot be completed, comment on
what is missing and leave the issue in `Triage`.
