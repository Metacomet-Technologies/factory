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
| Intake | Slack message in `#factory-intake`; Linear issue created without a spec. | A Linear issue in the template, or a comment on the existing issue, with `area:*`, type and a duplicate check. | Create and edit *its own* issue; link duplicates. | Amp low (plugin agent). | 1 turn + 2 continuations. | Never. Ambiguity becomes a question inside the spec. |
| Spec | Issue reaches `Triage` with a type and area. | `## Isolation`, `## Build`, `## Done means`, `## Evidence`, size estimate, risk class. Status moves to `Todo`. | Edit its own issue; split into children; mark blocked-by. | Amp medium or Claude high for `security`/`data` areas. | 1 turn + 3 continuations. | Risk class is `irreversible` or `security` and no existing pattern covers it. |
| Builder | Issue in `Todo` with a free slot. | A PR whose body carries the Evidence section filled with real output; thread labels `odd-round-N`. | Push to its own branch; open and update its PR; comment on its issue. | Routed by the engine table (see §6). | 3 build rounds per issue. | Round 3 fails, or Isolation cannot be respected. |
| Reviewer | PR head SHA with CI green and no verdict for that SHA. | Verdict `ready` or `changes` with findings bound to the SHA; reruns Evidence commands itself. | Request changes; approve. Never pushes to the builder's branch. | Opposite family to the builder (`amp` builders get `claude`, others get `amp`). | 1 per SHA. | Third `changes` verdict on one issue (page: third failed QA round). |
| Shipper | Verdict `ready` on the current head. | Squash merge with `--match-head-commit`; release tag per `docs/release.md`; merge receipt on the issue. | Merge; tag; close superseded PRs. | Deterministic (`qa.ts check` + `gh pr merge`), no agent. | n/a | `qa.ts check` refuses for a reason not in its known list. |
| Deployer | Release published for a component with a deploy script. | Deploy receipt: host, script, SHA, health result, rollback used or not. | `sudo -n /usr/bin/bash <allowlisted script>` on the runner. | Deterministic job on the runner; an Amp low agent only to read logs when a health probe fails. | 1 deploy + 1 rollback. | Rollback fails, or health stays red after rollback (page: irreversible or failed rollback). |
| Verifier | Deploy receipt posted. | `Done` on the issue, or a `Bug` issue filed with the receipt and probe output. | Set Done; file bugs. | Deterministic probes first; Amp low agent for the Done-means items that need judgement (screenshots, logs). | 1 turn + 2 continuations. | Never pages; files a bug and lets Intake handle it. |
| Watchdog | Every 10 minutes (schedule) and on every webhook batch. | Reconciled state: released stuck claims, restarted idle loops, stale PR nudges, daily digest. | Cancel threads; relabel; reopen issues; restart the control-plane orb. | Deterministic sweep; Amp low agent only to write the digest. | n/a | Control plane cannot reach Linear or GitHub for 15 minutes; soft caps exceeded for an hour. |
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
        │ Watchdog: every 10 min and after every batch  │
        │ reconciles threads ↔ Linear ↔ GitHub ↔ hosts  │
        └───────────────────────────────────────────────┘
