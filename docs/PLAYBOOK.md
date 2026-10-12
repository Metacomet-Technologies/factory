# Software Factory Playbook

The working agreement and hard-won lessons for building and operating the factory. **Every new Claude conversation and every agent prompt should follow this.** Keep it current: when we learn something the hard way, add it here (via a PR to this file).

## 1. How Devon works (apply in every conversation)

- **Design before implementation.** Talk through decisions first; don't jump to code or commands for a new feature.
- **Trade-offs with a recommendation and the reason.** Tables are welcome for options.
- **Separate Decided from Open** at the end of design answers.
- **Be concise and stay on task.** Don't expand scope; park new ideas as Linear issues.
- **Agent prompts are pragmatic and tightly scoped** (template in §4).
- **Verify before asserting:** check current docs or versions when unsure; never guess flags or APIs.

## 2. The system

| Node | Hardware / location | Runs |
|---|---|---|
| factory-gpu | Ryzen 7 3700X, 32 GB, RTX 3060 12 GB, 1.8 TB at `/srv/factory`, Ubuntu 26.04. **Wired (1 Gb/s) to the main eero**, on the **CyberPower CP1000PFCLCDa UPS** (battery outlets; USB to the PC) | Ollama (127.0.0.1:11435), **meter** proxy (:11434), NUT (UPS monitor, localhost), Amp runner; MET-114 target: **factory-api** (127.0.0.1:8080), requests/pricing DBs, kiosk static files, Serve, all MET-74 origins (deployment pending verification) |
| factory-console | 2019 16" MBP (T2 kernel), 16 GB, Ubuntu 26.04. Wi-Fi via the office eero satellite | MET-114 target: Chrome kiosk (`console` user, auto-login), MET-74 replicas, Amp runner only; retained API files disabled for rollback |

- **Tailnet:** Metacomet (`bearded-pompano.ts.net`). Both nodes are `tag:factory`. MET-114 dashboard target: `https://factory-gpu.bearded-pompano.ts.net` (Tailscale Serve → 127.0.0.1:8080; no alias). Until administrator cutover, the console URL remains deployed. ufw allows only `tailscale0`.
- **Access policy:** admins (`group:factory-admins`) reach everything on the factory; factory → factory only on tcp 22/443/3389/8080/11434; **factory nodes can't reach personal devices**; SSH maps each person to their own account (`DGarbs51@github` → `dgarbs51`, `agent`; `metacometdave@github` → `david`, `agent`); `tag:factory` → `tag:factory` as `factory-backup` for backups. All factory SSH rules are `accept` (no re-auth prompts). The policy has `tests` + `sshTests`.
- **Repo:** `Metacomet-Technologies/factory`: Rust workspace (`shared`, `meter`, `pricing`, `factory-api`) + `kiosk/` + `deploy/` + `evals/` + `docs/`.
- **GitHub controls (MET-109):** `main` ruleset — PRs only, required checks `rust`/`kiosk`/`scripts`, no force-push or deletion, linear history; squash-only merges using the PR title; Actions limited to GitHub-owned + verified creators, pinned to full SHAs (Dependabot keeps pins current); default `GITHUB_TOKEN` read-only. Releases are manual: `scripts/bump-version.sh`, merge, then `gh release create vX.Y.Z --repo Metacomet-Technologies/factory --target main --generate-notes`.
- **Local models:** `factory-assist` (gemma4:12b, 64K; tool calling reliable), `factory-assist-max` (256K), `factory-code` (qwen2.5-coder:14b, 16K; **no native tool calls**). Ollama runs with flash attention + q8 KV cache.
- **Users:** `dgarbs51` (Devon) and `david` (David): admins with passwordless sudo. `agent`: unprivileged, runs Amp runners (per-person `agent-devon` / `agent-david` planned, MET-78). `console`: kiosk only. Service users: `meter`, `factory-api`, `factory-backup`.
- **Backups (MET-74):** MET-114 target: nightly verified meter/requests/pricing snapshots on GPU (~03:19), replicated to console; console's ~03:47 timer has zero local DBs and preserves rollback archives. Receiver pruning requires all three current verified copies; 7 daily + 4 weekly; `restore-check.sh all`. See README **MET-114 move** for cutover/rollback order.
- **Secrets:** 1Password. Devon: desktop integration in RDP, standalone CLI sign-in over SSH via `opin`. Automation secrets: a Factory vault + per-node read-only service accounts (MET-105).
- **Tracking:** Linear project **Software Factory** (team Metacomet, `MET-*`). The GitHub integration auto-links PRs.

