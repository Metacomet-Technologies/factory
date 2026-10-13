# Factory reboot policy (MET-75 phase 1)

This policy only reboots when `/var/run/reboot-required` exists. It does not
install updates, change NUT, or enable unattended-upgrades' automatic reboot.
Keep `Unattended-Upgrade::Automatic-Reboot` disabled: it bypasses these checks.

## Schedule and rollout

- factory-gpu: **06:00 America/New_York**, after its 03:15 backup.
- factory-console: **06:30 America/New_York**, after its 03:45 backup.
- `Persistent=false`: a missed window is not replayed at boot. No random delay.
- Default **observe** mode records decisions but never reboots. Devon explicitly
  switches each node to **enforce** after reviewing observations and the allowlist.
- Staggering avoids simultaneous scheduled reboots; it is not a peer-health
  interlock. A boot lasting over 30 minutes can overlap the other node's window.

On factory-gpu, Ubuntu 26.04 reports `systemd 259 (259.5-0ubuntu3.4)`.
`systemd-analyze calendar '*-*-* 06:00 America/New_York'` normalizes to
`06:00:00 America/New_York` and reports 10:00 UTC during EDT; a December
base-time check reports 11:00 UTC during EST. Named timezones
handle DST without a fixed-UTC caveat. The installer validates the calendar on
each node and refuses an unsupported systemd; no UTC fallback is needed on the
verified version. Devon's idle console capture also reports
`systemd 259 (259.5-0ubuntu3.4)`: timezone calendars are supported on that version.

## Decision order

Every check runs the busy checks below and stores the first blocking reason in
`last_busy_reason` (null when idle), so observe mode shows what enforce would
see even when no reboot is pending. Only the marker drives decisions:

1. Without the marker, record `not-needed` and clear pending/skip counters.
2. With the marker, retain the first `pending_since_ms` and compute elapsed
   whole 24-hour `days_pending` (timestamps are UTC milliseconds).
3. Check agent processes, then agent worktrees, then GPU-only meter traffic,
   then GPU-only UPS status.
   The first blocking reason wins. A failed or malformed probe blocks reboot.
4. Record `skipped`. Count at most once per New York calendar date. Three
   consecutive skipped dates set `alert_due=true`; keep skipping, never force.
   A gap in checked dates or a clear decision resets the consecutive count.
   MET-76 will consume this flag; this phase sends no alerts.
5. If clear, record `would-reboot` in observe mode. Enforce records `rebooting`,
   publishes and syncs state, then calls `systemctl reboot` without force flags.

### Agent process allowlist

The root check runs `ps -u agent -ww -o pid=,ppid=,args=`. Each row is a numeric
PID, parent PID, and the remaining full command line. **Every** agent-owned
process blocks unless its full command matches an explicit Python regular
expression in `/etc/factory-reboot/node.conf` (`agent_allowlist`). `parent_args`,
when present, must also match the direct parent's command. Never allow all
`amp`, `bash`, `node`, `python`, `cargo`, `ssh`, or all descendants of the runner.
The verified procps empty-selection result is exit 1 with empty stdout/stderr;
that is idle. Errors with diagnostics, other exit codes, and malformed rows skip.

Read-only inspection on factory-gpu on 2026-10-11 found:

- PID 2481, parent 1: `/home/agent/.local/bin/amp --no-tui --runner-id
  factory-gpu --dir /home/agent/work --discover-dirs=/home/agent/work
  --remote-control-terminal --amp-env --runner-account-email devon@metacomet.tech`.
  Its exact long-lived runner command is allowed, not arbitrary Amp invocations.
- PID 34170, parent 2481: Amp's `official-modes` plugin runtime. Its command
  contains `/tmp/amp-plugin-runtime-q517Yo/plugin-runtime.ts` and
  `official-modes@46ba5e96083e1347/index.ts`. Only the runtime directory suffix
  and plugin hash vary in the rule; the parent must match the exact runner.
- PID 31101, parent 1: `op daemon`, the idle 1Password background process.
- The inspection shell and `ps` process also appeared. They are work, not allowed.

Devon's read-only idle console capture found PID 4909 (parent 1), with the same
runner flags but `--runner-id factory-console`, and its direct plugin child PID
138429 with suffix `OuJYUh` and plugin hash `46ba5e96083e1347`. Console allows
only that exact runner command and its direct plugin child; no `op` daemon.
Both nodes pattern the alphanumeric runtime suffix and hexadecimal plugin hash,
so plugin updates stay idle. Everything else remains exact and fully matched;
a different `amp run` script under either runner still blocks reboot.

From the Mac, inspect and edit each node separately:

