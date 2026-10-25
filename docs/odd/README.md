# Outcome driven development (ODD)

ODD is how the Factory runs itself. A human puts an *outcome* into the system
(an idea, a bug, an escalation answer). Deterministic code moves that outcome
through a fixed lifecycle; agents with named roles do the thinking inside each
step; every handoff is an artifact the next role can verify without talking to
the previous one. The human is paged only when the system cannot stay safe on
its own.

This document is the design and the audit behind it. The executable parts live
in `.amp/plugins/factory-odd.ts` (control plane), `.agents/skills/odd-*`
(role contracts) and `.factory/stage-policy.json` (authority). Rollout is
tracked under MET-276.

Sources: pstack (`cursor/plugins/pstack`: playbooks, evidence-first, one owner
per PR, "never block on the human"), Ralph Wiggum loops (an agent re-prompted
with the same goal until an external check passes, bounded), ponytail
(`DietrichGebert/ponytail`: the smallest correct change, the reuse ladder,
never cut validation or security), and the Amp orb/plugin/decision-model
docs.

## 1. Decisions (Devon, 2026-10-24)

- Agents merge everything that passes the gate, including self-deploying
  control-plane changes. Canary plus automatic rollback replaces Devon's
  pre-merge review.
- Agents deploy every merged release automatically once the sudoers allowlist
  (`deploy/sudoers/README.md`) is installed. Health checks and automatic
  rollback are mandatory. Devon is told, not asked.
- A one-line idea or bug report becomes a full spec with acceptance criteria
  and starts building without waiting for Devon.
- Control plane moves to an orb-owned Amp plugin driven by Linear and GitHub
  webhooks. Orbs do build and QA. Runners do deploy and hardware work only. A
  slim runner poller stays as a backstop.
- Intake: Linear and Slack (`#factory-intake`). Escalation: Slack DM and
  `#factory-alerts`. Everything else is a Linear comment.
- Guardrails are soft: 4 orb builders + 2 runner slots, 3 build/QA rounds per
  issue, no dollar cap, work spread across every subscription engine.
- Slack DM only for: irreversible production actions, failed rollback, budget
  ceiling, third failed QA round, security findings.
- The `factory-dispatch` timer is stopped until PR #156 is deployed; it comes
  back as the backstop poller.

## 2. Audit of the current pipeline

Verified against `scripts/dispatch/*`, `docs/PLAYBOOK.md`,
`docs/agents/orchestrator.md`, `.factory/stage-policy.json`, the MET board
(271 issues: 198 Done, 56 Backlog, 1 Todo, 1 In Progress) and systemd state
on factory-gpu.

| Stage | Today | Gap against "hands off" |
| --- | --- | --- |
| Intake | Devon writes a full Linear issue (Goal, Isolation, Build, Done means) and adds `dispatch`. | Every idea costs Devon a spec. Slack, alerts and CI failures do not enter the queue. |
| Prioritize | Devon sets Linear priority and the `dispatch` label by hand; the dispatcher takes labelled issues in order. | 56 Backlog issues never move unless Devon touches them. No triage, no dependency ordering, no risk classification. |
| Organize | Labels `engine/*`, `agent-effort/*`, `runner/*`, `area:*` chosen by Devon per issue. | Routing is a human decision per issue. Caps are per runner, not per outcome. |
| Document | The issue is the spec; wrap-up syncs PLAYBOOK to a Linear doc. | No acceptance evidence contract; "Done means" is prose the reviewer interprets. |
| Execute | 60 s poller, flock, one worktree per issue, `amp -x --mode`, 2 slots per runner, orbs refused for factory. | Polling lag, 4 builders max across two machines, orbs unused for the main repo, at-most-once submission. |
| QA | Fresh reviewer per head SHA, `factory-qa` verdict marker, two rounds then Devon. | Reviewer compliance is prompt-level. Round limit pages Devon on the second failure. |
| Release | `qa.ts check` + squash merge with `--match-head-commit`; self-deploying paths refuse. | Devon merges anything under `scripts/dispatch/` or `scripts/usage/`. |
| Deploy | Devon from the Mac over `gpu-ssh sudo`. | Fully human. Nothing deploys while Devon sleeps. |
| Verify | Devon sets Done after checking the deploy. | No deterministic health gate, no automatic rollback. |
| Watch | `--reconcile` lists stuck claims; Devon releases them by hand. Alerts cover hosts, not the pipeline. | Stalls are silent until Devon looks. Timer currently inactive with nothing noticing. |

