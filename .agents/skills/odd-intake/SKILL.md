---
name: odd-intake
description: Turns a Slack message, bare Linear issue, alert or CI failure into one Linear issue in the team template with type and area labels and a duplicate check. Use when acting as the ODD Intake role; the stop condition is issue-triaged.
---

# ODD Intake

Contract source: `docs/odd/README.md` §4, §7. Stop condition: `issue-triaged`.

## Inputs

One of: a Slack message from `#factory-intake` (the control plane pastes it
into your first message with the channel and message `ts`), a Linear issue
created without the required sections (named `Outcome MET-n` in your first
message), a `#factory-alerts` post, or a CI failure on `main`.

## Steps

1. Search Linear (team MET) for an open issue with the same symptom or goal.
   If one exists, comment on it with the new report and link the duplicate;
   do not create a second issue. When your input is a bare Linear issue that
   duplicates an existing one, mark it `Duplicate` of the existing issue.
2. Otherwise create one issue with the team template "Agent task issue"
   (`Goal`, `Context`, `Isolation`, `Build`, `Sandbox check`, `Done means`,
   `Evidence`; see `scripts/dispatch/README.md`), or fill the bare issue you
   were given. Fill `Goal` and `Context` from the report. Leave the other
   sections with their default bodies; Spec owns them.
3. Set exactly one of `Bug`, `Feature`, `Improvement` and at least one
   `area:*` label. Set status `Triage`. Never set priority, assignee or
   `dispatch`.
4. Record the source (Slack channel and message `ts`, alert id, CI run URL) in
   `Context`.

## Linear calls

Use `code_exec` with `import { get_issue, list_issues, save_issue, save_comment } from "linear"`.
`get_issue({ id: "MET-n" })` returns an object; stringify it. There is no
`search_issues`: use `list_issues({ query, team: "Metacomet" })` for the
duplicate check. Do not pass `fields`; the default shape has `status`,
`labels`, `description`. Fill the issue with `save_issue({ id, description,
state: "Triage", labels: [...] })`. The template's section bodies are the
hints shown in the "Agent task issue" template in Linear; copy them from
`get_issue` on any recent Triage/Todo issue if the bare issue lacks them.

## Authority

Create and edit only the issue you created, or the bare issue the control
plane handed you (Intake owns Backlog issues, `docs/odd/README.md` §5.1);
comment and link on duplicates. Never edit another issue's status, labels,
assignee or priority.

## Stop and handoff

Done when the issue is in `Triage` with type and area labels. The Spec role
takes it from there. Intake never pages; an ambiguous report becomes a
question written into `Context` for Spec to resolve.

## Budget

One turn plus two continuations. If a duplicate check cannot complete, file
the issue anyway and say so in `Context`.
