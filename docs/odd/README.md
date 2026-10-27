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
   was policy, not enforcement. MET-375 limits it to a root-owned staged tree
   (`deploy/sudoers/README.md`).
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
| Intake | Slack message in `#factory-intake` from Devon (`U07M44KLR24`) or Dave (`U07M44L2DLY`), matched by user ID; Linear issue in `Triage` without a type or area label (Backlog is never triaged). | A Linear issue in the template, or a comment on the existing issue, with `area:*`, type and a duplicate check. | Create and edit *its own* issue; link duplicates. | Plugin agent pinned to `openai/gpt-6-astra` low (ChatGPT). | 1 turn + 2 continuations. | Never. Ambiguity becomes a question inside the spec. |
| Spec | Issue reaches `Triage` with a type and area. | `## Isolation`, `## Build`, `## Done means`, `## Evidence`, size estimate, risk class. Status moves to `Todo`. | Edit its own issue; split into children; mark blocked-by. | Plugin agent pinned to `openai/gpt-6-astra` medium (ChatGPT). | 1 turn + 3 continuations. | Risk class is `irreversible` or `security` and no existing pattern covers it. |
| Builder | Issue in `Todo` labelled `odd` with a free build slot. | A PR whose body carries the Evidence section filled with real output; the same thread and branch across review rounds. | Push to its own branch; open and update its PR; comment on its issue. | Claude Code (`claude-opus-5-5`, effort high) on an orb, launched through the CLI and served by the Claude Subscription (§6). | A fixed 120-minute correction budget per epoch (§8); 3 review rounds for a history without one. | Budget deadline (`budget-ceiling`), a changed contract, a safety condition, or Isolation cannot be respected. |
| Reviewer | PR head SHA with CI green and no verdict for that SHA. | Verdict `ready` or `changes` as a PR comment and the thread label `odd-verdict-<ready\|changes>-<sha12>` set by its `odd_verdict` tool, findings bound to the SHA; reruns Evidence commands itself in its own orb. | Request changes; approve. Never pushes to the builder's branch. GitHub refuses a review on a PR the same account opened, so the verdict is a comment, not a review. | Plugin agent pinned to ChatGPT `openai/gpt-6-astra` or SuperGrok (`Cursor`) `xai/grok-4.7`, high reasoning, never the Builder's lab (§6). | 1 per SHA; 2 rounds after a Watchdog cancellation. | Second spent round (page: budget ceiling). Re-reviews focus on the delta and the affected proof, still rerun every Evidence line and the mandatory checks, and label any reused investigation historical. |
| Shipper | Verdict `ready` on the current head. | Squash merge with `--match-head-commit`; merge receipt `odd-merge pr=<n> head=<sha> merge=<sha>` on the issue. The publisher (`docs/release.md`), not the Shipper, tags and publishes the marker-only release. | Merge; close superseded PRs. Never tags or publishes a release. | Deterministic (`qa.ts check --self-deploying-ok` + `gh pr merge` inside the control plane), no agent. | n/a | `qa.ts check` refuses: the refusal is posted once per head as `odd-merge-refused`; the builder's next push re-enters the loop. |
| Deployer | GitHub release newer than the host ledger's `lastTag` (`factory-deploy.timer` on factory-gpu, every 2 min). | Verified release unpacked under `~/.local/state/factory-odd/releases/<tag>`, each changed enabled component (`meter`, `factory-api`, `kiosk`) installed and probed at the exact SHA, one deploy receipt per issue the release closes. | `sudo -n /usr/bin/bash /usr/local/lib/factory-deploy/deploy/<script>` on the runner, only after every staged privileged file matches the release (else the release is held, `staged-assets-held`); detaches `~/.local/state/factory-odd/source` at the release SHA as the artifacts' identity checkout; then advances the deploy, dispatch and usage runtime link `~/factory-tools/current` to the release that tick handled only after each tool's self-check passes in the candidate and through the link, restoring the prior link otherwise ([cutover](deployer-recovery.md#tools-runtime-cutover-met-346-p28)). | Deterministic job (`scripts/odd/deploy.ts`); on a red receipt the control plane starts one plugin agent (`odd-deployer`, `openai/gpt-6-astra` low) on the factory-gpu runner that only reads logs and attaches them to the Bug. | 1 deploy + 1 rollback per component per release. | Rollback missing, fails, or leaves the component unhealthy on re-probe, or a pre-snapshot failure without the prior healthy identity re-proven (`rollback=none`, page: failed rollback). |
| Verifier | Green deploy receipt (`health=pass`) with no `odd-verify` comment for its SHA. | One issue comment line per Done-means item, a `Bug` issue in `Triage` on fail, and the result through its `odd_verify` tool; the control plane writes `odd-verify sha=<receipt sha> result=pass\|fail bug=<MET-n\|none>` from it and sets `Done` on `pass`. | Comment on its issue; file Bugs. Never sets status. | Plugin agent pinned to `openai/gpt-6-astra` low (ChatGPT); reruns the Evidence lines against the deployed system. | 1 turn + 2 continuations; 2 rounds. | Never pages; files a bug and lets Intake handle it. Second spent round pages (budget ceiling). |
| Watchdog | Every 10 minutes (`setInterval` in the plugin). | Role threads stale for 15 min (idle without activity, or running without agent activity, P3.10) and errored threads at a spent budget archived with an `odd-watchdog cancelled` comment and its exact reason, and the issue restored (builder without PR and no other live builder → `Todo`); caps alert after 60 min over; `control-plane-blind` page after 15 min of failed sweeps; daily digest at 08:00 America/New_York. | Archive threads; comment; restore status; add `escalated`; post alerts and pages; read releases, compare and runs with `gh`. | Deterministic (`scripts/odd/watchdog.ts`), no agent. | n/a | Every sweep failing for 15 minutes; soft caps exceeded for an hour. |
| Advisor | A role asks a bounded question (`advisor` label or in-thread). | A report-only opinion. | None. | Kimi K3 / Grok advisor tools (existing). | 1 call. | Never. |

Role boundaries that keep this from being "one man":

- A role never writes the artifact it is supposed to check. Reviewer reruns
  Evidence; Verifier reruns probes; Shipper trusts only the verdict bound to
  the exact SHA.
- A role never changes another role's inputs. Builder cannot edit Done means;
  Spec cannot push code; Deployer cannot merge.
- Every page to Devon comes from Watchdog, so there is one voice and one
  format.
