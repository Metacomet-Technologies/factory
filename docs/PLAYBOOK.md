# Software Factory Playbook

The working agreement and hard-won lessons for building and operating the factory. **Every new Claude conversation and every agent prompt should follow this.** Keep it current: when we learn something the hard way, add it here.

## 1. How Devon works (apply in every conversation)

- **Design before implementation.** Talk through decisions first; don't jump to code or commands for a new feature.
- **Trade-offs with a recommendation and the reason.** Tables are welcome for options.
- **Separate Decided from Open** at the end of design answers.
- **Be concise and stay on task.** Don't expand scope; park new ideas as Linear issues.
- **Agent prompts are pragmatic and tightly scoped** (template in §4).
- **Verify before asserting:** check current docs or versions when unsure; never guess flags or APIs. Commands that parse API JSON use keys read from `factory-api/openapi.json` on main, never remembered ones.

## 2. The system

- **Node maintenance:** unattended-upgrades (security only; its Automatic-Reboot stays off, the MET-75 reboot policy handles reboots), fstrim.timer, smartd and Tailscale auto-update on both nodes; journald capped at 500M (`/etc/systemd/journald.conf.d/50-factory.conf`). Monthly: `apt full-upgrade`, `nvidia-smi` on factory-gpu after kernel updates, review the Devices Maintenance card, `restore-check.sh all`. factory-console holds `linux-t2`; upgrade only with physical access. factory-console hand-managed thermal files (2026-10-18): `/etc/udev/rules.d/90-factory-usb-roothub-pm.rules` (keeps the PCH `0000:00:14.0` and Thunderbolt `0000:7f:00.0` USB root hubs awake), `/etc/tmpfiles.d/90-factory-no-turbo.conf` (intel_pstate `no_turbo=1`) and the `t2fanrd` package from the t2-ubuntu repo.

| Node | Hardware / location | Runs |
|---|---|---|
| factory-gpu | Ryzen 7 3700X, 32 GB, RTX 3060 12 GB, 1.8 TB at `/srv/factory`, Ubuntu 26.04. **Wired (1 Gb/s) to the main eero**, on the **CyberPower CP1000PFCLCDa UPS** (battery outlets; USB to the PC) | Ollama (127.0.0.1:11435), **meter** proxy (:11434), **factory-api** (127.0.0.1:8080, behind Tailscale Serve) with the requests/pricing DBs and kiosk static files, NUT (UPS monitor, localhost), **factory-ups-control** (127.0.0.1:8090, Serve `/control`, dedicated user and audit DB) and monthly self-test timer, Amp runner |
| factory-console | 2019 16" MBP (T2 kernel), 16 GB, Ubuntu 26.04. Wi-Fi via the office eero satellite | Chrome kiosk (`console` user, auto-login) on the factory-gpu dashboard URL, [MET-74](https://linear.app/metacomet/issue/MET-74/backups-for-meter-factory-api-and-pricing-sqlite-dbs) replicas, Amp runner; old factory-api disabled and kept for rollback until [MET-118](https://linear.app/metacomet/issue/MET-118/remove-factory-console-met-114-rollback-files-after-7-daily-gpu) |