Structural findings:

1. One process owns everything. `dispatch.ts` (1,238 lines) is intake, router,
   launcher, QA scheduler, merger and wrap-up. Every new engine or rule lands
   there and it is a self-deploying path, so every change waits for Devon.
2. State is spread over Linear comments, Linear labels, a SQLite ledger,
   worktree directories and Amp thread markers. Reconciliation is manual.
3. Authority is prose. `docs/agents/orchestrator.md` grants merge rights; sudo
   is policy, not enforcement (`deploy/sudoers/README.md`).
4. The stage policy exists but is observational only (`spec=Human`).
5. Orbs are proven for the factory toolchain (`docs/orbs.md`: medium orb,
   clippy 38 s, Rust tests 118 s, kiosk checks 3 s) but refused by the
   dispatcher.

## 3. Principles

- Deterministic first. Code decides *when* and *who*; an agent decides *how*.
  A decision model (`amp.ai.decide`) sits between them for cheap typed
  classification (risk, area, size, duplicate). Prose generation is the last
  resort.
- One source of truth per fact. Linear holds work state (status, labels,
  priority, relations). GitHub holds code state (PR, head SHA, checks,
  merge). Amp thread labels hold execution state (`odd-role-*`,
  `odd-issue-*`, `odd-round-*`). The release ledger (`docs/release.md`) holds
  deploy state. Nothing is copied between them; the control plane derives.
- An outcome is a contract. Every issue carries Goal, Isolation, Build,
  Done means and, new, `## Evidence`: the commands or observations that prove
  Done means. Roles hand each other evidence, not opinions.
- Loops are bounded and external. A Ralph loop re-prompts a role with the same
  outcome until an external check (CI, QA verdict, health probe) passes or
  the round budget is spent. The check is never the agent's own claim.
- Escalate by exception, with a decision attached. Every page to Devon states
  the question, the options and the default the system will take if he says
  nothing.
- Smallest correct change. Builders follow the ponytail ladder: does it need
  to exist, is it already here, standard library, platform, installed
  dependency, one line, then the minimum that works, with one test for logic.
  Validation, security, data safety and accessibility are never cut.

## 4. Roles (agent archetypes)

Each role is a skill under `.agents/skills/odd-<role>/SKILL.md` so any engine
(Amp, Claude Code, Grok, Go, Cursor) loads the same contract. The plugin
defines Amp-native agents for the roles that need Amp coordination tools.