```sh
factory-ssh "ps -u agent -ww -o pid=,ppid=,args="
console-ssh "ps -u agent -ww -o pid=,ppid=,args="
ssh -t dgarbs51@factory-gpu 'sudoedit /etc/factory-reboot/node.conf'
ssh -t dgarbs51@factory-console 'sudoedit /etc/factory-reboot/node.conf'
```

JSON strings require doubled backslashes in regex escapes. Matching uses
`re.fullmatch`, not substring matching. No daemon reload is needed for allowlist
edits. Installer reruns preserve these local edits unless `--replace-config` is
specified. An invalid configuration
fails without rebooting; inspect the failed service's journal.

This is the specified process-based busy rule, not a runner activity API.
Inference or remote agent work entirely inside an allowlisted daemon can be
invisible between tool processes. The worktree signal below covers
dispatched work; observe mode must still precede enforcement.

### Agent worktrees

A dispatched thread thinking inside the allowlisted runner has no tool process.
Dispatched builder and QA worktrees are the directories
`/home/agent/work/factory-*`; the main checkout `/home/agent/work/factory` and
other directories are ignored. Any file in one of them, excluding `.git/`
contents and a linked worktree's `.git` pointer file, modified within the last
30 minutes (1,800,000 ms, inclusive) records
`agent-worktree-active: /home/agent/work/factory-<name>`. Future modification
times block too. Symlinks are not followed. An unreadable worktree records
`agent-worktree-unknown`. A finished worktree blocks for up to 30 minutes after
its last write.

### Meter and UPS

On GPU, `curl -fsS --max-time 5
http://127.0.0.1:11434/meter/requests?limit=1000` returns a newest-first JSON
array, not an envelope. Original format inspection returned a request with
`id: 2194`, `endpoint: "/api/version"`, and integer `ts: 1791753470751`
(UTC milliseconds). Health traffic does not block reboot.

Only the endpoints counted by factory-api's `usage_records` in `src/data.rs`
(the `INFERENCE_ENDPOINTS` list in `src/lib.rs`) count as inference:
`/api/generate`, `/api/chat`, `/api/embed`, `/v1/chat/completions`,
`/v1/completions`, and `/v1/embeddings`. Any inference row at or within 600,000
milliseconds blocks, including one behind newer health rows. Stale inference
and an empty array permit the next check. Future inference timestamps block too.
Unreachable, malformed or incorrectly typed output records `meter-unknown` and
skips. The page covers the newest 1,000 requests; pagination would be needed if
that volume could hide the 10-minute window behind newer non-inference traffic.

`upsc cyberpower@localhost ups.status` returned stdout `OL\n`. Its
`Init SSL without certificate database` diagnostic is on stderr and is not
parsed. Status is whitespace-separated tokens; any exact `OB` token blocks,
including `OB DISCHRG`. Nonzero exit, empty output, or no `OL` token blocks as
`ups-unknown`. Live on-battery behavior was not induced; fake outputs test it.

## State and post-boot observations

`/var/lib/factory-reboot/status.json` is root-owned and private. Both services
lock the same state and publish by atomic replacement, with file/directory sync.
Logs go to the journal. A failed state write prevents a reboot.

- `mode`: effective mode of the last operation. The installer's immediate check
  **always** uses observe, even when configuration is enforce; the next timer
  check uses the mode in `/etc/factory-reboot/node.conf`.
- `reboot_required`, `pending_since_ms`, `days_pending`: current marker and age.
- `consecutive_skips`, `alert_due`: skipped-date count and the MET-76 handoff.
- `last_check_ms`, `last_decision`, `last_reason`: most recent reboot decision.
- `last_busy_reason`: the first blocking busy reason from the most recent check,
  or null when idle. It is recorded with or without the marker; postboot leaves
  it unchanged. Older status files gain it as null.
- `last_boot_ms`: kernel `/proc/stat` `btime` seconds converted to milliseconds.
- `postboot.services`: configured unit names mapped to `systemctl is-active`
  states, including failed/inactive/unknown rather than pretending all are healthy.
- `postboot.clock_synced`: true only for successful
  `timedatectl show -p NTPSynchronized` output `NTPSynchronized=yes`.