- **Tailnet:** Metacomet (`bearded-pompano.ts.net`). Both nodes are `tag:factory`. Dashboard: `https://factory-gpu.bearded-pompano.ts.net` (Tailscale Serve → 127.0.0.1:8080; no alias). ufw allows only `tailscale0`.
- **Access policy:** admins (`group:factory-admins`) reach everything on the factory; factory → factory only on tcp 22/443/3389/11434 (8080 dropped after [MET-114](https://linear.app/metacomet/issue/MET-114/consolidate-services-onto-factory-gpu-factory-console-becomes-display); the API is loopback-only behind Serve); **factory nodes can't reach personal devices**; SSH maps each person to their own account (`DGarbs51@github` → `dgarbs51`, `agent`; `metacometdave@github` → `david`, `agent`); `tag:factory` → `tag:factory` as `factory-backup` (backups) and `agent` (Amp runners). All factory SSH rules are `accept` (no re-auth prompts). The policy has `tests` + `sshTests`.
- **Repo:** `Metacomet-Technologies/factory`: Rust workspace (`shared`, `meter`, `pricing`, `factory-api`) + `kiosk/` + `deploy/` + `evals/` + `docs/`.
- **GitHub controls:** main-based development. Commits go straight to `main`; the `main` ruleset blocks force-push, deletion and merge commits (linear history). CI (`rust`/`kiosk`/`scripts`/`sandbox`) runs on every push to main and every PR. Actions limited to GitHub-owned + verified creators, pinned to full SHAs (Dependabot keeps pins current); default `GITHUB_TOKEN` read-only. No release tags or artifacts: `main` is what runs.
- **Local models:** `factory-assist` (gemma4:12b, 64K; tool calling reliable), `factory-assist-max` (256K), `factory-code` (qwen2.5-coder:14b, 16K; **no native tool calls**). Ollama runs with flash attention + q8 KV cache.
- **opencode:** Devon's Mac and both nodes (`agent` user, `~/.config/opencode/opencode.json`) have a `factory` provider (`@ai-sdk/openai-compatible`) for `factory-assist` through meter `/v1` (gpu `127.0.0.1:11434`, console `factory-gpu:11434`), context limit 65536, permission allow. Use `factory/factory-assist`, not the auto-discovered Ollama entries (no context limit; `factory-code` has no tool calls). Interactive use only, not a dispatch engine. Node configs are hand-managed.
- **Users:** `dgarbs51` (Devon) and `david` (David): admins with passwordless sudo. `agent`: runs Amp runners; its only sudo is `sudo factory-deploy` on factory-gpu (`deploy/sudoers/README.md`). `console`: kiosk only. Service users: `meter`, `factory-api`, `factory-backup`.
- **Backups (MET-74):** nightly verified meter/requests/pricing/UPS-control audit snapshots on factory-gpu (~03:19), replicated to factory-console; the console's ~03:47 timer has zero local DBs and keeps its pre-move archives until [MET-118](https://linear.app/metacomet/issue/MET-118/remove-factory-console-met-114-rollback-files-after-7-daily-gpu). Receiver pruning requires all four current verified copies; 7 daily + 4 weekly; `restore-check.sh all`. See README **MET-114 move** for cutover/rollback order.
- **Secrets:** 1Password. Devon: desktop integration in RDP, standalone CLI sign-in over SSH via `opin`. Automation secrets: a Factory vault + per-node read-only service accounts (MET-105).
- **Tracking:** Linear project **Software Factory** (team Metacomet, `MET-*`). The GitHub integration auto-links PRs.

## 3. Hard rules

- **Agents never run as `dgarbs51`/`david`.** Their one sudo command is `sudo factory-deploy <meter|factory-api|kiosk>...` on factory-gpu. Every other installer, DB migrations and irreversible production actions stay human: agents write the command, Devon runs it.
- **Agents push to `main`** after the local checks in `AGENTS.md`. CI on main is the gate after the fact: a red main is fixed or reverted first.
- **Never touch production while testing.** Use the sandbox (MET-93) or a side port (:11500 / :18080) with temp DBs. Leave deployed PIDs untouched.
- **Installer pattern** (every deploy script): prebuilt binary as an argument (no building as root), root check, read-only preflight, error trap that prints the rollback command, a snapshot before any change, a quiet wait loop then one `curl -fsS`, post-start checks **as the service user**, a matching rollback, idempotent reruns.
  `bash deploy/lint-installers.sh` checks this pattern statically in every `install-*.sh` and `rollback-*.sh` under `deploy/` and `deploy/*/`; CI's `scripts` job runs it and its fixture test, `python3 -B deploy/test-lint-installers.py`. When a check does not fit a component, add a one-line exemption with the reason in the script. Exempt a real gap as `TODO MET-<issue>` until its follow-up fixes it.
- Restart only what changed (e.g. never Ollama when its drop-in is unchanged).
- Legacy `*.v0.db` files stay until the next migration is verified and MET-74 holds 7 daily snapshots of the new schema, then explicit cleanup.
- **Never repurpose distro system accounts** (e.g. Ubuntu's `backup`); create dedicated ones.
- **Security:** everything tailnet-only; LLM tools are **read-only**; logs and tool output are untrusted data; enforce schemas, allowlists and limits **in code**, never only in prompts. Verify any command a local model suggests (gemma4 invents CLI flags).
- **Database rules (MET-92, see [agent DB rules](agents/db.md)):** no N+1 (query-count tests), `EXPLAIN` tests on hot queries, versioned migrations, `STRICT` tables, all times `*_ms` UTC, money as integers (rates in micro-dollars per Mtok; per-request costs and totals in nano-dollars; priced costs frozen, `cost_status` priced/estimated/unpriced), the shared PRAGMA/pool helper, retention per table (raw requests 365 days + rollups), no blocking tokio threads, no lock held across network I/O.
- **API style:** contract-first REST + generated OpenAPI; live data via **SSE named events** with a `{type, ts_ms, data}` envelope; additive changes only within v1; outages return 200 with nulls + warnings. Graceful shutdown within seconds (SSE streams closed).
- **Kiosk:** React 19, strict TS, Vite+ (`vp`), Tailwind v4 CSS-first, shadcn on Base UI, dark purple accent (one hue, AA contrast). **Theme follows the system**; never force a default. Self-updates on build change; the reload guard gives up on stuck requests after ~20 s.
- **Versioning (MET-107):** one repo-wide SemVer (0.x) from the root `VERSION` file; every component reports version + git SHA; the kiosk footer shows them and warns only on an API contract (OpenAPI hash) mismatch (MET-247).

## 4. Agent prompt template

Keep prompts short: the goal, the Linear issue, what's off-limits and how to know it's done. `AGENTS.md` carries the repo rules; don't repeat them.

- **Work:** small commits straight to `main`. For anything longer than one sitting, work in `/home/agent/work/factory-<name>` from `origin/main` and rebase before pushing. Never use the main checkout `/home/agent/work/factory` for edits; `factory-deploy` refuses to run when it is dirty.
- **Spec isolation:** a change to `factory-api/openapi.json` also regenerates `kiosk/src/api/generated.ts`. Kiosk CI rejects generated-type drift.
- **Evidence:** reply with the commit SHA, what you ran and what you saw, deviations and anything unverified. Put the same on the Linear issue in one comment.
- **Deploy:** meter, factory-api and kiosk with `sudo factory-deploy …` once CI on that commit is green. Anything else: give Devon the exact `gpu-ssh`/`console-ssh` command with full `/home/agent/work/factory` paths.
- **Threads:** one thread per task. Title probes `MET-<n> probe: …`, label them `factory` and archive them when done.

## 5. Review

Reviews are on request, not a gate. A reviewer reads the commit range (`git log -p <from>..<to>`), every changed deploy/migration/script in full, runs the relevant checks and reports findings with the smallest fix for each. It never edits code. Irreversible production actions stay human.

## 6. Deploy flow

1. Push to `main`; wait for CI on that SHA: `gh run list --branch main --commit <sha>`.
2. On factory-gpu: `sudo factory-deploy meter factory-api kiosk` (only what changed). It fast-forwards the main checkout, builds as `agent`, installs, probes health three times at the new SHA and rolls back to the installer's snapshot on failure.
3. Other components (from the Mac, Devon): `gpu-ssh "cd /tmp && sudo bash /home/agent/work/factory/deploy/install-<component>.sh …"` with **full paths**.
4. Verify: `factory-status`, the kiosk footer SHAs, then close the Linear issue.

## 7. Operating the factory

### Commands for Devon

Every command Claude or an agent gives Devon is written as run **from his Mac**, with the helper that says where it runs:

| Helper | Runs |
|---|---|
| `gpu-ssh "…"` | factory-gpu, as `dgarbs51` |
| `console-ssh "…"` | factory-console |
| `gpu-agent <tool>` / `console-agent <tool>` | interactive agent CLI (claude, amp, agent, opencode, codex, kimi) as `agent` in `/home/agent/work/factory`; main checkout, so read-only work only (edits there block ff-only updates and wrap-ups) |
| `gpu-desktop` / `console-desktop` | RDP desktop sessions |
| `factory-status` | full health check (Mac only) |
| `opin …` | 1Password CLI on a node |

- **Multi-line remote scripts:** `gpu-ssh 'bash -s' <<'EOF'` … `EOF` (or `console-ssh` for factory-console; a heredoc after a plain `ssh host` runs on the Mac).
- **Flush-left:** every command block given to Devon starts at column 0, never indented under a list item; an indented heredoc terminator never matches its `EOF`.
- **Same command on both nodes:** one labeled loop, not two copies:
  `for h in factory-gpu factory-console; do echo "== $h"; ssh dgarbs51@$h '…'; done`
  (or `ssh dgarbs51@$h 'bash -s' <<'EOF'` … `EOF` inside the loop).
  Use separate commands instead when order matters (for example factory-gpu first), when one node must be checked before the next, or when a command needs an interactive prompt.
- **`ssh -t dgarbs51@<host> '…'`** only for interactive prompts.
- **Full paths with sudo** (`/home/agent/work/factory/...`): admins can't `cd` into `/home/agent`. For agent-owned paths, run as the agent: `sudo -u agent git -C /home/agent/work/factory status -sb` (administrators only; agent threads already run as `agent` and use the plain command).
- **RDP from Mac (2026-10-14):** `sdl-freerdp` 3.32 sends Cmd as Super; Linux xkb swapping does not change it. `_factory_rdp` uses `/kbd:remap:0x15b=0x1d` (left Cmd → left Ctrl); this build accepts one remap per `/kbd` flag, not a comma list. Set inverted scrolling per user/node inside RDP with `gsettings set org.gnome.desktop.peripherals.mouse natural-scroll true`; trackpad scrolling remains fast and jumpy. `/p` exposes passwords in process lists, so use `/from-stdin`.
- Agent-thread commands go in a separate prompt block, never mixed with Mac commands.
- **Every step has its command:** each step given to Devon includes the exact command and where it runs, or says **UI only** and where. Agents push to main and run `sudo factory-deploy`; other deploys, deletes and irreversible production actions need Devon's explicit yes.

### Day-to-day operations

- **`factory-status`** (Mac): switches to the Metacomet tailnet, then checks every node, service, GPU, link speed, disk, endpoints and latencies. For about a minute after a reboot, "fleet all green" can be briefly red while services start.
- **When something looks down:** first run `tailscale switch --list` (the asterisk is the active tailnet; the Mac is signed into several). Then `factory-status`. **Capture evidence before rebooting:** `uptime; free -h; systemctl --failed; journalctl -p warning --since "-30min"`.
- **Phone:** Blink `ssh gpu` / `mosh gpu` (Mosh needs SSH to work first; no daemon to start). Check the Tailscale app is on Metacomet.
- **1Password over SSH:** `opin <op args>` (asks for the password only when the 30-min session has expired). In RDP terminals, `op` uses the desktop app.

### UPS operations

- **Status:** dashboard card or `/ups`; on factory-gpu, `upsc cyberpower@localhost`. While on battery, NUT starts clean shutdown below 30% charge or 300 seconds runtime. UPS outlets return on their own (MET-173, 2026-10-14), but factory-gpu does not auto-boot until MET-179's BIOS fix is verified.
- **Controls:** only a personal device on the tailnet signed in as Devon or David may use `/ups`; tagged nodes are refused. `test.quick`/`test.stop` test or stop battery testing; beeper actions change only the UPS alarm; validated settings change input/shutdown/start behavior; `shutdown.stop` cancels the driver's pending shutdown delay, but not upsd's FSD latch or an OS shutdown already underway. These actions have no network effect. `power.cycle` requests clean OS shutdown, then NUT's late `shutdown.return` path cuts and restores UPS output. Its 5–15 minute planning budget is not measured. The UPS battery outlets carry factory-gpu, the fiber modem, and the main eero, so it drops house internet, Wi-Fi, and tailnet access to both factory nodes. `power.off_stay` is disabled. Raw `load.off` and `load.on` are intentionally never exposed.
- **Self-test:** first Saturday of every month at 11:00 local time, with no missed-run catch-up. Alerts cover on battery, low battery, replace battery, UPS communications lost, and failed self-test.
- **Manual fallback:** from Mac, enter a root TTY with `ssh -t dgarbs51@factory-gpu 'sudo -i'`. Read the root-only (0600) credential with `cat /etc/nut/factory-control.password`, then run `upscmd -u factory-control cyberpower <command>` and paste it only at the password prompt. Allowed commands: `test.battery.start.quick`, `test.battery.stop`, `beeper.enable`, `beeper.disable`, `beeper.mute`, and `shutdown.stop`. Never put the password in argv; raw `load.off` and `load.on` are never exposed.

## 8. Gotchas we've already hit

**Process**
- Interactive `su agent` / `sudo -iu agent` sessions count as agent work and block the reboot policy indefinitely; exit them when done. `opencode serve --service` started by interactive opencode survives logout and is allowlisted. Check with `ps -u agent -ww -o pid=,ppid=,etime=,args=`.
- Tests that pass locally can hang on GitHub runners: every CI job sets `timeout-minutes`, and async tests wrap their waits in an explicit timeout so a hang fails fast with a message.
- Linear links PRs as closes from the branch name (`met-<n>`), and the public API cannot change an existing link's kind. Merges no longer move issues (team setting, 2026-10-17), so a wrong link type is cosmetic; fix it with the Linear MCP `update_diff` only for accuracy.
- `rg` is not installed on factory nodes. Use `grep -R` or `git grep`; the MET-165 wrap-up stopped on `rg: command not found` (2026-10-14).
- Repo Actions options greyed out means the org setting is off; enable it at org → Settings → Actions first (the default token stays read-only).
- When a Linear **Decided** section changes a rule, update `AGENTS.md`/docs in the next commit. Agents follow the repo file, not Linear.
- Resolved (MET-120, 2026-10-13): Amp's **New Worktree** pre-thread `origin` fetch previously failed ("could not read Username") because credentials existed only inside threads; `agent` now has a persistent `gh` login and Git credential helper on both nodes.
- Amp CLI auto-updates can change `amp usage` text; verify parsers against the current CLI version, not a remembered output format.

**Networking / Tailscale**
- Plain `tailscale ping` **ignores the access policy**; test blocks with `tailscale ping --icmp` or a real TCP connection.
- Tailscale SSH default rules use `check` (browser re-auth, ≤ 168 h); automation needs `accept`. A node's port-22 check against itself fails; check `tailscaled` instead.
- **Ubuntu installed with the Ethernet cable unplugged** creates `netplan-<if>` with `ipv4.method link-local` (169.254 only) and leaves the port declared without a renderer, so **systemd-networkd** also manages it (two DHCP leases). Fix: `nmcli connection modify netplan-<if> ipv4.method auto ipv4.route-metric 100 ipv6.route-metric 100`, set `/etc/netplan/00-installer-config.yaml` to `renderer: NetworkManager`, `netplan apply`, and mask `systemd-networkd`. Wired metric 100, Wi-Fi 600 as fallback.

**Shell / SSH**
- `sudo` over `ssh host cmd` needs `ssh -t` (or NOPASSWD). Heredocs after `ssh host` run on the Mac; use `ssh host 'bash -s' <<'EOF'`.
- In a Mac `bash <<'EOF'` script, every non-interactive `ssh` must use `ssh -n`; otherwise it consumes the remaining heredoc and the script silently ends.
- sudo-rs needs `sudo -i` scripts on stdin: from Mac, `gpu-ssh 'sudo -iu agent bash -s' <<'EOF'` (or console-ssh). Do not rely on a quoted `bash -c` surviving the login shell.
- Agent CLIs must resolve from `/home/agent/.local/bin` on both nodes: `sudo -iu agent` starts a non-interactive login shell that doesn't read `.bashrc`, so installers that put binaries elsewhere need a symlink there (opencode: `~/.opencode/bin`, kimi: `~/.kimi-code/bin`). Check with `ssh -tq dgarbs51@<host> "sudo -iu agent command -v <tool>"`.
- Never capture `ssh -t` output into a variable: TTY sessions can emit terminal escapes (seen: `ESC ]3008`) that corrupt the value. Capture without a TTY, or pass literal values.
- Mosh has no scrollback; use `ssh gpu` for long output.
- With `set -o pipefail`, never pipe into `grep -q`: it can close early and cause SIGPIPE upstream. Capture output, then test it.
- Never redact secrets with sed one-liners. Print only whitelisted fields; omit raw secret-bearing output.
- The `gpu-ssh`/`console-ssh` helpers run `_factory_ready` first, which can print or fail. For byte streams (tar transfers) use plain `ssh "$FACTORY_USER@$FACTORY_GPU"` (or `$FACTORY_CONSOLE`).
- zsh doesn't expand `~` in `if=`; `curl -d "$big"` hits the arg limit (use `-d @-`).
- `~/.hushlogin` silences the Ubuntu login banner (per user).

**Ubuntu 26.04**
- Default coreutils is uutils, but `mv` is GNU (`gnumv`, supports `--exchange`). An apt lock right after boot = unattended-upgrades; wait. `debconf: unable to initialize frontend` lines are harmless.
- Removing desktop apps can remove `ubuntu-desktop-minimal`; dry-run `purge --autoremove` and protect dependencies with `apt-mark manual`.
- `hwclock` isn't installed; read clocks from `/sys/class/rtc/rtc*/`.
- Ubuntu Pro's ESM pin (510) keeps an old `gh`; pin package `gh` from `cli.github.com` at 600. Installing/pinning remains an administrator action.

**Hardware**
- **T2 MacBook:** Wi-Fi firmware must be supplied (back up `/lib/firmware/brcm`); boot `Option` → EFI Boot. **Its CMOS RTC resets to 1970 at every boot** (the firmware ACPI clock has no time either), so systemd starts the clock at a stale floor date until chrony syncs. factory-api waits for `chrony-wait` (time-sync.target) and refuses refreshes/writes while unsynchronized.
- **T2 console heat (2026-10-18):** the dual USB-C dock/charger hub (kept: it connects other devices) reports over-current on `usb1-port2` and `usb5-port2` at boot. The root hubs then retry autosuspend ~100k times a second (`hub_event` / `pm_runtime_work` kworkers, CPU 91–94 °C). The udev rule above sets those root hubs' `power/control=on`; check after reboot with `cat /sys/bus/usb/devices/usb{1,5}/power/control`. With the dock unplugged the loop stops. Turbo off took the CPU from 91 to ~60 °C with no visible kiosk impact. The T2 fans are under `/sys/devices/…/APP0001:00/fan*_input`, not `/sys/class/hwmon`; the hwmon `amdgpu fan1` reading 0 rpm is the GPU's, not the Mac's. Diagnose kworker CPU with the workqueue tracepoint and `usbmon` before changing anything. udev match keys: `ENV{DEVTYPE}`, not `DEVTYPE`.
- **T2 console power (2026-10-18):** `ADP1 online=1` doesn't mean the battery is charging. Plugged straight in through an underpowered charger path, the console discharged all day under ~26 W of load, and UPower did a clean critical-battery power off at 22:00 (it looked like a crash). A direct charger path must be a 96 W USB-C PD supply with a cable rated for it; the dock's passthrough charges fine. Check with `upower -i $(upower -e | grep -i bat) | grep -E 'state|percentage|energy-rate'`, which should show `charging`, not `discharging`. A clean `systemd-poweroff` at the end of `journalctl -b -1` with no sudo `poweroff` means a battery or power-key shutdown, not a crash.
- **NUT:** write `/etc/nut/*` **before** installing the package (otherwise its postinst deadlocks starting with no config: `systemctl cancel`, stop `nut-driver-enumerator.path`, then `dpkg --configure -a`). A UPS plugged in before NUT's udev rules exist needs `udevadm control --reload-rules && udevadm trigger --subsystem-match=usb --attr-match=idVendor=0764 --action=add`.
- **UPS outlet return:** verified by MET-173's supervised `power.cycle` (2026-10-14): the outlets, modem and eero came back on their own, but factory-gpu did not auto-boot (MSI B550 BIOS; MET-179).

**Services / apps**
- `node --check` doesn't strip TypeScript types and fails on `.ts` files with `Unexpected token ':'`; verify collector scripts with `node --test`, never `node --check`.
- Exact Node patch pins broke Node services when the Vite+ shim default moved on 2026-10-14. Runtime checks accept Node 24.x at 24.12.0 or newer; `.node-version` remains the preferred version.
- GNOME RDP headless: set credentials with `sudo grdctl --system rdp set-credentials` and register a TLS cert; the Windows App hangs at TLS, use `sdl-freerdp`. Remote Login refuses while the same user is logged in locally.
- After changing the kiosk's autostart `Exec=`, relaunch the console session (reboot) and verify the live process with `pgrep -u console -af -- '--app='`; the dashboard working in another browser doesn't prove the kiosk switched.
- Ollama `/api/ps` misreports gemma4's size; use `nvidia-smi`. Exclude non-inference requests (health checks) from usage.
- A lock held across a network call froze usage/pricing for 60 s+ when TLS failed on a bad clock (MET-90): never hold DB access across I/O.
- Bundled SQLite 3.51.1 (rusqlite 0.38) can deadlock during concurrent WAL connection closes (fixed in SQLite 3.51.2); use rusqlite ≥ 0.39.
- Test migrations against the real service's stopped state (run the old binary, stop it as systemd does), not only cleanly closed fixtures: a process that exits without closing SQLite leaves committed rows in the WAL, and a WAL's file size alone doesn't show whether frames are uncheckpointed.
- iOS Safari doesn't run timers in background tabs; check on `visibilitychange`.
- **1Password CLI:** with app integration, `op whoami` can say "not signed in" while `op vault list` works; `op account add` refuses unless `OP_BIOMETRIC_UNLOCK_ENABLED=false`; app-integrated `op` only works inside the desktop session.
- Omarchy (Hyprland 0.56) moved to Lua config and dispatch.
- `agent`'s `node` is the Vite+ shim, which picks a Node version per directory and fails with "Permission denied" when run from a directory `agent` can't read (such as an admin's home). Run anything that invokes it as `agent` from a readable directory: e.g. `cd /tmp && sudo bash /home/agent/work/factory/deploy/install-usage.sh`.

## 9. Where things are tracked

Linear: project overview, the roadmap issues, and the Linear copy of this playbook (this repo file is the source of truth). Decisions live in each issue's **Decided** section.

Labels: every issue gets one type (Bug / Feature / Improvement) plus one or more `area:*` labels (meter, api, kiosk, data, security, agents, ops). Post a Linear project update after milestone days.