| Role | Trigger | Produces | Authority | Engine | Loop budget | Escalates when |
| --- | --- | --- | --- | --- | --- | --- |
| Intake | Slack message in `#factory-intake`; Linear issue in `Triage` without a type or area label (Backlog is never triaged). | A Linear issue in the template, or a comment on the existing issue, with `area:*`, type and a duplicate check. | Create and edit *its own* issue; link duplicates. | Amp low (plugin agent). | 1 turn + 2 continuations. | Never. Ambiguity becomes a question inside the spec. |
| Spec | Issue reaches `Triage` with a type and area. | `## Isolation`, `## Build`, `## Done means`, `## Evidence`, size estimate, risk class. Status moves to `Todo`. | Edit its own issue; split into children; mark blocked-by. | Amp medium or Claude high for `security`/`data` areas. | 1 turn + 3 continuations. | Risk class is `irreversible` or `security` and no existing pattern covers it. |
| Builder | Issue in `Todo` labelled `odd` with a free build slot. | A PR whose body carries the Evidence section filled with real output; the same thread and branch across review rounds. | Push to its own branch; open and update its PR; comment on its issue. | Amp medium (plugin agent); the engine table returns in a later phase (see §6). | 3 review rounds per PR. | Third `changes` verdict, or Isolation cannot be respected. |
| Reviewer | PR head SHA with CI green and no verdict for that SHA. | Verdict `ready` or `changes` as a PR comment and the thread label `odd-verdict-<ready\|changes>-<sha12>`, findings bound to the SHA; reruns Evidence commands itself in its own orb. | Request changes; approve. Never pushes to the builder's branch. GitHub refuses a review on a PR the same account opened, so the verdict is a comment, not a review. | Amp high (plugin agent); opposite family returns with the engine table. | 1 per SHA; 2 rounds after a Watchdog cancellation. | Third `changes` verdict on one issue (page: third failed QA round); second spent round (page: budget ceiling). |
| Shipper | Verdict `ready` on the current head. | Squash merge with `--match-head-commit`; merge receipt `odd-merge pr=<n> head=<sha> merge=<sha>` on the issue; release tag per `docs/release.md` from phase 5. | Merge; tag; close superseded PRs. | Deterministic (`qa.ts check --self-deploying-ok` + `gh pr merge` inside the control plane), no agent. | n/a | `qa.ts check` refuses: the refusal is posted once per head as `odd-merge-refused`; the builder's next push re-enters the loop. |
| Deployer | GitHub release newer than the host ledger's `lastTag` (`factory-deploy.timer` on factory-gpu, every 2 min). | Verified release unpacked under `~/.local/state/factory-odd/releases/<tag>`, each changed enabled component (`meter`, `factory-api`, `kiosk`) installed and probed at the exact SHA, one deploy receipt per issue the release closes. | `sudo -n /usr/bin/bash <allowlisted script>` on the runner; detaches `/home/agent/work/factory` at the release SHA. | Deterministic job (`scripts/odd/deploy.ts`); on a red receipt the control plane starts one Amp low agent on the factory-gpu runner (`odd-deployer`) that only reads logs and attaches them to the Bug. | 1 deploy + 1 rollback per component per release. | Rollback missing, fails, or leaves the component unhealthy on re-probe (`rollback=none`, page: failed rollback). |
| Verifier | Green deploy receipt (`health=pass`) with no `odd-verify` comment for its SHA. | Issue comment `odd-verify sha=<receipt sha> result=pass\|fail bug=<MET-n\|none>` plus one line per Done-means item; a `Bug` issue in `Triage` on fail. The control plane sets `Done` on `pass`. | Comment on its issue; file Bugs. Never sets status. | Amp low (plugin agent); reruns the Evidence lines against the deployed system. | 1 turn + 2 continuations; 2 rounds. | Never pages; files a bug and lets Intake handle it. Second spent round pages (budget ceiling). |
| Watchdog | Every 10 minutes (`setInterval` in the plugin). | Stale idle role threads archived with an `odd-watchdog cancelled` comment and the issue restored (builder without PR → `Todo`); caps alert after 60 min over; `control-plane-blind` page after 15 min of failed sweeps; daily digest at 08:00 America/New_York. | Archive threads; comment; restore status; add `escalated`; post alerts and pages. | Deterministic (`scripts/odd/watchdog.ts`), no agent. | n/a | Every sweep failing for 15 minutes; soft caps exceeded for an hour. |
| Advisor | A role asks a bounded question (`advisor` label or in-thread). | A report-only opinion. | None. | Kimi K3 / Grok advisor tools (existing). | 1 call. | Never. |

Role boundaries that keep this from being "one man":

- A role never writes the artifact it is supposed to check. Reviewer reruns
  Evidence; Verifier reruns probes; Shipper trusts only the verdict bound to
  the exact SHA.
- A role never changes another role's inputs. Builder cannot edit Done means;
  Spec cannot push code; Deployer cannot merge.
- Every page to Devon comes from Watchdog, so there is one voice and one
  format.

## 5. Event lifecycle

