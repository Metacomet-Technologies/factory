---
name: odd-intake
description: Turns a Slack message, bare Linear issue, alert or CI failure into one Linear issue in the team template with type and area labels and a duplicate check. Use when acting as the ODD Intake role; the stop condition is issue-triaged.
---

# ODD Intake

Contract source: `docs/odd/README.md` §4, §7. Stop condition: `issue-triaged`.

## Inputs

One of: a Slack message from `#factory-intake`, a Linear issue created without
the required sections, a `#factory-alerts` post, or a CI failure on `main`.

## Steps

1. Search Linear (team MET) for an open issue with the same symptom or goal.
   If one exists, comment on it with the new report and link the duplicate;
   do not create a second issue.
2. Otherwise create one issue from the template in `scripts/dispatch/README.md`
   (`Goal`, `Context`, `Isolation`, `Build`, `Sandbox check`, `Done means`).
   Fill `Goal` and `Context` from the report. Leave the other sections with
   their default bodies; Spec owns them.
3. Set exactly one of `Bug`, `Feature`, `Improvement` and at least one
   `area:*` label. Set status `Triage`. Never set priority, assignee or
   `dispatch`.
4. Record the source (Slack permalink, alert id, CI run URL) in `Context`.

## Authority

Create and edit only the issue you created; comment and link on duplicates.
Never edit another issue's status, labels, assignee or priority.

## Stop and handoff

Done when the issue is in `Triage` with type and area labels. The Spec role
takes it from there. Intake never pages; an ambiguous report becomes a
question written into `Context` for Spec to resolve.

## Budget

One turn plus two continuations. If a duplicate check cannot complete, file
the issue anyway and say so in `Context`.
