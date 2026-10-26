# Amp CLI dispatch investigation (MET-116)

Contributes MET-80. Investigated on factory-console as `agent`, 2026-10-12
UTC (2026-10-11 America/New_York), using Amp
`0.0.1791763306-ged595a`, released `2026-10-12T00:01:46.000Z`.
This is a versioned observation, not a stable API guarantee.

## Summary

| Capability | Verified yes/no/partial | Evidence | Source |
| --- | --- | --- | --- |
| Built-in modes | Yes | Help names `low`, `medium`, `high`, `ultra`; `low` executes | CLI help; [Dial][dial] |
| Claude Code runner execution | Yes | After installation: 2.1.296, Max login, streamed Bash pwd and successful reply | Probe H; [Dial][dial] |
| ChatGPT-backed Amp execution | Yes | `gpt56l` and `low` route through linked ChatGPT; no Codex binary | Probes A/B; usage; [Dial][dial] |
| Runner directory/title/attachment | Yes | Correct remote cwd, exact title, attachment URL in prompt | Probe A; [Execute][execute] |
| Runner stdout/exit and concurrency | Yes | Async URL/0; streamed result/0; two threads overlap | A/B; [Execute][execute] |
| Offline runner | Yes | Missing ID exits 1, no thread URL | Offline check |
| Orb dispatch/billing | Partial | MET-184 verified plain `-ox` URL/0 and private factory-access checkout; billing remains docs-only | §3; [Spawn][spawn], [Costs][costs] |
| Runner follow-up with `-x` | No, while attached | Exit 1: already active in another Amp | Follow-up C |
| Runner follow-up with `-ox` | Yes | Existing runner executes; no orb created | Follow-up D; CLI help |
| List fields/archive/visibility | Yes | Five JSON fields; async stays active; streamed new thread archives; private probes | List/status checks; [Threads][threads] |
| Unattended tool permissions | Yes | Default executes; explicit reject denies; explicit ask blocks for human | A/B/E/F; permission tests |
| Runner service lifecycle | Partial | SIGTERM exits 0; restart resumes prior threads; updates/discovery documented | Runner logs; [Runners][runners] |
| Existing login without API key | Yes | Dispatch works with `AMP_API_KEY` absent | All live dispatches; [CLI][cli] |
| `--amp-env` reaches shell tools | Yes | Token removed from process environment, injected into shell; authenticated read succeeds | Probe G; [Runners][runners] |
| New Worktree fetch credentials | Unverified | Shell injection does not prove pre-thread Git fetch injection | [Runners][runners]; PLAYBOOK §8 |

### Sources and modified dates