```diagram
 Slack #factory-intake      Linear issue created        Alert / CI failure
         │                          │                          │
         └──────────────┬───────────┴──────────────────────────┘
                        ▼
                 ┌─────────────┐   decision model: type, area, dup, risk
                 │   Intake    │──────────────────────────────┐
                 └──────┬──────┘                              │
                        ▼                                     │
                 ┌─────────────┐  status Triage → Todo        │
                 │    Spec     │  (Evidence section required)  │
                 └──────┬──────┘                              │
                        ▼                                     │
   slot free?    ┌─────────────┐  thread labels odd-role-builder, odd-round-N
   engine table  │   Builder   │◀──────────── changes (≤3 rounds) ─────┐
                 └──────┬──────┘                                       │
                        ▼ PR opened / synchronized (GitHub webhook)    │
                 ┌─────────────┐  CI green at SHA?                     │
                 │  Reviewer   │──── verdict:changes ──────────────────┘
                 └──────┬──────┘
                        ▼ verdict:ready at SHA
                 ┌─────────────┐  qa.ts check + merge --match-head-commit
                 │   Shipper   │  release tag (docs/release.md)
                 └──────┬──────┘
                        ▼ release published (GitHub webhook)
                 ┌─────────────┐  allowlisted sudo script on the runner
                 │  Deployer   │──── health red ──▶ rollback ──▶ page
                 └──────┬──────┘
                        ▼ deploy receipt
                 ┌─────────────┐  probes + Done means
                 │  Verifier   │──── fails ──▶ Bug issue ──▶ Intake
                 └──────┬──────┘
                        ▼
                      Done
        ┌───────────────────────────────────────────────┐
        │ Watchdog: every 10 min (plugin setInterval)   │
        │ reconciles threads ↔ Linear ↔ GitHub ↔ hosts  │
        └───────────────────────────────────────────────┘
```

### 5.1 States

Linear status is the outcome state. The plugin never invents a parallel state
machine; it reads status, labels and GitHub and computes the next action.

| Linear status | Meaning | Owner | Leaves when |
| --- | --- | --- | --- |
| Backlog | Idea parked; never worked. | Devon | Devon moves it to `Triage` on demand. The control plane and the sweep ignore Backlog. |
| Triage | Needs type + area, then a spec. | Intake, then Spec | Intake adds type + area (it lacks them → Intake, one round). Spec posts Isolation/Build/Done means/Evidence → `Todo`; or splits → children in `Triage`, parent stays. |
| Todo | Ready to build. | Control plane | A slot is free and no blocker is open → `In Progress`. |
| In Progress | A builder thread owns it. | Builder / Reviewer | PR merged → `In Review` is not used; merge receipt → `Deploying` (label `odd:deploying`). |
| Deploying | Release exists, deploy or verify pending. | Deployer / Verifier | Verifier passes → `Done`; rollback → `Todo` with a `Bug` child and `odd:rolled-back`. |
| Done | Deployed and verified. | nobody | — |
| Canceled / Duplicate | Set by Intake (duplicate) or Devon; the sweep does not cancel abandoned issues yet. | | |

Priority is Linear priority. Spec sets it from the risk class and Devon's
hints; the control plane orders `Todo` by priority, then by age, then prefers
issues that unblock others.

### 5.2 Events and handlers

All handlers are deterministic and idempotent (`event.id` dedupe; actions
keyed by `issue + stage + SHA`).