```

### 5.1 States

Linear status is the outcome state. The plugin never invents a parallel state
machine; it reads status, labels and GitHub and computes the next action.

| Linear status | Meaning | Owner | Leaves when |
| --- | --- | --- | --- |
| Backlog | Idea exists, not yet specified. | Intake | Intake has type + area → `Triage`. |
| Triage | Needs a spec. | Spec | Spec posts Isolation/Build/Done means/Evidence → `Todo`; or splits → children in `Triage`, parent stays. |
| Todo | Ready to build. | Control plane | A slot is free and no blocker is open → `In Progress`. |
| In Progress | A builder thread owns it. | Builder / Reviewer | PR merged → `In Review` is not used; merge receipt → `Deploying` (label `odd:deploying`). |
| Deploying | Release exists, deploy or verify pending. | Deployer / Verifier | Verifier passes → `Done`; rollback → `Todo` with a `Bug` child and `odd:rolled-back`. |
| Done | Deployed and verified. | nobody | — |
| Canceled / Duplicate | Set by Intake (duplicate) or Watchdog (abandoned after 30 idle days with no owner). | | |

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
| `release.published` | GitHub webhook | Enqueue deploy on the runner for each component in the release. | Deployer (runner job) |
| Deploy receipt comment | Linear webhook | Spawn Verifier. | Verifier |
| Verifier ends | Plugin | `Done`, or file Bug and link. | Intake (for the bug) |
| Schedule tick (10 min) | Amp automation on the control thread | Watchdog sweep; backstop poll if no webhook in 20 min. | — |
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
4. Stop at the role's budget (§4) and hand to Watchdog, which decides between
   a fresh thread on another engine (one time) and a page.

Builders therefore never see "try again"; they see "CI job `kiosk` failed at
SHA x with this output; Done means item 3 has no evidence".

## 6. Routing and parallelism

- Builder engine table is the one in `scripts/dispatch/dispatch.ts`
  (`engine/{amp,claude,chatgpt,ultra,cursor,grok,go,docs}` ×
  `agent-effort/*`). ODD adds a default when the issue has no `engine/*`
  label: a round-robin over the available subscription engines weighted by
  the usage collector's remaining headroom, so no family is preferred and
  nothing is silently substituted. `ultra` still requires the explicit label.
- Executor: orb by default for Builder, Reviewer, Spec, Intake, Verifier
  (judgement part). Runner only for Deployer, hardware checks, and anything
  whose Isolation names a device, a production DB or Tailscale. Caps: 4 orbs,
  2 runner slots, counted from live thread labels, not from a ledger.
- Reviewer family is opposite to the builder family (existing rule), so no
  change is approved by the model that wrote it.
- Subscription engines are launched by the runner backstop (`amp -x --mode
  <plugin mode> --executor orb`), because plugin agents created with
  `Agent.createThread` can only use plugin-defined or built-in modes. The
  control plane posts the launch request as a Linear label
  (`odd:launch`); the runner launcher consumes it within one poll. Amp-native
  roles are created directly by the plugin.

## 7. Handoff contracts

Each artifact is machine-checkable before the next role starts.

- Outcome spec (Linear description): `## Goal`, `## Isolation`, `## Build`,
  `## Done means`, `## Evidence` (one line per Done-means item: a command and
  its expected result, or "screenshot of <state>"). Spec is complete when
  every Done-means item has an Evidence line.
- Builder → Reviewer: PR body `## Evidence` with the actual output of each
  Evidence line at the head SHA, the issue comment with PR URL, head SHA and
  file list (AGENTS.md rule), PR open with CI green at the head SHA.
- Reviewer → Shipper: thread label `odd-verdict-ready-<sha12>` or
  `odd-verdict-changes-<sha12>` plus the `factory-qa` marker it already
  posts. Findings bound to file and line.
- Shipper → Deployer: GitHub release whose notes list components and
  issues (`docs/release.md`); merge receipt comment with merge SHA.
- Deployer → Verifier: deploy receipt comment `odd-deploy host=<h>
  component=<c> sha=<s> health=<pass|fail> rollback=<none|sha>`.
- Verifier → Done: comment listing each Done-means item with its evidence
  link; status `Done`.

## 8. Escalation paths

| Condition | Who notices | Channel | Default if Devon is silent |
| --- | --- | --- | --- |
| Spec risk `irreversible` or `security` with no precedent | Spec | Linear mention + `#factory-alerts` | Issue stays in `Triage`; nothing builds. |
| Third `changes` verdict on one issue | Watchdog | Slack DM | Issue back to `Todo`, `odd:needs-devon` label, builder thread paused. |
| Health red after rollback | Deployer | Slack DM | Component left on previous release; all deploys of that component paused. |
| Irreversible production action requested by a spec | Shipper or Deployer | Slack DM, `ui.confirm({ requireHuman: true })` in the control thread | Not executed. |
| Soft caps exceeded for 60 min or usage collector shows an engine at its ceiling | Watchdog | `#factory-alerts` | Intake continues; launches of that engine pause. |
| Control plane blind (no Linear/GitHub for 15 min) | Runner backstop | Slack DM | Backstop poller runs the lifecycle at 60 s cadence. |
| Everything else | role | Linear comment | Proceed. |

## 9. Control-plane topology

```diagram
┌──────────────────────── Amp orb: thread "Factory ODD control" ───────────────────────┐
│ .amp/plugins/factory-odd.ts                                                           │
│  webhooks: /linear /github /slack  ─▶ dedupe ─▶ derive state ─▶ next action           │
│  agents: odd-intake, odd-spec, odd-reviewer, odd-verifier, odd-watchdog (Amp-native)  │
│  schedule: 10 min watchdog tick                                                       │
└───────────────┬───────────────────────────────────────────────────────────┬───────────┘
                │ Agent.createThread({executor:'orb'})                      │ Linear label odd:launch
                ▼                                                           ▼
   ┌─────────────────────────┐                              ┌──────────────────────────────┐
   │ builder/reviewer orbs   │                              │ factory-gpu / factory-console │
   │ (up to 4, any engine)   │                              │ backstop poller (60 s)        │
   └─────────────────────────┘                              │ launcher: amp -x --mode …     │
                                                            │ deployer: sudo allowlist      │
                                                            └──────────────────────────────┘
```

Why an orb owns the plugin: `amp.createWebhook` and `amp.executor.keepAlive`
exist only in Amp-managed orbs; a runner cannot receive webhooks (no inbound
Tailscale from Linear or GitHub). Why the runner keeps a poller: the orb can
pause, the webhook can be rate-limited (10 events/min) and subscription
engines can only be launched from a shell. The two agree because both derive
state from Linear and GitHub, never from each other.

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
4. Builder and Reviewer on orbs: the plugin spawns Amp-native builders for
   `engine/amp`; the launcher consumes `odd:launch` for subscription engines;
   caps enforced from thread labels; Ralph guard on.
5. Shipper and Deployer: install the sudoers allowlist; the runner deploy job
   consumes `release.published`; canary + rollback; self-deploying paths
   merge through the same gate.
6. Verifier and Watchdog: Done set by evidence; stuck-claim release; daily
   digest; the old wrap-up flow retired.
7. Retire the poller as primary; it stays as the backstop with the 20 minute
   silence rule.

## 11. Risks and open items

- Marker spoofing (MET-120) gets worse when agents merge and deploy. Phase 5
  requires thread-label verdicts read through the Amp API, not Linear
  comments, for the merge decision.
- The sudoers rule is root for `agent` (`deploy/sudoers/README.md`). A
  root-owned checkout is the real boundary and is not in this plan.
- Webhook burst limit (10/min) is fine for one team; a mass relabel would
  queue. The backstop covers it.
- Plugin runtime secrets: the plugin needs a Linear API key and GitHub access
  in the orb. GitHub comes through `gh`; Linear through a project secret.
  Verified in phase 2.
- Decision-model classifications can be wrong or steered by issue text. They
  pick defaults only; anything that widens authority (risk downgrade, merge,
  deploy) is decided by deterministic evidence.