Fetched official pages live on 2026-10-12 UTC. Dates below are their HTML
`article:modified_time`, not inferred from fetch time. The introduction at
[ampcode.com/docs](https://ampcode.com/docs) reports 2026-09-02.

| Page | Modified date |
| --- | --- |
| [CLI: Getting Started][cli] | 2026-09-25 |
| [The Dial][dial] | 2026-10-10 |
| [Execute Mode][execute] | 2026-09-19 |
| [Spawning Orbs][spawn] | 2026-09-17 |
| [Streaming JSON][stream] | 2026-08-25 |
| [Configuration][settings] | 2026-09-28 |
| [Runners][runners] | 2026-10-10 |
| [Tools: Permissions][tools] | 2026-09-28 |
| [Orbs][orbs] | 2026-09-14 |
| [Sizes & Costs][costs] | 2026-09-24 |
| [Threads][threads] | 2026-09-30 |

## 1. Modes and engine selection

The exact built-in `--mode` values are `low`, `medium`, `high`, `ultra`.
Plugin keys or labels are also accepted, case-insensitively. There is no fixed
global enumeration of plugin modes: installed/shared plugins determine it.
The mode locks on the first message; a follow-up cannot change it.

The factory-scoped Amp mode catalog returned these additional keys on the
investigation date (catalog check, not paid execution of every mode):

```text
claude-fable-5-1, claude-opus-5, claude-opus-5-5,
claude-sonnet-5, claude-sonnet-5-5, daybreak-blue,
deepseek-v4.1-flash, gemini-3.8-flash, glm-5.2, glm-5.3, glm-5.3-flash,
gpt56l, gpt56s, gpt56s-pro, gpt56t, astra,
gpt-6-astra-high, gpt-6-astra-low, gpt-6-astra-max,
gpt-6-astra-medium, gpt-6-astra-xhigh, gpt6l, gpt6s, gpt61s,
grok45, grok46, grok46-high, grok46-medium, grok47,
kimi-k3, minimax-m3, muse-spark, qwen3.8-max
```

Devon's User Plugins add subscription modes outside this catalog. On 2026-10-24
`amp plugins list` on factory-gpu (after an `amp-runner` restart onto the current
build; the stale pre-update process failed to spawn them) reported agent modes
`grok-low`, `grok-medium`, `grok-high`, `grok-ultra` (grok-modes; tools
`grok_advisor_high`, `grok_advisor_xhigh`), `go-low`, `go-medium`, `go-high`,
`go-ultra` (go-modes; tools `go_advisor_high`, `go_advisor_max`) and `docs`
(docs-mode). That listing is the dispatcher's availability check; the keys can
differ by user and runtime, so they are not hard-wired as available.

`amp config external-agents list` separately reports the active mode
`external-agent:claude-code`. Amp's own Claude model modes are **not** Claude
subscription mode.

### Claude

Select `--mode external-agent:claude-code`. Model and effort can be supplied
as features, e.g. `--features model:claude-opus-5-5,effort:high`
(from docs, not run). A runner uses its local `claude` install and local Claude
login, as the runner's OS user. Official minimum: Claude Code **2.1.276**.
Amp searches its startup PATH, `~/.local/bin`, and `~/bin`. It does not install
Claude on runners. Orbs have Claude installed and use the linked subscription.
Amp strips Anthropic API/auth and Bedrock/Vertex/Foundry settings for this mode.
Run as a regular user, not root. No login or installation was performed here.

Initial `command -v claude codex` found neither executable; fallback Claude
paths were also absent. The Claude dispatch returned a URL and exit 0, then
the runner reported `CLAUDE_CODE_NOT_FOUND`, with no inference response.
The user installed Claude during the investigation. A later recheck found
`/home/agent/.local/bin/claude`, version **2.1.296**, signed in through `claude.ai`
with a **Max** subscription. Probe H on a fresh temporary runner then executed
`Bash pwd`, returned `CLAUDE_OK /tmp/met116-probe`, and exited 0 with streaming
JSON. Codex remained absent. No existing runner was restarted. Docs promise
fallback-path discovery on Retry without a restart; that existing-runner Retry
path was not tested here.
Factory-gpu's installation was reported by the user but not independently probed.

### ChatGPT

There is **no `--mode chatgpt`** in this installation. Two validation attempts
failed before inference; debug output identifies an invalid `agentMode` (HTTP
400). Use an Amp mode whose OpenAI model is served by the linked ChatGPT
subscription. No local `codex` binary or Codex CLI login/minimum version is
required for that path. This corrects MET-80's standalone-Codex assumption.

The account already has active Claude Pro/Max and ChatGPT provider connections.
`gpt56l` executed on the probe runner; its usage reports GPT-5.6 Luna via ChatGPT,
$0 Amp cost. `low` used GPT-5.6 Terra via ChatGPT too. Provider links alone do not
force every role onto subscriptions. The documented **ChatGPT Only** preset
pins OpenAI roles for low/medium/high; no preset or account settings were changed.
`ultra`, Painter, search and other supporting calls can still cost Amp credits.
There is no verified CLI switch here that forbids provider fallback.

| Combination | Amp modes | Claude Code | ChatGPT-backed mode |
| --- | --- | --- | --- |
| Local `-x` | Documented, not live-tested | Documented, not live-tested | Documented, not live-tested |
| Runner `-x` | `low` verified | Async submission verified; initial missing binary failure | `gpt56l` verified |
| Runner `-x --stream-json` | `low` verified | Successful Bash tool/reply verified after install | `gpt56l` verified |
| New orb `-ox` | `high` verified on factory-access (MET-184) | Documented, not run | Documented, not run |
| New orb `-ox --stream-json` | Documented, not run | Not live-tested | Documented, not run |

## 2. Runner dispatch contract

`--executor runner:<id>` requires a connected runner for the signed-in account.
`--runner-dir` selects an absolute served directory; otherwise the runner's
starting directory is used. The probe advertised only `/tmp/met116-probe` as
an additional directory, using `--no-serve-cwd --dir`.

Without streaming, remote execute returns the thread URL on stdout and exits
0 before work finishes. It is a submission acknowledgment, **not task success**.
Claude's later startup error demonstrates this distinction. `--title` sets
the title before execution. `--attach` uploads from the dispatcher's filesystem
and adds an attachment URL to the prompt; it does not copy into the worktree.
Probe A's one-line marker upload was verified in the stored prompt; content
download was deliberately not requested.

With `--stream-json`, the CLI stays attached until the turn ends. Probe B
emitted `system/init`, user/assistant/tool-result messages, and `result/success`,
then exited 0. Notably the init `cwd` was the **dispatcher's** checkout, while
the actual shell tool ran in `/tmp/met116-probe`. Do not use init cwd as execution
location proof. A refused tool in E also ended with `result/success`, exit 0,
and assistant text `DENIED`: inspect tool results, not just process status.

Offline ID `met116-offline` returned no stdout URL and exit 1:
`No connected runner has the ID "met116-offline".`
While A was executing a 45-second sleep, B started and finished on the same
runner. Logs showed two running threads; there was no busy rejection or queue.
MET-80 must enforce its own concurrency cap and isolate worktrees. Saturation
limits beyond two concurrent threads were not tested.

## 3. Orbs and billing

MET-184 live check, 2026-10-15 UTC, factory-gpu as `agent`, Amp
`0.0.1792022479-ge66e24`: plain `-ox` returned exit 0 and exactly one thread URL
on stdout, without `--stream-json`:

```sh
amp -ox "$PROMPT" --mode high --project Metacomet-Technologies/factory-access --orb-size a1.medium --title 'MET-184 probe: plain orb dispatch ID' --visibility private --no-archive-after-execute
```

Stdout was `https://ampcode.com/threads/T-01a13da9-38c5-7162-a614-3685d0a0462e`.
The [probe](https://ampcode.com/threads/T-01a13da9-38c5-7162-a614-3685d0a0462e)
confirmed `pwd` was `/home/user/workspace/repo` and origin matched the private
`Metacomet-Technologies/factory-access` repository. It made no repository or
issue changes, was labeled `factory`, and was archived after finishing.
The dispatcher uses the existing unique-thread-ID parser; streaming is unnecessary.
This verifies submission and checkout, not the full issue lifecycle or billing.
MET-183's 2026-10-14 orb separately verified pushing, opening a PR with `gh`, and
commenting through Linear MCP. Post-deployment dispatch through PR, Devon's merge,
green apply, Done and archive remains to be observed on the next eligible issue.

`-ox` means `--orb-execute -x`. `--project` accepts an Amp namespace/name,
GitHub owner/repo, or repository URL. Without it, Git remotes determine the
project; no match produces a warning and a no-project orb. The dispatcher always
passes the allowlisted `ampProject` from `scripts/dispatch/repos.json` for orbs.
Factory still refuses orbs; factory-access defaults to an orb with one active
slot per repo (`maxActiveOrbs`). Only an explicit `runner/gpu` uses the configured
fallback checkout. Failed submissions retain their claim, remove `dispatch`,
and mention Devon on the issue because no dispatcher Slack alert path exists.
Unknown outcomes require inspection before manual recovery, never automatic retry.

`--orb-size` overrides the project default for a new thread, not an existing
orb. All listed sizes have 60 GB disk:

| Size | CPU / RAM | Standard hourly price |
| --- | --- | --- |
| `a1.tiny` | 1 / 2 GB | $0.08 |
| `a1.small` | 2 / 4 GB | $0.17 |
| `a1.medium` | 4 / 8 GB | $0.33 |
| `a1.large` | 8 / 16 GB | $0.66 |
| `a1.xxlarge` | 16 / 32 GB | $1.32 |
| `a1.3xlarge` | 16 / 44 GB | $2.13 |

Billing is per minute while awake, separate from model inference; subscriptions
do not pay for orb compute. Paused orbs cost nothing. Archive pauses immediately.
Otherwise both idle thresholds must hold: no agent work for five minutes and
no interaction for twenty minutes. Portals and opening threads can wake them.
`a1.3xlarge` requires Gigawatt or Enterprise; enterprise prices may differ.
Spawn pacing permits a burst of twenty metered orbs per user, then one every
five minutes; later starts wait. Tiny suits investigation, not a full factory
Rust build. The factory-access dispatcher uses medium; factory has no orb overflow.

Async `-ox` leaves a new thread unarchived. `-ox --stream-json` waits and archives
after the turn unless `--no-archive-after-execute` is supplied. Keep long-lived
dispatcher threads unarchived for follow-ups, and account for idle compute costs.

## 4. Follow-ups

Plain `amp threads continue <id> -x` does **not** send remotely to an attached
runner. Probe C failed with exit 1, naming the existing runner PID and cwd:
`This thread is already open and active in another Amp`.
An archived thread also rejects continuation with exit 1.

Use `amp threads continue <id> -ox` for a remote follow-up. Despite the name,
it sends to that thread's **existing remote executor**, including a runner.
Probe D used `-ox --stream-json --no-archive-after-execute` and the same runner
ran `pwd`; no orb was spawned. Without streaming it is an async acknowledgment
(documented, not separately run). Do not try to relocate a thread with follow-up
`--executor`, `--runner-dir`, `--project`, or `--orb-size`; runner-dir and orb
options are ignored on continuation, and mode is fixed.

## 5. Thread records, archiving and visibility

`amp threads list --json` returns an array of objects with observed fields:

```json
{
  "id": "T-01a12dac-7915-709f-aba9-041c8d3d1c80",
  "title": "MET-116 probe A",
  "updated": "2026-10-12T01:14:01.683Z",
  "tree": "file:///tmp/met116-probe",
  "messageCount": 0
}
```

`tree` was initially null, then became a file URI. `messageCount` stayed zero
even when the transcript had messages; `updated` did not track the final reply
in the captured list. This listing is not a reliable completion/status feed.
It has no observed executor, mode, visibility, archive or error field.
`--include-archived`, `--limit`, `--offset`, and `--installation-id` are available.
Use thread status/transcript for outcomes; raw thread export returned 403 here.

Async runner A stayed unarchived after finishing. Streamed new runner B archived
automatically; E with `--no-archive-after-execute` stayed unarchived. Do not
confuse `amp.thread.autoArchiveOnQuit` (interactive CLI, default false) with
execute-mode archive behavior.

All probes were private without setting visibility. Official default: private
outside a workspace, private for personal/no-project threads, workspace-visible
for workspace-owned projects, subject to admin and per-repository defaults.
CLI offers private/unlisted/workspace/group. Dispatcher should pass
`--visibility private` explicitly; private still permits workspace admin access.
Never use `--share` or unlisted for this dispatcher by default.

## 6. Unattended permissions and safest configuration

Current [Tools][tools] docs say tools need no approval by default and recommend
policy plugins. Current settings schema omits `amp.permissions` and
`amp.dangerouslyAllowAll`, but this installed CLI still documents them and loads
an internal permissions plugin. **Live results take precedence over assuming
the old rules disappeared**:

* Default runner: shell tools execute without approval (A/B/G).
* Custom temporary runner settings, `shell_command: reject`: tool returns
  `Tool rejected by plugin: Rejected by user permissions rule 0: reject shell_command`.
* `shell_command: ask`: thread stops at `Approval Required`, with
  `requiresHuman: true`; streamed dispatch remains blocked. It neither denies
  nor auto-approves. On replacement of that executor during cleanup, the tool
  failed with `Executor was replaced before the tool could resume`.
* `amp permissions test` reports allow/reject/ask without executing a tool.

Rules belong on the **runner**, not merely in the dispatch CLI settings.
`--settings-file` selects a separate local file; workspace settings override
user settings. No shared settings were edited. Root help does not advertise
`--dangerously-allow-all`; a help-only invocation accepted it but that does not
prove its runtime effect. Do not depend on it or enable `amp.dangerouslyAllowAll`.

Recommended baseline: no sudo, no production file access, dedicated per-task
worktree, minimal GitHub permissions, and allow only explicit required commands
with a final reject rule. Reject unsupported operations instead of asking in an
unattended thread. Keep merge/deploy disallowed. The following settings were
tested with `amp permissions test` using `/tmp/met116-probe` as the workdir:
all six allow entries matched; push, appended `; id`, another cwd, and another
tool were rejected. Production path substitution is **not run**.

```json
{
  "amp.permissions": [
    {
      "tool": "shell_command",
      "matches": {
        "workdir": "/tmp/met116-probe",
        "command": [
          "cargo fmt --check",
          "cargo clippy --all-targets -- -D warnings",
          "cargo test --workspace",
          "git status --short",
          "git diff --check",
          "gh pr view --json number,title,url"
        ]
      },
      "action": "allow"
    },
    { "tool": "*", "action": "reject" }
  ]
}
```

This is a conservative **command-check baseline**, not a complete coding-agent
policy: reads/edits, credential setup, worktree creation, commits and authorized
PR pushes need separately reviewed rules. Never replace it with `cargo *`,
`git *`, `gh *`, or unrestricted shell access and call that safe. Cargo build
scripts/tests and Git hooks can execute arbitrary code even under exact command
rules; workdir matching is not filesystem confinement. Use OS/container isolation
for untrusted work, and a maintained policy plugin when expanding this legacy
configuration. Claude Code on runners explicitly runs without permission prompts
according to the Dial docs; equivalent policy enforcement there was not verified.

## 7. Runner services

`--no-tui` runs the remote executor without a TUI. `--runner-id` chooses a
case-insensitive hostname-valid stable ID. `--dir` is repeatable and serves
existing non-Git directories too. `--discover-dirs=/home/agent/work` discovers
Git checkouts/worktrees (default depth two, configurable 1–10, cap 200), watches
changes on Linux/macOS, and falls back to minute scans. Discovery skips hidden
directories, node_modules and symlinks. `--no-serve-cwd` changes advertising,
**not access control**: requests to cwd still work. No served directories means
no registration until one is added. `--amp-env` injects scoped server variables.

Logs: runner banner points to `~/.cache/amp/logs/no-tui.log`; default CLI log is
`~/.cache/amp/logs/cli.log`. Probes used separate `--log-file` paths. For systemd,
send stdout/stderr to journald; restrict log access and never dump environments.
Temporary runner processes logged `Received SIGTERM; shutting down` and
exited 0 promptly with no shell command running. Mid-command
SIGTERM, descendant shutdown guarantees and host reboot were not tested.
Restarting the temporary runner resumed its previously served unarchived probe
threads. Changing its ID while retaining the same starting directory also
resumed them; a different ID alone is not a clean slate.

Documented updates: approximately hourly release checks/install, restart once
no thread runs, at most once per twelve hours. After a day with threads attached,
restart when none is mid-turn. Flags/ID/directories survive. Homebrew installs
report but do not self-install updates. `amp.runner.autoUpdate.enabled: false`,
`amp.updates.mode: "disabled"`, or `AMP_SKIP_UPDATE_CHECK=1` disable appropriate
update behavior. No update/restart of existing factory runners was attempted.

### Proposed systemd user unit (text only; not installed or run)

Adapt identity, paths and policy after review. Do not install alongside an
existing runner with the same ID. This unit deliberately does not expose a
desktop, terminal or workspace-shared runner.

```ini
[Unit]
Description=Factory Amp runner
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/agent/work
Environment=PATH=/home/agent/.local/bin:/home/agent/bin:/home/agent/.cargo/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/agent/.local/bin/amp --no-tui --runner-id factory-console --no-serve-cwd --discover-dirs=/home/agent/work --amp-env --settings-file /home/agent/.config/amp/dispatcher-settings.json
Restart=always
RestartSec=10
KillSignal=SIGTERM
KillMode=control-group
TimeoutStopSec=30
NoNewPrivileges=yes
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

A user unit runs as `agent`; it does not need `User=`. A human must enable linger
for `agent` so its user manager survives logout and starts at boot. Linger does
not provide authentication or networking. Provision the reviewed local settings,
Amp login/access token and Claude install/login as that same user beforehand.
The unit is not a sandbox: `NoNewPrivileges` alone does not protect production
owned by that user. A dedicated runner user/container and restricted mounts are
the safer future boundary. Journald user logs and user-manager operation were
not exercised. No systemd unit, linger setting or installed service was changed.

## 8. Credentials and environment

`AMP_API_KEY` was absent throughout live dispatch. The existing Amp login worked
non-interactively; therefore an access token is **not technically required on
this already signed-in machine**. Docs recommend `AMP_API_KEY` for scripts/CI.
When supplied, it takes precedence over saved accounts and must be an `sgamp_`
access token, not the short-lived login session token. No token was created,
rotated, printed or copied into evidence. Fresh-user bootstrapping and long-term
refresh after reboot were not tested. MET-80's vault-managed automation token
remains a reasonable explicit service identity, not a prerequisite demonstrated
by these probes.

Default runner shell environment comes from its startup process, not the
dispatching shell. A initially observed AGENT_GH_TOKEN present and GH_TOKEN
absent. To distinguish injection from inheritance, G's temporary runner started
with both variables removed via `env -u`. With `--amp-env`, its shell still saw
AGENT_GH_TOKEN nonempty, GH_TOKEN empty, and authenticated `gh api` returned
`Metacomet-Technologies/factory` after exporting GH_TOKEN from AGENT_GH_TOKEN.
Only booleans and repository name were emitted. This proves shell injection
and usable GitHub authentication, not pre-thread fetch behavior.

Documented precedence: personal, project, workspace, runner-process environment.
Variables are refreshed when a thread starts; the newest thread in a directory
sets that directory's environment for all threads. MCP servers/plugins for that
directory can restart when variables change. Shared runners exclude personal
variables, but sharing was not used here.

**New Worktree remains unverified.** It fetches upstream before creating the
thread. Documentation promises injected variables for thread shell commands,
MCP servers and plugins, not that pre-thread Git operation. No New Worktree
request or private fetch using injected credentials was attempted.

GitHub auth is preconfigured for agent (gh + git credential helper); don't set GH_TOKEN or run gh auth commands. If `gh auth status` fails, stop and report.

Keep the PLAYBOOK start-fresh sequence: inside the thread, fetch, then create
its worktree using the preconfigured auth.

## ODD builder launch and routing checks (MET-337)

Observed 2026-10-26 in an orb with Amp `0.0.1792987309-gb46681`.

* `amp -l, --label <label>` (repeatable) labels the thread a `-x`/`-ox` command
  creates. ODD passes every role label at creation, so a launcher that dies
  still leaves a derivable owner.
* `--stream-json` lines carry `session_id` (the thread ID; see the result line
  in Raw evidence). ODD reads the first one, records the child, then ends the
  local launcher; the orb child keeps running. Ending the launcher mid-turn
  is exercised by fixtures only; the first normal correction issue is the
  live acceptance.
* `amp config model-providers check-access --provider-model <provider/model>
  --reasoning-effort <e> --thread <owned thread>` runs one small inference and
  prints JSON. `openai/gpt-6-astra` reported `modelRouting.kind
  "model-provider"`, `connectionType "model_provider_chatgpt"`,
  `modelProviderName "ChatGPT"`; `xai/grok-4.7` reported
  `model_provider_xai_grok` named `Cursor`; `anthropic/claude-opus-5-5`
  reported `kind "upstream-model-provider"`, `modelProviderName "Anthropic"`:
  Amp's paid route. Claude Code's subscription is not visible to this probe.
* `amp config model-providers list --json` gives each connection's `id`,
  `type` (`model_provider_claude_sub`, `model_provider_chatgpt`,
  `model_provider_xai_grok`, …), `name` and `active` without secrets.
* `amp threads usage <thread> --details` (no `--json`) prints a Model Routing
  table: `| Model ID | Purpose | Routing | Requests | Cost |`, routing `Via Amp`
  or `Via [<connection name>](https://ampcode.com/settings/model-routing#<id>)`.
  A Claude Code thread on the subscription showed `anthropic/claude-opus-5-5 |
  Agent | Via [Subscription](…)`; an older one showed
  `external-agent:claude-code/<model> | Unspecified (legacy) | Via Amp`.

## Recommended dispatcher invocation

**All commands in this section are from documented flag contracts plus the
verified mode catalog, not run against the real factory runners or an orb.**
Run as the dispatcher service user. `$PROMPT` contains the issue specification;
`$TITLE` contains its MET identifier and title. Runner threads start in `work`
and create their own authenticated worktree per PLAYBOOK. Confirm each runner
advertises the named directory. Enforce per-runner concurrency and budget caps
before starting a new thread. Preserve the returned thread ID durably.

### Engine `amp` (default effort medium)

```sh
# gpu
amp -x "$PROMPT" --mode medium --executor runner:factory-gpu --runner-dir /home/agent/work --title "$TITLE" --visibility private --no-archive-after-execute
# console
amp -x "$PROMPT" --mode medium --executor runner:factory-console --runner-dir /home/agent/work --title "$TITLE" --visibility private --no-archive-after-execute
# orb — disabled until an Amp project exists for this repository
amp -ox "$PROMPT" --mode medium --project Metacomet-Technologies/factory --orb-size a1.medium --title "$TITLE" --visibility private --no-archive-after-execute
```

Map effort low/medium/high directly to those Amp mode keys. This does not promise
a particular provider or billing route.

### Engine `claude` (console install/login probe passes; gpu still needs a probe)

```sh
# gpu
amp -x "$PROMPT" --mode external-agent:claude-code --executor runner:factory-gpu --runner-dir /home/agent/work --title "$TITLE" --visibility private --no-archive-after-execute
# console
amp -x "$PROMPT" --mode external-agent:claude-code --executor runner:factory-console --runner-dir /home/agent/work --title "$TITLE" --visibility private --no-archive-after-execute
# orb — linked Claude subscription exists, but project/execution not tested
amp -ox "$PROMPT" --mode external-agent:claude-code --project Metacomet-Technologies/factory --orb-size a1.medium --title "$TITLE" --visibility private --no-archive-after-execute
```

Do not translate agent-effort into builtin `--mode` for Claude. Model/effort
features are documented separately; default CLI model/effort and low/medium/high
feature mapping were not tested. Leave explicit feature mapping disabled until
verified for the installed Claude version.

### Engine `chatgpt` (proposed medium mapping)

```sh
# gpu
amp -x "$PROMPT" --mode gpt61s --executor runner:factory-gpu --runner-dir /home/agent/work --title "$TITLE" --visibility private --no-archive-after-execute
# console
amp -x "$PROMPT" --mode gpt61s --executor runner:factory-console --runner-dir /home/agent/work --title "$TITLE" --visibility private --no-archive-after-execute
# orb — subscription covers supported inference, not compute
amp -ox "$PROMPT" --mode gpt61s --project Metacomet-Technologies/factory --orb-size a1.medium --title "$TITLE" --visibility private --no-archive-after-execute
```

`gpt61s` is catalogued GPT-6.1 Sol with Amp High behavior, not a builtin medium
prompt. This medium-effort label mapping is a product choice, **not verified
execution or a billing guarantee**. The tested low-cost alternative is `gpt56l`.
Do not invent a `chatgpt` CLI mode or a Codex subprocess. Verify per-mode provider
routing before enabling each effort level; do not silently fallback off-plan.

For monitoring, append `--stream-json` to a new dispatch and retain
`--no-archive-after-execute`. For follow-ups use this template (from docs and
verified D, template not run):

```sh
amp threads continue "$THREAD_ID" -ox "$FOLLOW_UP" --stream-json --no-archive-after-execute
```

## Unverified / risks

* Claude now passes on the temporary console runner. Factory-gpu execution,
  Claude model/effort features, and Claude-specific policy enforcement remain
  unverified. Claude thread usage accounting was unavailable at immediate check.
* MET-184 verified factory-access orb dispatch and private checkout (§3); other
  orb engine combinations, provider billing and the deployed issue lifecycle remain unverified.
* New Worktree's pre-thread fetch credential environment remains unknown.
* Permissions docs/schema and CLI behavior diverge. Pin and re-probe after CLI
  updates; custom policy and OS boundaries need review before unattended coding.
* Idle shutdown was tested, not active command interruption, child cleanup,
  network reconnection, automatic updates, user-systemd or boot/linger.
* List JSON is not authoritative task state. Async exit 0 and streamed success
  do not prove requested task success. Persist IDs and inspect outcomes.
* Full mode/feature combinations, saturation beyond two threads, invalid served
  paths, fallback billing and attachment download were deliberately not tested.
* Probe threads remain as private evidence; no manual thread deletion or account
  changes were made. B, G and H auto-archived. The ask probe was interrupted during
  runner cleanup rather than approved; no approval gate was bypassed.

## Raw evidence

### Commands and trimmed help (actually run)

```sh
amp --version
amp --help
amp threads --help
amp threads new --help
amp threads continue --help
amp threads list --help
amp threads usage --help
amp permissions --help
amp permissions test --help
amp config --help
amp login --help
amp config external-agents list
amp config external-agents show claude-code
amp config model-providers list
amp config model-providers check-access --help
amp tools list
amp permissions list
amp permissions test shell_command --command pwd --json
amp runner list
amp projects status
command -v claude codex
claude --version
claude auth status
```

Only `check-access --help` was run, not its paid inference operation. Trimmed
root help for version `0.0.1791763306-ged595a`:

```text
-m, --mode <value>
    Set the agent mode (low, medium, high, ultra, or a plugin mode by key or label, case-insensitive)
--executor <value>
    Run a new thread locally, in an orb, or on a runner (local, orb, runner:<id>)
--runner-dir <value>
    With --executor runner:<id>, select one absolute directory served by the runner for the new thread.
    Defaults to its starting directory; ignored when continuing a thread.
-x, --execute [message]
    By default, only the last assistant message is printed.
-ox, --orb-execute
    With `threads continue`, sends the message to the existing thread so it runs on that thread’s own remote executor.
--attach <path>
    With remote execute mode (such as -ox), upload a local file and add its URL to the message.
--title <title>
    With --execute, set the title of the new thread before starting the agent.
--stream-json
    When used with --execute, output in Claude Code-compatible stream JSON format instead of plain text.
--no-archive-after-execute
    When used with --execute on a new thread or with the review command, leave the thread unarchived after the command finishes.
```

### Live prompts and result ledger

All probe commands ran from the investigation worktree. Paid/inference-bearing
prompt count: **7** (`low`: 5, `gpt56l`: 1, `external-agent:claude-code`: 1).
The six Amp-mode prompts used linked ChatGPT and reported **$0 Amp inference
cost**, with 12 model requests total; a shell call normally needs a request
before and after the tool. H used the local Claude Max login and returned two
assistant messages with usage in the stream; its Amp usage page was not yet
available. Subscription usage is not free usage. Claude also had one earlier
startup-failed prompt with no inference response.
Five other CLI attempts failed before inference (two invalid `chatgpt` mode
attempts, offline ID, archived continuation, already-attached continuation).
No paid orb prompt or compute was used. Normal work in this investigation thread
is not included in the dispatch-probe count.

| Probe | Thread / command contract | Result |
| --- | --- | --- |
| A | [Runner, low, async][a], cwd + 45-second sleep + token booleans, title and marker attachment | URL/0; cwd correct; AGENT_GH_TOKEN true, GH_TOKEN false |
| B | [Runner, gpt56l, streamed][b], cwd + cargo/git/gh version commands while A runs | success/0; actual cwd `/tmp/met116-probe`; auto-archived |
| Claude | [Runner, external-agent:claude-code][cclaude], reply-only prompt | URL/0 then `CLAUDE_CODE_NOT_FOUND` |
| C | B archived `continue -x`, then A attached `continue -x --stream-json` | Both exit 1 before inference |
| D | A `continue -ox --stream-json --no-archive-after-execute`, run pwd | success/0 on existing runner |
| E | [Runner, low, reject rule][e], run pwd or report denied | tool rejected; text DENIED; success/0 |
| F | [Runner, low, ask rule][f], same pwd prompt | human approval blocks; executor replacement later fails tool; DENIED |
| G | [Runner, low, isolated env][g], booleans then authenticated gh repository read | injection proven; success/0; auto-archived |
| H | [Runner, external-agent:claude-code after install][h], run pwd and reply only | Bash executes without approval; CLAUDE_OK and correct cwd; success/0; auto-archived |

Exact successful dispatch A (actually run):

```sh
amp -x 'Use only shell_command. Run pwd; sleep 45; then report only whether AGENT_GH_TOKEN and GH_TOKEN are set, never their values. Do not read other files or change anything. Reply with cwd and the two booleans. The attached marker needs no download.' --mode low --executor runner:met116-probe --runner-dir /tmp/met116-probe --title 'MET-116 probe A' --attach .amp/in/evidence/attachment.txt
```

Exact runner follow-up D (actually run):

```sh
amp threads continue T-01a12dac-7915-709f-aba9-041c8d3d1c80 -ox 'Run shell_command with pwd in /tmp/met116-probe. Reply only its output. Do not change anything.' --stream-json --no-archive-after-execute
```

Exact successful Claude dispatch H (actually run):

```sh
amp -x 'Run pwd once in the current directory. Reply only CLAUDE_OK and the directory. Do not read or change files, use network tools, or delegate.' --mode external-agent:claude-code --executor runner:met116-probe-claude --runner-dir /tmp/met116-probe --title 'MET-116 Claude installed probe' --stream-json
```

Trimmed streamed result D:

```json
{"type":"result","subtype":"success","duration_ms":6148,"is_error":false,"num_turns":2,"result":"/tmp/met116-probe","session_id":"T-01a12dac-7915-709f-aba9-041c8d3d1c80"}
```

Runner startup commands used `amp --no-tui --runner-id met116-probe
--no-serve-cwd --dir /tmp/met116-probe --amp-env`, with absolute per-probe
`--log-file` paths. E/F additionally supplied the temporary
`--settings-file` for reject/ask. G used `env -u AGENT_GH_TOKEN -u GH_TOKEN`
and `--runner-id met116-probe-env`, without the temporary permission settings.
H used `--runner-id met116-probe-claude` without `--amp-env` or custom settings.
These startup forms were actually run; all paths were disposable.

### Cleanup and scope

Only temporary runner PIDs 9831, 10875, 11143, 12350 and 23957 were sent SIGTERM after
confirming their command lines. They stopped; runner listing afterward showed
only the original factory-console runner. `/tmp/met116-probe` was removed with
`rmdir` and absence checked. No existing runner, production service, systemd
unit, shared setting, visibility default, secret or credential was changed.
No sandbox/deploy artifact was needed; only this document is a tracked change.

Validation: Markdown rendered with five tables and twelve H2 sections; reference
links resolved, JSON code blocks parsed, and shell code blocks passed `bash -n`.
Repository-required `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`
and `cargo test --workspace` passed (one existing ignored test). No sandbox ran.
Temporary local evidence/settings files were removed; the rendered HTML is an
ignored review artifact, not a deployment artifact.

[cli]: https://ampcode.com/docs/cli
[dial]: https://ampcode.com/docs/the-dial
[execute]: https://ampcode.com/docs/cli/execute-mode
[spawn]: https://ampcode.com/docs/cli/spawning-orbs
[stream]: https://ampcode.com/docs/cli/streaming-json
[settings]: https://ampcode.com/docs/cli/settings
[runners]: https://ampcode.com/docs/cli/runners
[tools]: https://ampcode.com/docs/tools#permissions
[orbs]: https://ampcode.com/docs/orbs
[costs]: https://ampcode.com/docs/orbs/sizes-and-costs
[threads]: https://ampcode.com/docs/threads
[a]: https://ampcode.com/threads/T-01a12dac-7915-709f-aba9-041c8d3d1c80
[b]: https://ampcode.com/threads/T-01a12dac-9d56-736b-b4c1-a3e5d1a4da79
[cclaude]: https://ampcode.com/threads/T-01a12dac-de4d-7522-9a65-ab239af01441
[e]: https://ampcode.com/threads/T-01a12dae-9dd2-767a-883f-616305820f54
[f]: https://ampcode.com/threads/T-01a12daf-8b8c-7318-99de-687b3f45cc00
[g]: https://ampcode.com/threads/T-01a12db0-a525-722f-a475-3c49bd81d47d
[h]: https://ampcode.com/threads/T-01a12db5-3119-76d8-95cd-e785fb599bf3