| Event | Source | Handler | Spawns |
| --- | --- | --- | --- |
| `issue.create`, `issue.update` (status, labels) | Linear webhook | Compute next action for that issue. | Spec, Builder, or nothing. |
| `comment.create` on an issue with an owner thread | Linear webhook | Decision model: is this a human instruction? If yes, `appendUserMessage({steer:true})` to the owner thread. | — |
| `message` in `#factory-intake` | Slack (Amp Slack integration or webhook) | Spawn Intake with the message and permalink. | Intake |
| `pull_request.opened/synchronize` | GitHub webhook | Record head SHA; wait for `check_suite`. | — |
| `check_suite.completed` success on a PR head | GitHub webhook | If no verdict for SHA: spawn Reviewer. | Reviewer |
| `check_suite.completed` failure | GitHub webhook | Steer the builder thread with the failing job names; count a round. | — |
| Reviewer thread ends (`agent.end` with `odd-role-reviewer`) | Plugin | Read verdict label. `ready` → Shipper; `changes` → steer builder, round+1 or page at 3. | Shipper |
| Merge receipt (`odd-merge`) | Control plane | Status `Deploying`; wait `release not published` until a receipt newer than the merge receipt appears. | — |
| Release published | `factory-deploy.timer` poll on factory-gpu (no webhook: the runner reads `gh release list`) | Verify, install changed components, probe, roll back on red, post one receipt per issue in `Deploying`. | Deployer (runner job) |
| Deploy receipt comment | Linear webhook | `health=fail` with a rollback snapshot → `Todo` plus a Bug follow-up in Triage (`Deploy failed: <component> at <sha12>`); `rollback=none` → page. Either red path also starts one log-reading Deployer on factory-gpu (thread label `odd-deploy-<sha12>`). The Bug and the log reader come before `Todo`, so a failure leaves the issue in `Deploying`; a failed evaluation re-checks the issue itself (90 s, doubling, up to 5 times) and a redelivered failed webhook is evaluated again; a page goes out even when its log reader cannot start, and `escalated` is set last. `health=pass` with no `odd-verify` comment for the receipt SHA → spawn Verifier. | Verifier |
| `odd-verify` comment | Linear webhook | `result=pass` for the current receipt SHA → `Done`; `result=fail` → wait on the Bug it filed (the next release's receipt carries a new SHA and is verified again). A merged PR or a verify line for the receipt SHA satisfies the role's stop. | Intake (for the bug) |
| Sweep tick (10 min) | `setInterval` in the plugin, started by `arm` | Watchdog: evaluate every issue with a live role thread, every `Triage` issue (never Backlog) and every `odd` issue in `Todo`/`In Progress`/`Deploying`; cancel threads stale for 15 min (`odd-watchdog cancelled` comment, status restored, immediate re-evaluation); caps alert after 60 min over; `control-plane-blind` page after 15 min of failed sweeps; daily digest. Spawns deferred to the dispatcher (no `odd` label) are recorded `ignored`. | Whatever `nextAction` returns |
| `agent.end` on any `odd-role-*` thread | Plugin | Ralph guard: continue with the role's stop condition unless budget spent or an external check passed. | — |

### 5.3 Ralph loops, bounded

The native loop primitive is the plugin's `agent.end` handler returning
`{ action: 'continue', userMessage, maxContinuations }`. The plugin applies
one rule for every role thread:

1. Read the role from the thread labels (`odd-role-<role>`); the stop
   condition is the role's contract in `scripts/odd/lifecycle.ts`. Labels
   allow only alphanumerics and hyphens.
2. Check it externally (GitHub for a PR, thread label for a verdict, Linear
   for status). If met, do not continue.
3. Otherwise continue with the same outcome text plus the external evidence of
   what is still missing (failing job names, unchecked Done-means items).
4. Stop at the role's budget (§4). The Watchdog sweep archives the idle
   thread once it is stale for 15 minutes, comments `odd-watchdog cancelled
   role=<role> thread=<id> round=<n>`, restores the issue's status (builder
   without a PR → `Todo`) and re-evaluates: a round left starts a fresh
   thread of the same role; rounds spent (`contracts[role].rounds`) pages
   `budget-ceiling` and sets `escalated`.

Builders therefore never see "try again"; they see "CI job `kiosk` failed at
SHA x with this output; Done means item 3 has no evidence".

## 6. Routing and parallelism

- Ownership from `Todo` on is per issue: the Linear label `odd` hands an
  issue to the control plane; without it the dispatcher (`dispatch` label and
  `factory-dispatch` markers) keeps it. ODD owns `Triage` for every issue;
  `Backlog` belongs to Devon. The two never act on the same issue.
- Phase 4 builders are Amp medium plugin agents. The engine table in
  `scripts/dispatch/dispatch.ts` (`engine/{amp,claude,chatgpt,ultra,cursor,
  grok,go,docs}` × `agent-effort/*`) and the usage-weighted round-robin come
  back with the runner launcher (`amp -x --mode <plugin mode> --executor
  orb`, requested through a Linear label), because plugin agents created with
  `Agent.createThread` can only use plugin-defined or built-in modes.
- Executor: orb by default for Builder, Reviewer, Spec, Intake, Verifier
  (judgement part). Runner only for Deployer, hardware checks, and anything
  whose Isolation names a device, a production DB or Tailscale. Caps: 4 orbs,
  2 runner slots, 2 issues in build or review at once, counted from live
  thread labels, not from a ledger. An issue holds its build slot from the
  builder's spawn until the merge, including while it waits for review.
- Reviewer family is opposite to the builder family once the engine table
  returns, so no change is approved by the model that wrote it. Until then
  the reviewer is a separate Amp high thread that reruns the Evidence in its
  own orb.

## 7. Handoff contracts

Each artifact is machine-checkable before the next role starts.