`factory-postboot.service` runs after `multi-user.target` and `time-sync.target`,
then polls the clock and every configured unit concurrently, every 2 seconds.
Each one gets its own 180-second allowance: the clock until timedatectl reports
synchronization, each unit until it leaves `activating`. A clock that never syncs
or a stuck unit therefore cannot shorten another unit's observation. The final
states are recorded as reported, including `activating`, failed, inactive or
`unknown` (empty output). The total wait is about 180 seconds plus at most one
15-second probe timeout, within `TimeoutStartSec=240`. Waiting happens before
the state lock is taken, so checks are not delayed.
It uses `DefaultDependencies=no` to avoid a cycle with the target enabling it,
and retains explicit shutdown ordering. It observes rather than repairs
services. GPU configuration includes meter, Ollama, Amp and operational NUT
units (not optional/inactive enumerators), plus `factory-api.service` and the
`factory-dispatch`, `factory-usage` and `factory-backup` timers. After MET-114,
console includes `amp-runner.service`, `gdm.service` and `factory-backup.timer`.
If the marker disappears after boot, it clears pending and skip state without
overwriting the preceding reboot decision. If it remains, pending age survives.
Time-sync ordering is not itself proof of synchronization; the boolean records
what timedatectl reports.

## Installation, observation and mode switch

After this PR is merged and both node checkouts have been updated, run **from
the Mac**, GPU first. No build artifact is required for this host-only tooling.

```sh
factory-ssh "sudo bash /home/agent/work/factory/deploy/reboot/install-reboot-policy.sh --node factory-gpu --mode observe"
console-ssh "sudo bash /home/agent/work/factory/deploy/reboot/install-reboot-policy.sh --node factory-console --mode observe"
```

The installer requires root, checks the actual hostname and tools, rejects
symlink destinations/drop-ins/masks, and completes read-only preflight before
changing files. It snapshots existing config, scripts and units under the printed
`/var/backups/factory-reboot/<timestamp>.<suffix>/`, installs the artifacts,
enables the timer and next-boot service, runs one immediate observe check, and
prints JSON. On an unchanged rerun, only configuration is republished; scripts
and units are not rewritten. Snapshots and the immediate observation still occur.
Harness overrides and inherited command paths are discarded by installers.

Reruns preserve the installed node configuration by default. To apply updated
repository allowlists or service lists, add `--replace-config`; this replaces the entire node
configuration, including local edits, after snapshotting the old config. Mode
still comes from `--mode` (observe by default), not the repository file:

```sh
factory-ssh "sudo bash /home/agent/work/factory/deploy/reboot/install-reboot-policy.sh --node factory-gpu --mode observe --replace-config"
console-ssh "sudo bash /home/agent/work/factory/deploy/reboot/install-reboot-policy.sh --node factory-console --mode observe --replace-config"
```

MET-147 changed both service lists, so installed configurations from before it
(console still listing `factory-api.service`) need this `--replace-config` rerun.
Re-add any local allowlist edits afterwards; the printed snapshot keeps the old
configuration.

Read status and recent decisions from the Mac:

```sh
factory-ssh "sudo cat /var/lib/factory-reboot/status.json; sudo journalctl -u factory-reboot.service -u factory-postboot.service -n 30 --no-pager"
console-ssh "sudo cat /var/lib/factory-reboot/status.json; sudo journalctl -u factory-reboot.service -u factory-postboot.service -n 30 --no-pager"
```

Only after reviewing observe results and both allowlists, switch modes:

```sh
factory-ssh "sudo bash /home/agent/work/factory/deploy/reboot/install-reboot-policy.sh --node factory-gpu --mode enforce"
console-ssh "sudo bash /home/agent/work/factory/deploy/reboot/install-reboot-policy.sh --node factory-console --mode enforce"
```

Rerun with `--mode observe` to stop future enforcement. Do not manually start
`factory-reboot.service` in enforce mode: that bypasses the scheduled window.
Rollback disables/stops and removes this policy, preserving status, journals and
snapshots; it does not automatically restore old policy files or enable states:

```sh
factory-ssh "sudo bash /home/agent/work/factory/deploy/reboot/rollback-reboot-policy.sh"
console-ssh "sudo bash /home/agent/work/factory/deploy/reboot/rollback-reboot-policy.sh"
```

## No-root verification

```sh
python3 -B deploy/reboot/test-reboot.py
for script in deploy/reboot/*.sh; do bash -n "$script"; done
shellcheck -x deploy/reboot/*.sh
```

The harness runs the real check scripts with `REBOOT_ROOT`, `REBOOT_CONFIG`,
`REBOOT_NOW_MS`, and fake command paths. It covers decision order, both modes,
busy/allowed processes, worktree activity, `last_busy_reason` without the
marker, meter time boundaries/errors, UPS states/errors,
consecutive dates, post-boot state and its independent bounded clock/service waits, both calendars and concurrent atomic reads.
Where usable `bwrap` exists, it additionally runs the real installer/rollback
in root user namespaces with fake commands and temporary destinations; it
models ownership rather than changing host ownership. Without namespaces that
additional installer check is explicitly skipped, not reported as passed.
No real timer installation, service mutation or reboot is part of these tests.