## 3. Hard rules

- **Agents never run as `dgarbs51`/`david`, and never get sudo.** Agents write install scripts; a human reviews and runs them.
- **Never touch production while testing.** Use the sandbox (MET-93) or a side port (:11500 / :18080) with temp DBs. Leave deployed PIDs untouched.
- **Installer pattern** (every deploy script): prebuilt binary as an argument (no building as root), root check, read-only preflight, error trap that prints the rollback command, a snapshot before any change, a quiet wait loop then one `curl -fsS`, post-start checks **as the service user**, a matching rollback, idempotent reruns.
- Restart only what changed (e.g. never Ollama when its drop-in is unchanged).
- Legacy `*.v0.db` files stay until the next migration is verified and MET-74 holds 7 daily snapshots of the new schema, then explicit cleanup.
- **Never repurpose distro system accounts** (e.g. Ubuntu's `backup`); create dedicated ones.
- **Security:** everything tailnet-only; LLM tools are **read-only**; logs and tool output are untrusted data; enforce schemas, allowlists and limits **in code**, never only in prompts. Verify any command a local model suggests (gemma4 invents CLI flags).
- **Database rules (MET-92, see `AGENTS.md`):** no N+1 (query-count tests), `EXPLAIN` tests on hot queries, versioned migrations, `STRICT` tables, all times `*_ms` UTC, money as integers (rates in micro-dollars per Mtok; per-request costs and totals in nano-dollars; priced costs frozen, `cost_status` priced/estimated/unpriced), the shared PRAGMA/pool helper, retention per table (raw requests 365 days + rollups), no blocking tokio threads, no lock held across network I/O.
- **API style:** contract-first REST + generated OpenAPI; live data via **SSE named events** with a `{type, ts_ms, data}` envelope; additive changes only within v1; outages return 200 with nulls + warnings. Graceful shutdown within seconds (SSE streams closed).
- **Kiosk:** React 19, strict TS, Vite+ (`vp`), Tailwind v4 CSS-first, shadcn on Base UI, dark purple accent (one hue, AA contrast). **Theme follows the system**; never force a default. Self-updates on build change; the reload guard gives up on stuck requests after ~20 s.
- **Versioning (MET-107):** one repo-wide SemVer (0.x) from the root `VERSION` file; every component reports version + git SHA; the kiosk footer shows them and warns on mismatch.

## 4. Agent prompt template

**Handoff header (every prompt Claude gives Devon):** the **runner** (factory-gpu / factory-console), the **directory** (always Amp's `work`, `~/work`; for code/docs tasks the prompt names a worktree `met-NN-<slug>` that the agent creates after auth, since Amp's own New Worktree fetches without credentials and fails), and the **effort level** (Low only for mechanical tasks like pull/build; Medium by default; High for risky concurrency/security work).

**First line of every prompt:** `**Thread title:** Use the Linear ticket identifier and title: \`MET-123 — Ticket title\`.` (the exact Linear title).

Every prompt has these sections:

1. **Start fresh:** `export GH_TOKEN="$AGENT_GH_TOKEN" && gh auth setup-git`, `git -C ~/work/factory fetch origin`, then `git -C ~/work/factory worktree add -b <name> ~/work/factory-<name> origin/main` and work only in that directory (never the main checkout); first push `git push -u origin <name>`. Read `AGENTS.md`/READMEs first. Reference the MET id in the PR title and body, with the right link type (**closes** only if the PR finishes the issue).
2. **Context:** what's deployed, what other agents are doing, what's off-limits.
3. **Isolation:** the exact directories it may edit.
4. **Build:** spec and requirements; contracts written out exactly.
5. **Tests:** what must pass (`cargo fmt --check`, `clippy -D warnings`, `cargo test --workspace`; `vp check`/`vp test`/`vp build`).
6. **Sandbox check:** `scripts/sandbox up` (synthetic data, fake Ollama), run the checks, include evidence (URLs, counts, timings) in the final message, then `scripts/sandbox down`. Production read-only checks only when the prompt explicitly asks.
7. **Deploy artifacts:** write, don't run.
8. **Done means:** push, open the PR, final message with results, deviations, anything unverified, and exact deploy steps.

**Runner hygiene:** one thread per task; archive threads once their work is merged **and deployed/verified**; start fresh threads per phase. Parallel threads on one runner use **Amp worktrees**; remove the worktree when its thread is archived. Don't message a thread mid-run unless it's a correction. Mechanical follow-ups (pull + build) also start with the `GH_TOKEN` setup line. Cleanup after merge: archive the thread (UI only), then as `agent`: `git -C /home/agent/work/factory worktree remove /home/agent/work/factory-<name>` and `git -C /home/agent/work/factory branch -D <name>`.

**Wrap-up prompt (after merge):** the same thread confirms the merge, updates and builds in the main checkout (`~/work/factory`), removes its worktree and local branch, and replies with exact Mac install/verify commands. One deploy per runner at a time. Devon archives the thread (UI only) only after deploy verification; if verification fails, the same thread fixes it from a fresh worktree.

**Linear dispatch (MET-80):** fill the Agent task template, give it exactly one Bug/Feature/Improvement label and at least one `area:*`, then add `dispatch`. The GPU's 60-second poll skips unresolved blockers (one waiting comment), validates required sections after stripping `>` hints, and caps active work at two per runner. Defaults are runner/gpu, engine/amp, agent-effort/medium; orb is refused. It removes the label, records a durable claim, starts a private Amp thread with this prompt contract, comments its URL and moves the issue to In Progress. A merged GitHub PR attachment triggers the same-thread wrap-up once; merge detection's metadata convention still needs live verification. Claims prevent duplicate dispatch/continuation after crashes, including manual retries; interrupted claims require inspection, never blind re-labeling. Human merge/deploy gates remain. See [dispatcher operations and limitations](../scripts/dispatch/README.md).

## 5. Review checklist (before merge)

- **Reviews are done by Claude directly:** Linear `get_diff` for metadata and link types, then Claude in Chrome for the actual diff and full scripts. Only fall back to asking Devon for `gh` output when neither tool is reachable.
- Files changed match the isolation rule (the diff's file list).
- Tests pass, the live check has real evidence (timings, row counts), the deviations list has been read.
- Read install/rollback scripts in full.
- **PR ↔ Linear link type:** a "closes" link auto-closes the issue on merge. Use **contributes** for research, partial work, or fixes whose install hasn't been verified; reopen issues that auto-closed early.
- Claude fixes wrong or missing link types itself with Linear `update_diff`.
- After rebases, confirm the push actually landed.

## 6. Deploy flow

1. Merge (squash, delete branch).
2. Send the thread the wrap-up prompt (§4); it builds in the main checkout and cleans up its worktree.
3. From the Mac: `factory-ssh "sudo bash /home/agent/work/factory/deploy/install-*.sh <prebuilt path>"` (use **full paths**: admins can't `cd` into `/home/agent`).
4. Verify: `factory-status` (all green; usage/pricing < 2 s), kiosk self-reload, then mark the Linear issue Done. Then update Linear (status, Decided, Next) and, if `docs/PLAYBOOK.md` changed, re-sync the Linear playbook copy.

## 7. Operating the factory

### Commands for Devon

Every command Claude or an agent gives Devon is written as run **from his Mac**, with the helper that says where it runs:

| Helper | Runs |
|---|---|
| `factory-ssh "…"` | factory-gpu, as `dgarbs51` |
| `console-ssh "…"` | factory-console |
| `factory-desktop` / `console-desktop` | RDP desktop sessions |
| `factory-status` | full health check (Mac only) |
| `opin …` | 1Password CLI on a node |

- **Multi-line remote scripts:** `factory-ssh 'bash -s' <<'EOF'` … `EOF` (or `console-ssh` for factory-console; a heredoc after a plain `ssh host` runs on the Mac).
- **Same command on both nodes:** one labeled loop, not two copies:
  `for h in factory-gpu factory-console; do echo "== $h"; ssh dgarbs51@$h '…'; done`
  (or `ssh dgarbs51@$h 'bash -s' <<'EOF'` … `EOF` inside the loop).
  Use separate commands instead when order matters (for example factory-gpu first), when one node must be checked before the next, or when a command needs an interactive prompt.
- **`ssh -t dgarbs51@<host> '…'`** only for interactive prompts.
- **Full paths with sudo** (`/home/agent/work/factory/...`): admins can't `cd` into `/home/agent`. For agent-owned paths, run as the agent: `sudo -u agent git -C /home/agent/work/factory status -sb`.
- Agent-thread commands go in a separate prompt block with the handoff header, never mixed with Mac commands.
- **Every step has its command:** each step given to Devon includes the exact command and where it runs, or says **UI only** and where (for example, archiving an Amp thread). Steps Claude can do with its own tools (reviews, Linear updates) Claude does or offers; irreversible actions (merges, deletes) need Devon's explicit yes first. Claude can merge through Linear's `merge_diff` (squash) only after Devon's explicit yes.

### Day-to-day operations

- **`factory-status`** (Mac): switches to the Metacomet tailnet, then checks every node, service, GPU, link speed, disk, endpoints and latencies. For about a minute after a reboot, "fleet all green" can be briefly red while services start.
- **When something looks down:** first run `tailscale switch --list` (the asterisk is the active tailnet; the Mac is signed into several). Then `factory-status`. **Capture evidence before rebooting:** `uptime; free -h; systemctl --failed; journalctl -p warning --since "-30min"`.
- **Phone:** Blink `ssh gpu` / `mosh gpu` (Mosh needs SSH to work first; no daemon to start). Check the Tailscale app is on Metacomet.
- **1Password over SSH:** `opin <op args>` (asks for the password only when the 30-min session has expired). In RDP terminals, `op` uses the desktop app.
- **UPS:** `upsc cyberpower@localhost` on factory-gpu. Clean shutdown at < 30% charge or < 5 min runtime; it boots itself when power returns.

### Dispatcher commands (from Mac)

After [key setup and installer preflight](../scripts/dispatch/README.md#administrator-deployment-from-mac-after-merge), preview one issue or a complete pass. Remove `--dry-run` only to authorize real submissions and Linear mutations; manual `issue` ignores the label, not validation, blockers, capacity or claims.

```sh
factory-ssh 'sudo -iu agent node /home/agent/work/factory/scripts/dispatch/dispatch.ts issue MET-123 --dry-run'
factory-ssh 'sudo -iu agent node /home/agent/work/factory/scripts/dispatch/dispatch.ts poll --dry-run'
factory-ssh 'systemctl list-timers factory-dispatch.timer'
factory-ssh 'sudo journalctl -u factory-dispatch -f'
# Pause automatic dispatch before investigating an interrupted claim:
factory-ssh 'sudo systemctl stop factory-dispatch.timer'
# Remove dispatcher units; keep the key and existing threads:
factory-ssh 'sudo bash /home/agent/work/factory/deploy/rollback-dispatch.sh'
```

## 8. Gotchas we've already hit

**Process**
- Tests that pass locally can hang on GitHub runners: every CI job sets `timeout-minutes`, and async tests wrap their waits in an explicit timeout so a hang fails fast with a message.
- Repo Actions options greyed out means the org setting is off; enable it at org → Settings → Actions first (the default token stays read-only).
- When a Linear **Decided** section changes a rule, update `AGENTS.md`/docs in the next PR. Agents follow the repo file, not Linear.
- Amp's **New Worktree** fetches `origin` before creating the worktree; `agent` has GitHub credentials only inside threads, so it fails ("could not read Username"). Start threads in `work` and let the agent create the worktree after auth.

**Networking / Tailscale**
- Plain `tailscale ping` **ignores the access policy**; test blocks with `tailscale ping --icmp` or a real TCP connection.
- Tailscale SSH default rules use `check` (browser re-auth, ≤ 168 h); automation needs `accept`. A node's port-22 check against itself fails; check `tailscaled` instead.
- **Ubuntu installed with the Ethernet cable unplugged** creates `netplan-<if>` with `ipv4.method link-local` (169.254 only) and leaves the port declared without a renderer, so **systemd-networkd** also manages it (two DHCP leases). Fix: `nmcli connection modify netplan-<if> ipv4.method auto ipv4.route-metric 100 ipv6.route-metric 100`, set `/etc/netplan/00-installer-config.yaml` to `renderer: NetworkManager`, `netplan apply`, and mask `systemd-networkd`. Wired metric 100, Wi-Fi 600 as fallback.

**Shell / SSH**
- `sudo` over `ssh host cmd` needs `ssh -t` (or NOPASSWD). Heredocs after `ssh host` run on the Mac; use `ssh host 'bash -s' <<'EOF'`.
- The `factory-ssh`/`console-ssh` helpers run `_factory_ready` first, which can print or fail. For byte streams (tar transfers) use plain `ssh "$FACTORY_USER@$FACTORY_GPU"` (or `$FACTORY_CONSOLE`).
- zsh doesn't expand `~` in `if=`; `curl -d "$big"` hits the arg limit (use `-d @-`).
- `~/.hushlogin` silences the Ubuntu login banner (per user).

**Ubuntu 26.04**
- Default coreutils is uutils, but `mv` is GNU (`gnumv`, supports `--exchange`). An apt lock right after boot = unattended-upgrades; wait. `debconf: unable to initialize frontend` lines are harmless.
- Removing desktop apps can remove `ubuntu-desktop-minimal`; dry-run `purge --autoremove` and protect dependencies with `apt-mark manual`.
- `hwclock` isn't installed; read clocks from `/sys/class/rtc/rtc*/`.

**Hardware**
- **T2 MacBook:** Wi-Fi firmware must be supplied (back up `/lib/firmware/brcm`); boot `Option` → EFI Boot. **Its CMOS RTC resets to 1970 at every boot** (the firmware ACPI clock has no time either), so systemd starts the clock at a stale floor date until chrony syncs. factory-api waits for `chrony-wait` (time-sync.target) and refuses refreshes/writes while unsynchronized.
- **NUT:** write `/etc/nut/*` **before** installing the package (otherwise its postinst deadlocks starting with no config: `systemctl cancel`, stop `nut-driver-enumerator.path`, then `dpkg --configure -a`). A UPS plugged in before NUT's udev rules exist needs `udevadm control --reload-rules && udevadm trigger --subsystem-match=usb --attr-match=idVendor=0764 --action=add`.

**Services / apps**
- GNOME RDP headless: set credentials with `sudo grdctl --system rdp set-credentials` and register a TLS cert; the Windows App hangs at TLS, use `sdl-freerdp`. Remote Login refuses while the same user is logged in locally.
- After changing the kiosk's autostart `Exec=`, relaunch the console session (reboot) and verify the live process with `pgrep -u console -af -- '--app='`; the dashboard working in another browser doesn't prove the kiosk switched.
- Ollama `/api/ps` misreports gemma4's size; use `nvidia-smi`. Exclude non-inference requests (health checks) from usage.
- A lock held across a network call froze usage/pricing for 60 s+ when TLS failed on a bad clock (MET-90): never hold DB access across I/O.
- Bundled SQLite 3.51.1 (rusqlite 0.38) can deadlock during concurrent WAL connection closes (fixed in SQLite 3.51.2); use rusqlite ≥ 0.39.
- Test migrations against the real service's stopped state (run the old binary, stop it as systemd does), not only cleanly closed fixtures: a process that exits without closing SQLite leaves committed rows in the WAL, and a WAL's file size alone doesn't show whether frames are uncheckpointed.
- iOS Safari doesn't run timers in background tabs; check on `visibilitychange`.
- **1Password CLI:** with app integration, `op whoami` can say "not signed in" while `op vault list` works; `op account add` refuses unless `OP_BIOMETRIC_UNLOCK_ENABLED=false`; app-integrated `op` only works inside the desktop session.
- Omarchy (Hyprland 0.56) moved to Lua config and dispatch.

## 9. Where things are tracked

Linear: project overview, the roadmap issues, and the Linear copy of this playbook (this repo file is the source of truth). Decisions live in each issue's **Decided** section.

Labels: every issue gets one type (Bug / Feature / Improvement) plus one or more `area:*` labels (meter, api, kiosk, data, security, agents, ops). Post a Linear project update after milestone days.