- Outcome spec (Linear description): `## Goal`, `## Isolation`, `## Build`,
  `## Done means`, `## Evidence` (one line per Done-means item: a command and
  its expected result, or "screenshot of <state>"). Spec is complete when
  every Done-means item has an Evidence line.
- Builder → Reviewer: PR body `## Evidence` with the actual output of each
  Evidence line at the head SHA, the issue comment with PR URL, head SHA and
  file list (AGENTS.md rule), PR open with CI green at the head SHA.
- Reviewer → Shipper or Builder: PR comment `odd-verdict ready|changes
  sha=<sha>` with findings bound to file and line, plus the reviewer thread's
  label `odd-verdict-ready-<sha12>` or `odd-verdict-changes-<sha12>`. The
  control plane reads the label; `changes` steers the same builder thread
  once per head SHA. Rounds are counted as distinct heads with a `changes`
  verdict.
- Shipper → Deployer: merge receipt comment `odd-merge pr=<n> head=<sha>
  merge=<sha> release=<tag|none>`; from phase 5 a GitHub release whose notes
  list components and issues (`docs/release.md`).
- Deployer → Verifier: deploy receipt comment `odd-deploy host=<h>
  component=<c> sha=<s> health=<pass|fail> rollback=<none|sha>`, one per
  issue per release. `component` is `+`-joined install order (`meter+kiosk`),
  `none` when the release changed nothing the host runs, or the failed
  component. `rollback` is the snapshot the rollback restored, and only when
  a re-probe finds the previous release healthy. Only receipts newer than the
  issue's latest `odd-merge` comment (by creation time) count, so a stale
  receipt from an earlier merge cannot close a later one.
  Job state: ledger `~/.local/state/factory-odd/deploy.json` (`lastTag`,
  per-component `sha`/`tag`/`health`/`snapshot`, `inFlight` for resume,
  `receipt` with the issues already handled so a crashed delivery resumes
  without redeploying), log `journalctl -u factory-deploy`. A failed
  component record is never a baseline, so the next release retries it.
- Verifier → Done: issue comment whose first line is `odd-verify
  sha=<receipt sha> result=<pass|fail> bug=<MET-n|none>`, then one line per
  Done-means item with its evidence link. The control plane sets `Done` on
  `pass` for the current receipt SHA; a `fail` names the Bug filed in
  `Triage` and the issue waits in `Deploying` for the next release.

## 8. Escalation paths

| Condition | Who notices | Channel | Default if Devon is silent |
| --- | --- | --- | --- |
| Spec risk `irreversible` or `security` with no precedent | Spec | Linear mention + `#factory-alerts` | Issue stays in `Triage`; nothing builds. |
| Third `changes` verdict on one issue | Control plane | Slack DM, `escalated` label, `odd-escalated` comment, PR back to draft | Issue stays `In Progress` and nothing runs until Devon removes `escalated`. |
| Health red after rollback | Deployer | Slack DM | Component left on previous release; all deploys of that component paused. |
| Irreversible production action requested by a spec | Shipper or Deployer | Slack DM, `ui.confirm({ requireHuman: true })` in the control thread | Not executed. |
| Role round budget spent (builder 3, reviewer 2, verifier 2, intake and spec 1) after a Watchdog cancellation | Control plane | Slack DM (`budget-ceiling`), `escalated` label, `odd-escalated` comment, PR back to draft when one exists | Issue waits with no owner thread until Devon removes `escalated`; the next evaluation starts a fresh round. |
| Soft caps exceeded for 60 min | Watchdog sweep | `#factory-alerts`, once per episode | Launches already stop at the caps; the alert only reports it. |
| Control plane blind (every sweep failing for 15 min) | Watchdog sweep | Slack DM (`control-plane-blind`), once per episode | Backstop poller runs the lifecycle at 60 s cadence (phase 7). |
| Control plane silent (no heartbeat for 20 min) | Runner poller | Journal line `odd-backstop-resume`, once per episode | The poller runs the lifecycle until a fresh heartbeat. |
| Everything else | role | Linear comment | Proceed. |

Every Slack DM uses one format, `pageText` in `scripts/odd/lifecycle.ts`:
`ODD page: <condition> | issue MET-<n> | <PR #n or host> | <sha> | default if
silent: <action>. <detail>`. A page is a no-op while the issue already
carries `escalated`.

