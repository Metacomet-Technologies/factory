# Agent deploy sudoers (proposal)

`factory-agent-deploy` lets `agent` run the listed install and rollback scripts
as root without a password, so the orchestrator
(`docs/agents/orchestrator.md`) can deploy merged work without waiting for
Devon. Nothing installs it automatically. Devon reviews and installs it by hand.

Both hosts run sudo-rs 0.2.13 (`visudo -V`). sudo-rs allows no argument
wildcards except a trailing `*`, which means "zero or more further arguments".
Each entry pins `/usr/bin/bash` and one exact script path.
`visudo -c -f deploy/sudoers/factory-agent-deploy` parses it.

| Host | Scripts under `/home/agent/work/factory/deploy/` |
| --- | --- |
| factory-gpu | `install-{dispatch,factory-api,kiosk,meter,usage}.sh`, `rollback-{dispatch,factory-api,kiosk,meter,meter-v1,usage}.sh` |
| factory-console | `devices-agent/install-devices-agent.sh`, `devices-agent/rollback-devices-agent.sh` |

Usage after install, as `agent` on the host:
`sudo -n /usr/bin/bash /home/agent/work/factory/deploy/install-kiosk.sh /home/agent/work/factory/kiosk/dist`.
The script must be run through `/usr/bin/bash` because several scripts are
mode 0644.

Excluded on purpose, so they still need Devon: `alerts/`, `backup/`,
`reboot/`, `ups/`, `devices/`, `move-factory-api-to-gpu.sh`,
`prepare-factory-api-move.sh` and `rollback-move-factory-api.sh`. These change
host infrastructure or run one-time migrations.

## Risk: this is root for `agent`, not a boundary

The rule names exact paths, but those paths are not protected:

- `agent` owns `/home/agent/work/factory` and every listed script. Any process
  running as `agent` can edit a script, check out another commit, or replace
  files the script reads, such as `target/release/*` binaries and
  `kiosk/dist`, then run it as root. On each host, the rule is equivalent to
  `agent ALL=(root) NOPASSWD: ALL`.
- Every Amp thread on the host (builders and QA included) and any build step
  running as `agent` (cargo, npm or `vp` dependencies included) can use it,
  not just the orchestrator. `amp-runner.service` runs as `agent` without
  `NoNewPrivileges`. Only `factory-dispatch.service` sets
  `NoNewPrivileges=true`, so the dispatcher process itself cannot use sudo.
  "Only the orchestrator uses it" is policy in `docs/agents/orchestrator.md`,
  not something sudo enforces.
- Root already runs agent-built artifacts today, so the change is mainly that
  no human reviews the moment of install.

What the rule does provide:

- Host scoping: each host accepts only its own scripts.
- An audit trail: sudo-rs logs each command and its arguments to the system
  journal. Root can rewrite that log afterwards. sudo-rs has no I/O logging,
  so credentials piped on stdin (as `install-dispatch.sh` and others expect)
  are not recorded. Never pass a secret as an argument.
- A clean environment: sudo-rs resets the environment, so `BASH_ENV` and
  similar variables do not reach root `bash`.

A real boundary needs a root-owned checkout that root updates from
`origin/main`, scripts that accept that path, and artifacts built by a user
other than `agent`. That is not part of this proposal.

## Install (Devon, from the Mac)

Replace `MERGE_SHA` with the merge commit of the PR that added this file. The
orchestrator posts the filled-in commands on the issue. Each command prints the
file it installs, so read it before trusting the result.

```sh
gpu-ssh 'set -euo pipefail; t=$(mktemp); trap "rm -f \"$t\"" EXIT; sudo -u agent git -C /home/agent/work/factory fetch -q origin main; sudo -u agent git -C /home/agent/work/factory merge-base --is-ancestor MERGE_SHA origin/main; sudo -u agent git -C /home/agent/work/factory show MERGE_SHA:deploy/sudoers/factory-agent-deploy > "$t"; cat "$t"; sudo visudo -c -f "$t"; sudo install -o root -g root -m 0440 "$t" /etc/sudoers.d/factory-agent-deploy; sudo visudo -c'
console-ssh 'set -euo pipefail; t=$(mktemp); trap "rm -f \"$t\"" EXIT; sudo -u agent git -C /home/agent/work/factory fetch -q origin main; sudo -u agent git -C /home/agent/work/factory merge-base --is-ancestor MERGE_SHA origin/main; sudo -u agent git -C /home/agent/work/factory show MERGE_SHA:deploy/sudoers/factory-agent-deploy > "$t"; cat "$t"; sudo visudo -c -f "$t"; sudo install -o root -g root -m 0440 "$t" /etc/sudoers.d/factory-agent-deploy; sudo visudo -c'
```

## Verify

```sh
gpu-ssh 'sudo -l -U agent'
console-ssh 'sudo -l -U agent'
```

Each host should list only its own aliased commands, with `NOPASSWD`.

## Rollback

```sh
gpu-ssh 'sudo rm -f /etc/sudoers.d/factory-agent-deploy && sudo visudo -c && sudo -l -U agent'
console-ssh 'sudo rm -f /etc/sudoers.d/factory-agent-deploy && sudo visudo -c && sudo -l -U agent'
```