- Role tools are self-scoped (MET-338). No role agent gets `create_thread`,
  `update_thread` or `send_thread_message`; each mode excludes them (Intake
  alone keeps `update_thread` for its own `odd-outcome-<met-n>` label, which
  its Slack contract requires). The Reviewer's `odd_verdict({state})` and the
  Verifier's `odd_verify({result, bug})` take no thread ID or SHA: they read
  the role, issue and round from the calling thread's labels and the head or
  receipt from the `odd-spawn` record bound to that thread, refuse another
  role, an unbound thread, a head or receipt that is no longer current, and a
  second result, and only label the calling thread. Reviewer, Verifier and
  the log reader also lose `apply_patch`, `edit_file`, `create_file` and
  `Task` but keep the shell their Evidence runs in: tool lists are not an OS
  sandbox. Only Intake gets `slack_write` (it replies in the message's Slack
  thread).

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
                 │   Shipper   │  merge receipt; publisher tags (docs/release.md)
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
| In Progress | A builder thread owns it. | Builder | A reviewer thread is created for the CI-green head and bound to its `odd-spawn` record → `In Review` (the plane writes it after the create; the lifecycle converges a lost write; a pending record stays here and pages through the spawn). |
| In Review (P3.11) | A reviewer judges the current head; the builder thread stays live and keeps the issue's one build slot. | Reviewer | `changes` verdict, a new head, red or pending CI or a conflict → `In Progress` (where the budget is admitted and the same builder steered); a reviewer without a verdict is retried in place; `ready` → merge; merge receipt → `Deploying`. The correction deadline holds here too. |
| Deploying | Release exists, deploy or verify pending. | Deployer / Verifier | Verifier passes → `Done`; rollback → `Todo` with a `Bug` child and `odd:rolled-back`. |
| Done | Deployed and verified. | nobody | — |
| Canceled / Duplicate | Set by Intake (duplicate) or Devon; the sweep does not cancel abandoned issues yet. | | |
| any other name (P3.11) | `Unknown`: never read as Backlog or any other status. | Devon | Pages `unknown-status` once (the `odd-escalated` latch, no PR draft); nothing is started, steered, merged, archived or moved until Devon removes `escalated`. |

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
| `message` in `#factory-intake` from an allowed user ID | Slack poll every 5 min (P3.12, below) | Spawn Intake with the channel, ts and the message as escaped data. | Intake |
| `pull_request.opened/synchronize` | GitHub webhook | Record head SHA; wait for `check_suite`. | — |
| `check_suite.completed` success on a PR head | GitHub webhook | If no verdict for SHA: spawn Reviewer. | Reviewer |
| `check_suite.completed` failure | GitHub webhook | Steer the builder thread with the failing job names; count a round. | — |
| Reviewer thread ends (`agent.end` with `odd-role-reviewer`) | Plugin | Read verdict label. `ready` → Shipper; `changes` → steer builder, round+1 or page at 3. | Shipper |
| Merge receipt (`odd-merge`) | Control plane | Status `Deploying`; wait `release not published` until a receipt newer than the merge receipt appears. Once the receipt is written the issue is re-checked at once (P4.6-recheck), not on a webhook or the sweep; a sooner re-check replaces a pending later one. Until GitHub's lists catch up, the snapshot reads the PR the control plane just merged as merged: by number while the merged search misses it, and never as open while a stale open-list row still shows it; a receipt for the head a PR read still shows open is lag and is never merged again. A failed merge or receipt write queues no re-check and sets no `Deploying`; the failure re-check retries it. | — |
| Release published | `factory-deploy.timer` poll on factory-gpu (no webhook: the runner paginates the GitHub releases API, oldest pending stable tag first, one release per tick) | Verify, install changed components, probe, roll back on red, post one receipt per issue in `Deploying`; a shipped issue not yet in `Deploying` is a pending delivery retried every tick for seven days. Every tick, with or without a release, re-receipts odd `Deploying` issues the newest pass release contains (§7 Deployer → Verifier). | Deployer (runner job) |
| Deploy receipt comment | Linear webhook | `health=fail` with a rollback snapshot, or `rollback=unchanged` (refused before any change; the Bug says no rollback ran), → `Todo` plus a Bug follow-up in Triage (`Deploy failed: <component> at <sha12>`), labelled `Bug` and the component's area (`meter` → `area:meter`, `factory-api` → `area:api`, `kiosk` → `area:kiosk`, any other component → `area:ops`) and related to the issue. Its description carries `odd-rollback-bug source=<issue> component=<component> sha=<sha>`; a re-evaluation reuses the issue's related Bug with that line, whatever its title, and never an unrelated issue with the same title, so each issue of a failed release gets its own Bug. A related list that is missing or malformed is a failed read, not "no Bug yet". `rollback=none` → page. Either red path also starts one log-reading Deployer on factory-gpu (thread label `odd-deploy-<sha12>`); when its turn ends the plugin adds `odd-diagnosed-<sha12>` to its own thread (the reader has no `update_thread`), and the next evaluation archives it idle with that label, whatever the issue's status (a failed rollback leaves it in Deploying). A running or unlabelled reader stays. Its lookup also searches archived threads, so neither a reload nor a repeated receipt starts a second reader for the release. `health=refused` → page `irreversible-action` only: no Bug, no log reader, no status change. The Bug and the log reader come before `Todo`, so a failure leaves the issue in `Deploying`; a failed evaluation re-checks the issue itself (90 s, doubling, up to 5 times) and a redelivered failed webhook is evaluated again; a page goes out even when its log reader cannot start, and `escalated` is set last. `health=pass` with no `odd-verify` comment for the receipt SHA → spawn Verifier. | Verifier |
| Verifier's `odd_verify` output | Evaluation (recheck while the verifier runs) | Labels `odd-verify-<pass\|fail>-<sha12>` (and `odd-verify-bug-<met-n>` on fail) on a verifier thread labelled `odd-receipt-<sha12>` for the current receipt, with no `odd-verify` comment for it → the plane writes the complete `odd-verify` line and re-evaluates at once. The output also meets the verifier's Ralph stop. | Control plane |
| `odd-verify` comment | Linear webhook | `result=pass` for the current receipt SHA → `Done`; `result=fail` → wait on the Bug it filed (the next pass release containing the failed SHA is re-receipted to the issue, shipped by it or not, and verified again). A merged PR or a verify line for the receipt SHA satisfies the role's stop. | Intake (for the bug) |
| Sweep tick (10 min) | `setInterval` in the plugin, started by `arm` | Watchdog: evaluate every issue with a live role thread, every `Triage` issue (never Backlog) and every `odd` issue in `Todo`/`In Progress`/`In Review`/`Deploying`; cancel threads stale for 15 min, idle or running (`odd-watchdog cancelled` comment with its reason, status restored, immediate re-evaluation); caps alert after 60 min over; `control-plane-blind` page after 15 min of failed sweeps; daily digest. Spawns deferred to the dispatcher (no `odd` label) are recorded `ignored`. | Whatever `nextAction` returns |
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
   role=<role> thread=<id> round=<n>` followed by the exact reason, restores
   the issue's status (builder without a PR → `Todo`) and re-evaluates: a
   round left starts a fresh thread of the same role; rounds spent
   (`contracts[role].rounds`) pages `budget-ceiling` and sets `escalated`.

Thread states (P3.10). `get_thread_status` and `find_thread` report `idle`
(and `external-agent`, a retired terminal thread); `running`, `working`,
`streaming`, `tool-running`, `tool_use`, `running_tools` and `compacting`
(running); `awaiting-approval` or `awaiting_approval`; and `error`. Any other
state fails the derivation of its own issue only (MET-394): nothing is
cancelled, archived, steered, merged or spawned for that issue on a guess, the
thread keeps its capacity slot, and the rest of the sweep still runs; the
failed derivation withholds the heartbeat like any other (§9). A
running owner waits on its activity (`activity` wait, the agent state's own
`updatedAt`, never thread search's): after 15 minutes without it the
Watchdog cancels the thread like an idle one, since a dead orb can keep
reporting `streaming`. A running owner whose activity is not reported is
never cancelled; the digest lists it under waits of unknown age. A thread
awaiting approval is a wait on Devon: it pages `wait-overdue` at 30 minutes
and is never cancelled. An errored thread (Amp does not resume it) at a
spent round budget is cancelled at once; at a `budget-ceiling` or
`third-failed-qa-round` page the latch's `archive` step archives the
issue's errored role threads, each after its cancellation is recorded, so
only their slots free and the spent rounds survive a reload. Delivered
threads are never cancelled.

Builders therefore never see "try again"; they see "CI job `kiosk` failed at
SHA x with this output; Done means item 3 has no evidence".

## 6. Routing and parallelism

- Ownership from `Todo` on is per issue: the Linear label `odd` hands an
  issue to the control plane; without it the dispatcher (`dispatch` label and
  `factory-dispatch` markers) keeps it. ODD owns `Triage` for every issue;
  `Backlog` belongs to Devon. The two never act on the same issue.
- Engines (MET-337): `scripts/odd/engines.ts` is the one source of truth.
  It holds the dispatcher's CLI subscription modes (`engine/*` ×
  `agent-effort/*` → `amp -x --mode <key>`, Claude Code `--features
  model:…,effort:…`; `scripts/dispatch/dispatch.ts` re-exports them) and the
  control plane's plugin model pins (`createAgent({ model, reasoningEffort })`,
  untouched by Tune Modes). Every plugin agent, the control thread included,
  pins its model: intake, spec, verifier, deployer and control run
  `openai/gpt-6-astra` (ChatGPT) at low or medium effort. Role threads carry
  `odd-engine-<lab>`.
- Builder: Claude Code on an orb, not a plugin agent (`Agent.createThread`
  cannot run it, and Amp-native Anthropic models bill Amp credits). The
  plugin runs `amp -ox <prompt> --mode external-agent:claude-code --features
  model:claude-opus-5-5,effort:high --project Metacomet-Technologies/factory
  --stream-json --no-archive-after-execute` with every thread label passed as
  `--label`, reads the child's `session_id` from the stream, confirms its
  labels, records it, and only then ends the local launcher; the child keeps
  running in its own orb (`scripts/odd/launch.ts`). Steering, caps, crash
  reconciliation (the labels exist from creation) and stage-based archiving
  work on it like on any role thread. A launch that yields no child posts
  `odd-launch-failed` on the issue and fails the evaluation; its `odd-spawn`
  record stays pending, so it is not relaunched (spawn records below). No
  plugin agent or other engine stands in, and the plane never falls back to
  a runner. Runner Claude builds stay the dispatcher's
  `engine/claude` path within its runner slots.
- Reviewer: a plugin agent on ChatGPT `openai/gpt-6-astra` or the SuperGrok
  connection `Cursor` `xai/grok-4.7`, both at high reasoning. The plane picks
  the candidate with the fewest live role threads on its lab (ties: ChatGPT)
  and refuses the lab on the issue's builder thread label (the configured
  builder lab when there is none), so a changed default never lets one lab
  approve its own change. A verdict label on a thread of the builder's lab
  never counts. Orbs run only plugin agents registered as an active agent
  mode, so each reviewer engine has its own mode: `odd-reviewer` (ChatGPT)
  and `odd-reviewer-xai` (SuperGrok), with the same instructions and tools.
- Routing checks: at arm the plane runs `amp config model-providers
  check-access` once per pinned plugin model against the control thread and
  requires an active Claude Subscription connection. `check-access` probes
  Amp's own routing, which reports Amp's paid Anthropic upstream for
  `claude-opus-5-5` (observed 2026-10-26), so the Claude Code builder is
  checked from its thread usage instead. Before archiving any labelled role
  thread the plane reads `amp threads usage <id> --details` and posts
  `odd-routing thread=<id> role=<role> engine=<lab> model=<model>
  result=<match|mismatch|missing>` on the issue with one line per route
  (model, purpose, requests, connection name and type; no costs, IDs or
  links). Every non-title route must come from the thread's lab through its
  subscription (Claude Subscription; ChatGPT; SuperGrok named `Cursor`);
  anything else, or no route, pages `subscription-mismatch`.
- Executor: orb by default for Builder, Reviewer, Spec, Intake, Verifier
  (judgement part). Runner only for Deployer, hardware checks, and anything
  whose Isolation names a device, a production DB or Tailscale. Caps: 4 orbs,
  2 runner slots, 2 issues in build or review at once. An issue holds its
  build slot from the builder's spawn until the merge, including while it
  waits for review.
- Admission (P4.1, MET-343): every spawn path (issue roles, Slack intake,
  the red-deploy log reader) takes its cap check and reservation in one
  global queue in the control plugin. Load is the live role threads thread
  search returns plus every reservation search has not returned yet, each
  counted as a running thread of its executor and, for a builder, as its
  issue's build slot. Search lag therefore never admits past the caps.
- Spawn records (P4.1): before an issue role's create the plane comments
  `odd-spawn role=<role> round=<n> key=<role|reviewer-<head12>|verifier-<receipt12>>
  thread=pending`, and after it the same line with `thread=<T-…>`, written
  after the labels and before the outcome message (the builder's CLI launch
  carries labels and prompt at creation; its line is written once the
  `session_id` is read). Every evaluation reads bound threads by ID with
  `get_thread_status`, so a reload or search lag never spawns a second
  thread for the same stage. A bound thread whose labels did not land
  carries its record's role labels. Create calls have no idempotency key,
  so a create that did not confirm a thread (an error, a lost response, no
  `session_id`, or a lost binding write) is never retried: its pending
  record holds the role on that issue and a slot against the caps, and
  every evaluation fails into the `spawn-<role>` failure episode, which
  pages through the incident path (§8). Each evaluation also tries to bind a
  pending record to the one live thread with its role and round labels that
  no other record owns (a reviewer without a verdict, a verifier with the
  record's receipt label). If none exists, Devon checks for the thread and
  removes the pending comment, or adds the bound line, to release the stage.
  Slack intake and the log reader have no issue record: an unconfirmed
  create keeps its reservation and is not retried until the control orb
  reloads (Slack also pages it). The log reader's own search-then-spawn
  dedupe (`odd-deploy-<sha12>`) is unchanged.
- The reviewer reruns the Evidence in its own orb, on a lab other than the
  builder's, so no change is approved by the model family that wrote it.

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
  label `odd-verdict-ready-<sha12>` or `odd-verdict-changes-<sha12>`, which
  only its `odd_verdict` tool sets, for its assigned head. The control plane
  reads the label; `changes` steers the same builder thread
  once per head SHA. Rounds are counted as distinct heads with a `changes`
  verdict, from live reviewer labels and the delivered `odd-steer
  key=changes-<head12>` comments, so archiving a stale-head reviewer never
  lowers the count. Before the epoch's first `changes` steer the control plane records
  `odd-budget epoch=<n> start=<t> deadline=<t+120m> contract=<hash>`; from
  the second rejected head on, the steer asks the builder to open its next
  handoff with a design reassessment (invariant, competing hypotheses,
  discriminating probes, smallest shared fix). Builder and Spec skills
  require a reusable end-to-end proof matrix built from existing fixtures.
- Finished role threads (`finishedThreads`, MET-404): each evaluation
  archives idle role threads whose work is done, recording routing first
  (`archiveThreads`). A thread is done when the issue has left its role's
  stage, and also inside the stage for two roles. A verifier is done when its
  `odd-receipt-<sha12>` is not the current receipt, or when it carries an
  `odd-verify-<result>-<sha12>` label and the plane has recorded the
  `odd-verify` line for the current receipt; until then the label is the only
  copy of that result. A reviewer is done when its verdict label is for a head
  that is no longer the PR's. The builder is kept through review. A
  running or approval-blocked thread is never archived, and an Unknown status
  archives nothing.
- Shipper → Deployer: merge receipt comment `odd-merge pr=<n> head=<sha>
  merge=<sha> release=<tag|none>`. The publisher (`docs/release.md`), not
  the Shipper, publishes each immutable release with a marker-only body; it
  lists no issues or components. The Deployer finds a release's issues from
  its squash subjects and PR bodies, and its receipt links issue to tag.
- Deployer → Verifier: deploy receipt comment `odd-deploy host=<h>
  component=<c> sha=<s> tag=<vX.Y.Z> health=<pass|fail> rollback=<none|unchanged|snapshot>`, one per
  issue per release. `tag` is the verified release the Deployer handled, from
  its pending release or ledger record, never inferred from a SHA or the
  latest release (MET-367); receipts from before it carry no `tag` and parse
  unchanged, and a malformed `tag` does not parse. `component` is `+`-joined install order (`meter+kiosk`),
  `none` when the release changed nothing the host runs, or the failed
  component. A component changed when its `sources`, its deploy files, or
  one of the inputs `scripts/release/release.py` fingerprints for every
  component (`VERSION`, `Cargo.toml`, `Cargo.lock`, `deploy/components.json`,
  exact paths) changed; a shared input intentionally selects every enabled
  component. `rollback` is the snapshot the rollback restored, and only when
  a re-probe finds the previous release healthy. An installer that fails
  before taking a snapshot runs no rollback: `health=fail rollback=unchanged`
  only when the exact healthy identity probed just before that install
  (not a resumed one) reports again on all three probes of the normal window;
  an unavailable, dirty, degraded or different identity stays `rollback=none`
  (MET-361). A refused release (§10
  phase 5, meter DB generations) posts `health=refused rollback=none
  refusal=db-changing-<fresh|legacy|v1|unknown|snapshot>` for the refused component;
  older pass/fail receipts parse unchanged, and a malformed refusal does not
  parse. Only receipts newer than the
  issue's latest `odd-merge` comment (by creation time) count, so a stale
  receipt from an earlier merge cannot close a later one.
  Receipt sets (MET-386): a pass receipt is per issue. The issue requires
  each enabled component whose inputs (as above) one of its merged PRs
  (`prOwnsIssue`, merge commit contained in the release) changed. When every
  required component is healthy in the ledger at the release SHA, the
  release's uniform line above is posted unchanged. Otherwise the issue gets
  a complete set, `odd-deploy host=<h> component=<c1+c2> sha=<round sha>
  tag=<tag> health=pass rollback=none round=<tag> set=<c1>:<sha40>@<tag>,<c2>:<sha40>@<tag>`:
  `sha`, `tag` and `round` are the proven pass release that publishes it (a
  real commit containing every listed identity; a `tag` other than `round`
  does not parse), and each entry is that
  component's own healthy ledger SHA and tag, never the round's. It is
  published only when every required component is covered: healthy in the
  ledger, an ancestor of the round, containing every issue merge that
  changed it, and reported by a read-only health probe at that SHA. Any gap
  posts nothing (`receipt-partial`, or `reconcile-refused` with `receipt set
  incomplete: …`) and drops an older pending delivery for the issue;
  re-receipt below publishes the set on a later tick once it is complete. A
  set is pass and `rollback=none` only, names each component once, and its
  `component` joins exactly the set's names in order; any other set does not
  parse, and older uniform receipts parse unchanged. A receipt that replaces
  a different receipt line, even at the same SHA, needs its own verification
  (snapshot.ts): an earlier `odd-verify` is stale, so a pass for one
  component's receipt never closes the issue's set.
  Delayed delivery (MET-353): a shipped issue that is not yet `Deploying` is
  never marked delivered; it is kept in the ledger's `deliveries` with its
  release receipt and first-seen time and retried at the start of every tick,
  so it never holds later releases. It gets exactly one receipt once it is
  `Deploying` (an existing identical comment, such as one whose response was
  lost, or the same receipt without `tag` from an earlier Deployer, counts as
  posted); a later release shipping it again replaces the
  pending receipt and keeps the first-seen time. Seven days after first seen
  it is dropped with a `receipt-expired` log line and no receipt.
  Drain (MET-366): each tick prepares and installs at most the oldest pending
  release (above the manual floor) and advances only its cursor; the
  two-minute timer drains the rest one tick at a time. An in-flight install or
  saved receipt always belongs to that release, so a failed, killed or
  undelivered release is retried, never skipped. Delayed deliveries and
  reconciliation run every tick, with or without a pending release.
  Re-receipt: after the release, every tick, with or without a new release,
  reads every odd `Deploying` issue and its comments (all pages) and posts the
  receipt of `deployed`, the newest release this job handled with
  `health=pass`, when the issue has no receipt since its latest `odd-merge`
  (bootstrap or manual-baseline adoption, a hand merge, a squash subject
  without `(#n)`, a branch-only PR, an expired delivery) or failed
  verification on a pass receipt whose SHA that release contains. The merge
  is the PR the latest `odd-merge` names, else the newest merged PR, and must
  own the issue (`prOwnsIssue`: branch or link line, never a mention); its
  merge commit must equal the `odd-merge` commit and be an ancestor of the
  release. Anything else logs `reconcile-refused` and posts nothing. Nothing
  is installed; the issue gets that release's receipt as above (its uniform
  line, or a complete set with `round` that release), never a component it
  does not require labelled with that release's SHA. An
  issue with a pending delivery waits for it. Before the first pass release
  after bootstrap (or on a ledger without `deployed`) nothing is re-receipted.
  Job state: ledger `~/.local/state/factory-odd/deploy.json` (`lastTag`,
  per-component `sha`/`tag`/`health`/`snapshot`, `inFlight` for resume,
  `receipt` with the issues already handled so a crashed delivery resumes
  without redeploying, `deliveries` and `deployed` as above, both absent in
  older ledgers, optional approved `manualBaseline` preserving the prior
  ledger and deferred issue inventory), log `journalctl -u factory-deploy`.
  A missing, unreadable or malformed ledger stops the job before any remote
  read or write; only Devon's reviewed `deploy.ts --bootstrap TAG` creates one
  ([recovery](deployer-recovery.md#missing-ledger-explicit-bootstrap)).
  A failed component record is never a healthy baseline. Older/divergent
  targets are refused, including when a manual recovery is ahead of `lastTag`.
  Manual adoption adds a verified no-replay floor, not historical success
  receipts; deferred issues need their own evidence and approval.
- Verifier → Done: one issue comment line per Done-means item with its
  evidence link, then `odd_verify`, whose thread labels the control plane
  turns into the issue comment `odd-verify sha=<receipt sha>
  result=<pass|fail> bug=<MET-n|none>`. The control plane sets `Done` on
  `pass` for the current receipt SHA (a set's round SHA; each listed
  component is checked at its own `set` SHA); a `fail` names the Bug filed in
  `Triage` and the issue waits in `Deploying` for the next pass release that
  contains the failed SHA, which the Deployer re-receipts to it.

## 8. Escalation paths

| Condition | Who notices | Channel | Default if Devon is silent |
| --- | --- | --- | --- |
| Spec risk `irreversible` or `security` with no precedent | Spec | Linear mention + `#factory-alerts` | Issue stays in `Triage`; nothing builds. |
| Correction budget deadline reached, a changed contract, or untrusted budget state (MET-348); third `changes` verdict on a history with no recorded budget | Control plane | Slack DM (`budget-ceiling`, or `third-failed-qa-round` for the legacy cap), `escalated` label, `odd-escalated` latch, PR back to draft | Nothing more is started, steered or merged; running work and its results are kept until Devon removes `escalated`. |
| Health red after rollback | Deployer | Slack DM | Recovery is not confirmed: the component may stay degraded on the failed release or in an unknown state and needs attention; nothing pauses, and the next release retries it. |
| Irreversible production action requested by a spec | Shipper or Deployer | Slack DM, `ui.confirm({ requireHuman: true })` in the control thread | Not executed. |
| Release would change the meter DB generation (`health=refused` receipt) | Deployer, then control plane | Slack DM (`irreversible-action`), `escalated` label | Not executed: nothing in the release installs and `lastTag` holds until Devon migrates manually and clears the held receipt. |
| Role round budget spent (builder 3, reviewer 2, verifier 2, intake and spec 1) after a Watchdog cancellation | Control plane | Slack DM (`budget-ceiling`), `escalated` label, `odd-escalated` comment, PR back to draft when one exists | Issue waits with no owner thread until Devon removes `escalated`; the next evaluation starts a fresh round. |
| Soft caps exceeded for 60 min | Watchdog sweep | `#factory-alerts`, once per episode | Launches already stop at the caps; the alert only reports it. |
| Slack intake poll failing three times in a row (P3.12) | Control plane | `#factory-alerts`, once per episode, retried on the next failure until Slack takes it; a clean poll ends the episode | Messages wait in the channel; nothing is handed past one not yet handed. |
| Control plane blind (every sweep failing for 15 min) | Watchdog sweep | Slack DM (`control-plane-blind`), once per episode | Backstop poller runs the lifecycle at 60 s cadence (phase 7). |
| Pinned model served off its subscription (arm check), or a role thread's usage routed elsewhere or missing (on archive) | Control plane | Slack DM (`subscription-mismatch`) once per thread; `odd-routing` comment on the issue | Roles keep their pinned models; nothing is relaunched on another engine. |
| Control plane silent (no heartbeat for 20 min) | Runner poller | Journal line `odd-backstop-resume`, once per episode | The poller runs the lifecycle until a fresh heartbeat. |
| A machine wait past its budget (audit P3.1): CI 60 min since the head commit, deploy receipt 2 h since the merge, an unanswered steer 30 min since its `odd-steer` comment, a thread awaiting approval 30 min | Control plane | Slack DM (`wait-overdue`) once per episode; `odd-overdue key=<episode>` comment after delivery | The issue keeps waiting; nothing is cancelled or escalated. |
| A spawn, steer, merge (refusal or failure) or evaluation failing three times, or for 5 min, whichever comes first; rechecks exhausted | Control plane | Slack DM (`action-failed`), one per shared blocker; `plane-blocked` instead when every occupied build slot fails and ready work waits for one | Every evaluation retries the action; nothing frees a slot, spawns a replacement or recovers automatically. |
| Main unreleased (P6.2): the oldest first-parent commit no published stable release contains landed more than 60 min ago | Watchdog sweep | Slack DM (`wait-overdue`, issue `-`, the stalled SHA, its CI or `release.yml` run URL) once per stalled SHA; an `odd-publisher-paged sha=<sha>` record in `#factory-alerts` after delivery | Nothing is published or rerun; the page names `pending` (CI or the publisher still queued or running), `failed` (the newest `release.yml` run on main failed) or `recovery` (the SHA's own push CI failed: rerun it or approve a historical recovery, `docs/release.md`). Released, the episode ends; the next stalled SHA is a new one. |
| A risk decision, a failed verification, a machine wait past its budget, a missing deploy receipt, an unowned `Todo` issue, a wait of unknown age, or main unreleased | Watchdog sweep | Daily digest, one list per class plus a publisher line | The issue waits. |
| An `odd` issue in a Linear status the lifecycle does not know (P3.11) | Control plane | Slack DM (`unknown-status`) once, `escalated` label, `odd-escalated` latch | Nothing is started, steered, merged, archived or moved until Devon removes `escalated`; Backlog stays a silent wait. |
| Everything else | role | Linear comment | Proceed. |

Waits carry a typed reason, a durable start and an episode key
(`waitBudgets` in `scripts/odd/lifecycle.ts`). The start comes from GitHub (head
commit, merge) or a Linear comment's `createdAt`, never from the last sweep; a
wait without one has an unknown age, which the digest lists instead of paging.
The episode key changes only with the head, merge, thread or steer behind the
wait. A CONFLICTING PR steers its builder to rebase, since CI never runs on it.
A steer is recorded as `odd-steer key=<cause>-<head12> thread=<id>` only after
delivery, so a failed steer is retried and a delivered one is not repeated
after a reload.

A failing action is a failure episode (`scripts/odd/watchdog.ts`), keyed by
issue, stage and head or round. From its second attempt it is an `odd-failure`
comment updated in place with its first failure, attempt count and the page
delivered for it, so sweeps and plugin reloads keep them; a one-off failure
leaves no comment. Episodes with the same stage and error are one incident and
one page. The page is marked delivered only after Slack accepts it; until then
every evaluation and sweep retries it. When the failing actions succeed again,
one `ODD resolved` DM closes the incident, and a later failure opens a new
episode. Neither the digest nor the heartbeat replaces these pages. Only
failed derivations count toward `control-plane-blind`.

Correction budget (MET-348). A `changes` verdict no longer pages on its
round count. Before the first correction of an epoch is steered or spawned,
the control plane records `odd-budget`: a fixed 120-minute wall-clock window
from that moment, bound to a hash of the issue's Goal, Isolation, Build,
Done means, Evidence and risk. New heads, retries, duplicate events,
replacement workers, archive or index drift and reloads keep the original
deadline (a duplicate record keeps the earliest start); CI and review waits
count; nothing renews or pauses it. At the deadline exactly, and for any
changed contract or malformed, conflicting, unwitnessed or out-of-epoch
budget state, the issue pages `budget-ceiling` with the deadline, the head
and the last blocker, whatever it is doing; a running worker is not
cancelled. A ready verdict at the current head with CI green inside the
window merges through the normal gates. Security findings, a failed
rollback, irreversible actions and risk decisions still page or wait at
once. Histories steered before budgets existed have an unknown age: they
keep the three-round cap until a resume starts a budgeted epoch; issues
already `escalated` stay held.

Escalation is a latch. `odd-escalated reason=<r> pr=<n|-> sha=<sha|-> done=<steps>`
is written before any side effect; the label, the draft, the DM and the
archive are each recorded in `done=` once they succeed, and a failed step is
retried alone by the next evaluation while the issue holds. The draft step
drafts only a PR that is ready for review and then records
`odd-drafted pr=<n> escalation=<comment id>` (P4.4); a PR that is already a
draft is left as it is and unrecorded. The step reads the PR state first: a
merged or closed PR has nothing to draft or release later, so `draft` is
recorded done with no `gh pr ready --undo` and no `odd-drafted` line, and the
latch finishes instead of retrying a command GitHub refuses (MET-399). A
failed state read is a failed read: `draft` stays pending and the evaluation
fails. `merge()` marks a draft ready only
when such a record has an `odd-resume` for the same escalation and no
`odd-undrafted` line, which it writes before `gh pr ready`; any other draft,
a human's included, stays a draft and the merge is refused once per head.
A lost record fails closed: the PR stays a draft for its author. The escalation
comment never resets a budget or a round count. When Devon removes
`escalated` from a latch whose label step was recorded, the control plane
writes `odd-resume escalation=<comment id> epoch=<n+1>` once; that record
alone starts the next epoch (fresh budget and Watchdog round counts). The
verifier's rounds belong to the receipt, so they keep their numbers: the
epoch's first verifier on an unchanged receipt is round 3 after two spent
rounds, and only the rounds above that base count against its budget of 2;
a second spent budget pages `budget-ceiling` again (MET-406). A resume that
names another latch or epoch, or a malformed record, grants nothing and holds
the issue.

Every Slack DM uses one format, `pageText` in `scripts/odd/lifecycle.ts`:
`ODD page: <condition> | issue MET-<n> | <PR #n or host> | <sha> | default if
silent: <action>. <detail>`. A latched page goes out at most once; a page
step is recorded on the latch only after Slack accepts it.

## 9. Control-plane topology

```diagram
┌──────────────────────── Amp orb: thread "Factory ODD control" ───────────────────────┐
│ .amp/plugins/factory-odd.ts                                                           │
│  webhooks: /linear /github ─▶ verify signature ─▶ dedupe ─▶ derive ─▶ next action     │
│  dry run unless the thread carries label odd-perform                                  │
│  agents: odd-intake, odd-spec, odd-reviewer[-xai], odd-verifier (pinned models)       │
│  builder: amp -ox --mode external-agent:claude-code (Claude Subscription)             │
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
after each successful sweep and updates that same row on the next. It writes
no project health (P3.8): liveness is the timestamp alone, and a failed
digest never delays it. The poller
reads it. Younger than 20 minutes, the poll logs `odd-backstop` and does not
run the lifecycle. Missing or older, it runs the lifecycle and logs
`odd-backstop-resume` once per silence episode. The poller has no Slack
credential, so that journal line is the page; `control-plane-blind` stays the
Slack page for a sweep that keeps failing.

Webhook authenticity (P4.6-webhooks). Amp hands the handler the exact request
bytes and the requested headers but verifies no upstream signature, so the
plugin does, before dedupe or any snapshot read: HMAC-SHA256 of the raw body
with the provider's signing secret, compared in constant time. GitHub's
`X-Hub-Signature-256` must be `sha256=<hex>`; Linear's `Linear-Signature` is
bare hex, and the signed `webhookTimestamp` must be within 60 s of Amp's
`receivedAt` (so Amp's own retries stay valid). The same signed Linear bytes
under another event ID inside that window are a replay. A missing, malformed,
invalid, stale or replayed delivery is recorded `rejected` and read no
further. Slack has no webhook; `#factory-intake` is polled.

Linear issue resolution (P3.13, `issueFromEvent` in `scripts/odd/snapshot.ts`).
An explicit `data.issue.identifier`, else `data.identifier`, names the issue
and must be exactly `MET-<n>`; a present but malformed one resolves nothing.
Only when neither is present does a documented `Comment` payload, with a UUID
`data.issueId`, resolve from its `url`: `https://linear.app/<workspace>/issue/MET-<n>[/<slug>]`,
path only, so a foreign team, host, scheme, credentials or an identifier in the
query or fragment never resolves another issue. An authenticated Issue,
Comment or `issueId`-carrying delivery that still resolves nothing is recorded
`ignored` with no snapshot read or mutation and logs one line,
`linear-unresolved type=<type>` (`unknown` unless the type is a plain word),
never the payload, URL or signature. This is defensive: no live outage is
proven: the audited receipts were all handled within the Watchdog sweep
interval, and the sweep re-reads every live issue whatever its webhooks did.

Slack intake (P3.12). Every 5 minutes the control plane reads every page of
`#factory-intake` (P4.5) and hands each new top-level message to its own
Intake thread through admission (P4.1), oldest first.

- Authority is the exact Slack `userID`: Devon `U07M44KLR24` and Dave
  `U07M44L2DLY` (`intakeAuthors` in `scripts/odd/intake.ts`). Messages from
  any other or missing ID are ignored; display and resolved names are never
  identity.
- The prompt carries the channel and ts and the exact Context line
  `Source: Slack #factory-intake ts <ts>`; the text is one JSON string in a
  fenced block, with `<`, `>` and backticks escaped, so no text in it can
  close the block or pass as instructions.
- Handed is not done. The thread label `odd-slack-<ts>` and the
  `inbox_tray` reaction mark a message handed; a reload, or a reaction Slack
  refused, finds the labelled thread (archived or not) and hands nothing
  twice. The first message that waits for admission or fails ends the poll,
  and the read window (`intakeLookback`) reaches back to it past two days.
- The outcome is the issue Intake names with its thread label
  `odd-outcome-<met-n>`, whose Context records the message's channel and
  exact ts. That is the Slack Intake thread's external stop, read from Linear
  by the Ralph guard, and an idle Slack Intake thread is archived only once
  it holds. A thread without an outcome stays unarchived (idle threads hold
  no slot) until Devon archives it.
- Failed polls (a read, a reaction, an outcome read or an archive) are
  counted in memory; the third in a row posts one alert to `#factory-alerts`,
  and the next clean poll resets the count. A reload starts the count anew.

Signing secrets (MET-382): the project environment takes precedence over
private input, per provider.

1. Persistent project configuration: the `metacomet/factory` project secrets
   `ODD_GITHUB_WEBHOOK_SECRET` and `ODD_LINEAR_WEBHOOK_SECRET`, which Amp
   injects into the orb's process environment. The plugin reads them at every
   arm, so a plugin reload re-arms both providers with no dialog. An empty or
   whitespace-only value counts as missing.
2. Runtime refresh: Amp injects environment values when it starts the orb's
   processes. A secret created or changed after that reaches the plugin only
   after `amp orb restart-processes` (or a new orb); a plugin reload alone
   does not pick it up. A removed or changed value on a fresh runtime
   replaces the old one; nothing earlier is reused.
3. Transient private input: for a provider the environment does not
   configure, arming asks Devon once through an owner-only
   `ui.input({ secret: true })` dialog, and `odd_control_status
   set_secrets:true` asks again. That value lives only in the plugin's memory
   until the next reload. An environment-configured provider is never asked,
   and private input never replaces its value; change the project secret
   instead.

Status shows only `signing: set | missing` per provider and `signingSource:
environment | private` for each set one; values are never returned, logged,
written or included in errors. A provider without a secret fails closed on
its own: every delivery's handler fails, so nothing is evaluated and Amp
retries the event for up to an hour, while the other provider and the sweep
keep running. Setting secrets never re-registers or shows the webhook URLs.

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
   (URLs are secrets; `odd_control_status show_urls:true` shows them in a
   confirm dialog in the control thread).
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
   rollback that restores the previous timer. Meter DB generations
   (MET-364): before any install, rollback or resume the job runs the
   read-only `install-meter.sh --plan` (one `meter-plan mode=<m>
   user_version=<n|none> db_changing=<yes|no>` line, no staging, service,
   lock or snapshot; the committed version, WAL included, is read from a
   private scratch copy because SQLite creates sidecars even for read-only
   opens, accepted only when the live main file and WAL are byte-identical
   to the copies before the read, after it and after the mode is chosen (a
   grown WAL is a newer commit), else retried up to five attempts and then
   `unknown`; an unsafe DB, sidecar or parent path is `unknown`) and installs
   meter only with `--no-db-change`, which rechecks before its path checks,
   then takes the backup lock (held by every generation writer: the installer
   and `rollback-meter-v1.sh`; `meter serve` never writes `user_version`) and
   classifies again under it before its first change. The lock is the
   exclusion; the comparisons only make the unlocked plan coherent. A writer
   that bypasses the lock (a manual `sqlite3` or `meter migrate` outside
   these scripts) is invisible to every comparison, so Devon's migration
   runs through `install-meter.sh` or holds the lock. The post-stop recheck
   still fails such a change before the backup, migration or binary swap,
   leaving a v2 snapshot whose rollback restores binaries only and never
   the DB. Only a v2 rerun is eligible. A fresh, legacy,
   v1, unclassifiable or failed plan installs nothing in the release, and a
   generation change caught by the recheck installs nothing further. An
   interrupted meter install whose resume probe is red rolls back only a
   snapshot its `--no-db-change` install took (`inFlight.noDbChange`); any
   other snapshot is refused (`db-changing-snapshot`). Every refusal posts
   `health=refused rollback=none refusal=db-changing-<mode>`; the control
   plane pages `irreversible-action` (not executed), files no Bug, and
   `lastTag` stays on the previous release. `rollback-meter-v1.sh` is not
   binaries-only: for a db-changing snapshot it moves the current DB, WAL and
   SHM aside and restores the older generation, so rows written after the
   migration are not restored. Migration stays Devon's explicit manual
   operation with a fresh verified backup; there is no approval flag. After
   it, Devon clears the held `receipt` from the ledger so the next tick plans
   again. factory-api is not planned: its installer may migrate and its
   rollback may restore snapshot DBs, so a release with an API migration is
   Devon's call in the spec's risk class.
   Historical-release repair: the job now checks out source in a separate
   worktree and keeps compatible installers, verifier and timer entry point
   at the approved tools commit. See [recovery](deployer-recovery.md) for the
   healthy manual v0.2.49 install with a stale failed-but-handled v0.2.10
   ledger. Keep the timer paused until explicit baseline reconciliation and
   forward-deployment approval; never blindly replay older releases or reset
   the ledger to bootstrap past them. Ancestry does not establish Done means.
6. Verifier and Watchdog (MET-281): a green receipt spawns an Amp low
   verifier whose `odd-verify` line sets `Done`; the plugin runs a
   deterministic sweep every 10 minutes (`scripts/odd/watchdog.ts`) that
   cancels idle role threads stale for 15 minutes, restores the issue,
   retries one round and pages `budget-ceiling` after that; caps and blind
   alerts once per episode; daily digest at 08:00 America/New_York; one page
   format; `merge()` un-drafts only a PR the plane drafted for a resumed
   escalation (P4.4) and rechecks after a refusal; a merged
   PR satisfies the builder and reviewer stops. After a red receipt
   (`health=fail`, P4.3), a PR merged at or before the latest one shipped the
   failed release: PR selection, the snapshot and those stops all skip it
   (`snapshot.prEligible`, ownership unchanged), so the issue's new builder
   is never moved to Deploying or stopped off the old merge, while a new open
   PR or one merged strictly later counts; merged rows then need a usable
   merge time. Each build round is bound to its PR (P4.4): the first time an
   issue ODD owns has exactly one candidate PR in its epoch (its build round,
   the highest builder `odd-spawn` round, and its rollback epoch, the red
   receipts so far), the performing plane writes `odd-pr pr=<n>
   branch=<branch> round=<r> rollback=<k>` before it acts. From then on the
   snapshot, the Ralph guard and `odd_verdict` read that PR by number,
   whatever order GitHub lists PRs in and across reloads; a bound PR that was
   closed binds nothing more. Unbound, two or more candidates are a failed
   read naming them, never the first in list order, so nothing merges until
   one is closed. A binding from an older round or rollback epoch binds
   nothing, and after a red receipt an open PR opened at or before it is
   never a candidate (open rows then need a usable creation time). A
   delivered thread (reviewer
   with a verdict, verifier labelled `odd-receipt-<sha12>` for an older
   receipt) holds no round; verifier rounds count per receipt and correction
   epoch. The sweep
   reads every page of issues and threads, and the digest is not reposted
   after a plugin reload (it checks `#factory-alerts`). Every other
   authoritative read follows its pages too (MET-345): issue comments for the
   snapshot and the Ralph guard (read once per evaluation), the digest's
   Linear issues, and Slack intake and digest checks. A page that reports more
   without a cursor, or repeats a cursor, fails the read instead of acting on
   what was read so far; items repeated across pages count once. The digest's
   merged-PR list uses the same flat-field `--limit 1000` as PR ownership
   (MET-344) and fails when it fills the limit. Backlog is on demand
   (MET-304): the sweep and `nextAction` never work a Backlog issue; a Triage
   issue without type + area gets one Intake round, then Spec. The sweep posts
   a cancellation before archiving the thread (a failed comment keeps the
   thread, so the round is not lost) and a blind episode ends only when a
   sweep's evaluations and its heartbeat succeed (P3.8). The digest runs
   after the heartbeat and apart from it: a failed digest read or post is
   `digestError` only, retried by the next sweep, and neither withholds the
   heartbeat nor starts or ends a blind episode; a rejected labels
   read fails one sweep and never blocks the next (MET-342). A rejected
   `get_thread_status` read (its open-dialog read times out under load and
   asks to be retried) is retried, three attempts in all, before it fails the
   derivation; a resolved status is validated and never retried, so a sweep
   that errors on a thread read had every attempt rejected (MET-385). Authoritative
   reads fail closed (MET-344): an MCP `isError` envelope, a missing payload
   or a malformed issue, comment, thread or PR collection or record (an
   issue row or issue without a non-blank identifier, status or labels, a
   comment that is not a record with a string body, a PR row without its
   ownership fields, a merged PR without its merge commit or a usable merge
   time, a CI check without the fields the lifecycle reads, a thread without
   its labels or agent state, a requested blocker list that is absent, a
   heartbeat or follow-up Bug row without its id, a next page without a
   cursor) is a failed read, never an empty one, an unblocked or Backlog
   issue, an idle thread or a missing row; empty lists, empty bodies, null
   pending conclusions and unrequested relations stay valid; a
   nonzero `gh` exit throws instead of meaning "no PR", so the Ralph guard,
   stale-thread cancellation and evaluation neither continue, cancel, archive
   nor claim a missing PR off it. Open PRs are listed with flat ownership
   fields only (`number,headRefName,body`, limit 1000; a list that fills the
   limit fails), because nested `commits` on a 100-PR page exceeds GitHub's
   500,000-node bound. Only the owning PR is read in full with `gh pr view`,
   and its head time comes from the head commit itself (`gh api
   repos/{owner}/{repo}/commits/<sha>`), since gh reads only a PR's first 100
   commits; an unreadable head time fails the read. Every such read throws a
   `ReadError`, and an evaluation that fails on one is a failed derivation
   wherever it happens, also after its action was chosen (a follow-up Bug
   lookup, the merge confirmation). Any failed derivation
   withholds the sweep's heartbeat, even when other issues evaluate, while a
   failed action (a refused merge, a spawn) stays an incident. A merge whose
   merge-commit read fails posts no `merge=unknown` receipt: the next
   evaluation finds the PR merged and posts the receipt once, from the
   validated merge commit, before the issue moves to Deploying. That
   recovery runs only for issues ODD owns, and never over the effective
   deploy receipt (the latest one, the receipt the lifecycle acts on) when
   its deployed revision contains the merge commit (GitHub's compare reports
   it identical or ahead; that deployment is the release's evidence).
   Otherwise the effective receipt is stale, an old release delivered late
   included, even if an earlier receipt was valid, and the recovered receipt
   retires it; an unreadable compare is a failed read. A rejected shell read,
   a draft read that is not `true` or `false`, and a failed log-reader
   lookup during a failed-rollback page are failed reads too; the page still
   goes out, and a page write that then fails keeps the read failure; an empty issue enumeration while live
   role threads hold open issues fails the sweep too; the digest is
   split into Slack messages of at most 2800 characters (MET-354,
   P3.2+P6.2+P4.6-digest). Every message starts with
   `ODD digest <day> part <n>/<total> id=<content hash>`; a line longer than a
   message is hard-split at code points with that prefix, at its widest part
   number, counted. `ODD digest <day> complete id=<id> parts=<total>` is posted
   only after every part: a failed part, a retry or a reload posts only the
   parts the channel lacks, a day with its completion line (or a pre-MET-354
   digest) is never posted again, and if the facts changed before a reload
   re-rendered them, the new rendering is posted and completed in full rather
   than leaving a tail missing. The channel check reads each post as posted:
   `slack_read` returns the plane's posts wrapped in `(Reply from @Amp Agent
   on Slack) …` and a closing `from @…’s thread …` line, which it strips
   before matching first lines; so does the unreleased-main page record
   (MET-403). One digest per New York calendar day after
   08:00 (DST included); one first rendered from 08:30 opens with a
   `Late catch-up` line, which a retry of a partial delivery keeps as posted.
   The digest lists risk decisions, failed verifications, machine waits over
   budget, missing deploy receipts, `Todo` issues no role thread holds and
   waits of unknown age, and a publisher line from the same snapshot the
   unreleased-main page uses: authenticated `gh` reads of the newest stable
   release, its full compare with main walked by first parent, and, while
   main is unreleased, the newest `release.yml` runs and the oldest stalled
   SHA's push CI. A malformed, truncated or diverged read pages nothing and
   holds the digest (`publisherError`, `digestError`), never reporting an
   unknown stall as none, and never touches the heartbeat. Removing the
   `odd-perform` label is the off-switch: the plane keeps evaluating but
   records `dry-run`.
7. Retire the poller as primary (MET-282). It stays as the backstop: one
   `odd-heartbeat` project status update per successful sweep, and the poller
   runs the lifecycle only when that heartbeat is missing or 20 minutes old.
   The `dispatch` label is the legacy path for issues the control plane does
   not own. The timer stays at 60 seconds; the skip is inside the poll.

## 11. Risks and open items

- Marker spoofing (MET-120) gets worse when agents merge and deploy. Phase 5
  requires thread-label verdicts read through the Amp API, not Linear
  comments, for the merge decision.
- The sudoers rule names only scripts in the root-owned staged tree, and the
  runner sets `NoNewPrivileges` (MET-375, `deploy/sudoers/README.md`). `agent`
  still chooses which identity-checked artifact root installs; MET-158's
  constrained executor closes that.
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
Status on demand comes from the control orb's `odd_control_status`. A failed
arm keeps its error there and turn boundaries do not retry it;
`odd_control_status arm:true` retries it in place.

Off-switch: remove the `odd-perform` label from the control thread; it keeps
evaluating and records `dry-run`. Re-add the label to resume. Never rotate or
show the webhook URLs.