## 9. Control-plane topology

```diagram
┌──────────────────────── Amp orb: thread "Factory ODD control" ───────────────────────┐
│ .amp/plugins/factory-odd.ts                                                           │
│  webhooks: /linear /github /slack  ─▶ dedupe ─▶ derive state ─▶ next action           │
│  dry run unless the thread carries label odd-perform                                  │
│  agents: odd-intake, odd-spec, odd-builder, odd-reviewer, odd-verifier (Amp-native)   │
│  setInterval: 10 min watchdog sweep (scripts/odd/watchdog.ts), 08:00 ET digest       │
└───────────────┬───────────────────────────────────────────────────────────┬───────────┘
                │ Agent.createThread({executor:'orb'})                      │ Linear label (later phase)
                ▼                                                           ▼
   ┌─────────────────────────┐                              ┌──────────────────────────────┐
   │ builder/reviewer orbs   │                              │ factory-gpu / factory-console │
   │ (4 orbs, 2 issues)      │                              │ backstop poller (60 s)        │
   └─────────────────────────┘                              │ launcher: amp -x --mode …     │
                                                            │ deployer: sudo allowlist      │
                                                            └──────────────────────────────┘
```

Why an orb owns the plugin: `amp.createWebhook` and `amp.executor.keepAlive`
exist only in Amp-managed orbs; a runner cannot receive webhooks (no inbound
Tailscale from Linear or GitHub). Why the runner keeps a poller: the orb can
pause, the webhook can be rate-limited (10 events/min) and subscription
engines can only be launched from a shell. The two agree because both derive
state from Linear and GitHub, never from each other. The control plane writes
one Software Factory project status update, `odd-heartbeat at=<ISO-8601>`,
after each successful sweep and updates that same row on the next. The poller
reads it. Younger than 20 minutes, the poll logs `odd-backstop` and does not
run the lifecycle. Missing or older, it runs the lifecycle and logs
`odd-backstop-resume` once per silence episode. The poller has no Slack
credential, so that journal line is the page; `control-plane-blind` stays the
Slack page for a sweep that keeps failing.

What stays in `scripts/dispatch/`: the launcher (`amp -x` construction,
worktrees, caps), `qa.ts check` and merge, the ledger as the backstop's cache,
and the stage-policy evaluator. What leaves it: polling as the primary
trigger, the QA scheduler, wrap-up orchestration and anything that decides
*what next*.

## 10. Rollout

Each phase is a child issue of MET-276 and ships behind the current system
(phase 1 is MET-276 itself; phases 2–7 are MET-277 to MET-282, each blocked
by the previous one).

1. Contracts: this doc, role skills, `## Evidence` in the issue template,
   `spec=Agent` in the stage policy, orchestrator pointer. No behavior
   change.
2. Control-plane skeleton in an orb: plugin registers webhooks, logs derived
   state, spawns nothing. Linear and GitHub webhooks configured by Devon
   (URLs are secrets; the plugin prints them once to the control thread).
3. Intake and Spec live: Slack and Linear events create specs; builds still
   go through the `dispatch` label so the poller remains in charge.
4. Builder and Reviewer on orbs (MET-279): for issues labelled `odd` the
   plugin spawns an Amp medium builder from `Todo`, sets `In Progress`, spawns
   an Amp high reviewer per head SHA, steers the builder on `changes`, merges
   deterministically on `ready` (self-deploying paths included) and escalates
   after the third rejected head; caps enforced from thread labels; Ralph
   guard on. Subscription engines and the launcher come later.

   First autonomous run: this issue, built, reviewed and merged by the control plane.
   Second run: merged with no human nudge after the recheck-after-spawn fix.
5. Shipper and Deployer (MET-280): sudoers allowlist installed; Devon installs
   `factory-deploy.timer` once (`deploy/install-deploy.sh`,
   `docs/release.md` §"Automatic host deploy"); the job polls releases,
   installs changed components in order with rollback on red, and posts the
   receipt; the control plane sets `Done`, `Todo` + Bug, or pages from the
   receipt. Dispatcher is not auto-deployed (its installer needs the runner
   list on stdin; it retires in phase 7), nor is usage until it has a
   rollback that restores the previous timer. Known consequence: meter and
   factory-api installers run their DB migrations; a rollback restores
   binaries only, so a release with a migration is Devon's call in the spec's
   risk class.
6. Verifier and Watchdog (MET-281): a green receipt spawns an Amp low
   verifier whose `odd-verify` line sets `Done`; the plugin runs a
   deterministic sweep every 10 minutes (`scripts/odd/watchdog.ts`) that
   cancels idle role threads stale for 15 minutes, restores the issue,
   retries one round and pages `budget-ceiling` after that; caps and blind
   alerts once per episode; daily digest at 08:00 America/New_York; one page
   format; `merge()` un-drafts the PR and rechecks after a refusal; a merged
   PR satisfies the builder and reviewer stops. A delivered thread (reviewer
   with a verdict, verifier labelled `odd-receipt-<sha12>` for an older
   receipt) holds no round; verifier rounds count per receipt. The sweep
   reads every page of issues and threads, and the digest is not reposted
   after a plugin reload (it checks `#factory-alerts`). Backlog is on demand
   (MET-304): the sweep and `nextAction` never work a Backlog issue; a Triage
   issue without type + area gets one Intake round, then Spec. The sweep posts
   a cancellation before archiving the thread (a failed comment keeps the
   thread, so the round is not lost) and a blind episode ends only when a
   whole sweep, digest included, succeeds; the digest is split into Slack
   messages of at most 2800 characters. Removing the `odd-perform` label is
   the off-switch: the plane keeps evaluating but records `dry-run`.
7. Retire the poller as primary (MET-282). It stays as the backstop: one
   `odd-heartbeat` project status update per successful sweep, and the poller
   runs the lifecycle only when that heartbeat is missing or 20 minutes old.
   The `dispatch` label is the legacy path for issues the control plane does
   not own. The timer stays at 60 seconds; the skip is inside the poll.

## 11. Risks and open items

- Marker spoofing (MET-120) gets worse when agents merge and deploy. Phase 5
  requires thread-label verdicts read through the Amp API, not Linear
  comments, for the merge decision.
- The sudoers rule is root for `agent` (`deploy/sudoers/README.md`). A
  root-owned checkout is the real boundary and is not in this plan.
- Webhook burst limit (10/min) is fine for one team; a mass relabel would
  queue. The backstop covers it.
- Plugin runtime access: GitHub comes through `gh`; Linear through the
  control thread's own Linear MCP (`ctx.tools.call('linear.get_issue')`), so
  no API key lives in the orb. Thread state comes from `find_thread` and
  `get_thread_status` the same way. Open blockers are not exposed by the
  Linear MCP; until phase 4 adds them, `openBlockers` is empty and builders
  are not spawned (dry run).
- Decision-model classifications can be wrong or steered by issue text. They
  pick defaults only; anything that widens authority (risk downgrade, merge,
  deploy) is decided by deterministic evidence.

## 12. Operating ODD

Three threads exist, with different jobs:

| Thread | What it is | Started by | Lives |
| --- | --- | --- | --- |
| Control orb (label `odd-control-plane`) | The operator: plugin, webhooks, sweep, spawns, merges, pages. | Once; re-armed in place after each plugin merge. | Until the orb dies; then a new orb thread with the label (webhooks re-arm). |
| Role threads (`odd-role-*`) | Intake, Spec, Builder, Reviewer, Verifier, Deployer (log reader). | The control orb. | One round each; the sweep archives finished ones. |
| Engineer (`/odd-engineer`) | Changes ODD itself: a phase, a plugin fix, a role contract. Reloads the control orb after a plugin merge. | Devon, per phase: new thread on this repository with `/odd-engineer MET-n`. | Retire it when the phase is merged and the control orb runs the new HEAD. |

Devon's inputs are: move an idea from Backlog to Triage, file a bug, answer a
page in Slack, decide a non-ordinary risk sitting in Triage, and say "merge"
for a plugin PR (the one path still merged by hand during the rollout).
Status on demand comes from the control orb's `odd_control_status`.

Off-switch: remove the `odd-perform` label from the control thread; it keeps
evaluating and records `dry-run`. Re-add the label to resume. Never rotate or
show the webhook URLs.
