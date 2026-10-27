# Agent deploy sudoers

`factory-agent-deploy` lets `agent` on factory-gpu run the five scripts
`scripts/odd/deploy.ts` calls as root without a password:
`install-{meter,factory-api,kiosk}.sh`, `rollback-meter-v1.sh` and
`rollback-factory-api.sh`. The kiosk rollback is `install-kiosk.sh --rollback
SNAPSHOT`, which validates the snapshot and then runs the staged
`rollback-kiosk.sh`; `rollback-kiosk.sh` itself is not allowlisted. Each entry names a script in
`/usr/local/lib/factory-deploy`, a root-owned tree Devon stages from a verified
immutable release (MET-375). No entry names the agent-writable checkout
`/home/agent/work/factory`. Nothing installs the file automatically; Devon
installs it with `stage-trusted.sh`.

Both hosts run sudo-rs 0.2.13 (`visudo -V`). sudo-rs allows no argument
wildcards except a trailing `*`, which means "zero or more further arguments".
Each entry pins `/usr/bin/bash` and one exact script path.
`visudo -c -f deploy/sudoers/factory-agent-deploy` parses it.

The deployer runs `sudo -n /usr/bin/bash /usr/local/lib/factory-deploy/deploy/<script> ARGS`.
factory-console has no entries. Every other installer, including dispatch,
usage, `devices-agent/`, `alerts/`, `backup/`, `reboot/`, `ups/`, `devices/`
and the factory-api move scripts, needs Devon.

## What the staged tree enforces

- Fixed source. The scripts read their units and helpers (`meter.service`,
  `factory-api.service`, `set_ollama_host.py`, `device-tokens.sh`, the alerts
  drop-in) from their own tree, never from the caller. `--source-checkout` only
  names the clean checkout an artifact's build identity must match (MET-239).
- Verified assets. When a script runs from the staged tree, it sources
  `deploy/sudoers/trusted-assets.sh` before any change. That check refuses
  unless the tree, every parent directory and each file the script runs or
  reads as root meet all of these conditions:
  - Root owns it.
  - It is not group- or other-writable.
  - It is not a symlink.
  - It still has the digest `stage-trusted.sh` recorded in `SHA256SUMS`.

  A missing, changed or symlinked asset is refused. There is no fallback to the
  agent checkout.
- Release match. Before any privileged call, including a read-only `--plan`,
  `deploy.ts` checks every staged privileged file against the release it is
  about to install (`requireStaged`). It holds the release when a file is
  missing, writable, symlinked, changed since staging or different from that
  release (`staged-assets-held`). Holding writes no receipt, ledger record or
  `lastTag`. The deployer retries on every tick until Devon restages, so a
  release that changes an installer waits for Devon. Replacing privileged
  wrappers stays a human operation.
- Snapshot paths. `rollback-meter-v1.sh`, `rollback-factory-api.sh` and
  `install-kiosk.sh --rollback` accept only a root-owned snapshot directly inside
  root-owned `/var/backups/meter`, `/var/backups/factory-api` or
  `/var/backups/factory-kiosk`, never a caller-chosen tree.
- A clean environment. sudo-rs resets the environment, so `BASH_ENV` and
  similar variables do not reach root `bash`.

## What it still grants

- Root installs artifacts that `agent` chooses: a binary or a kiosk `dist`
  whose embedded build identity matches a clean checkout. The meter and API
  binaries run as their own service users, never as root, but `agent` can still
  pick which binary runs. MET-158's constrained executor closes this gap; this
  file does not.
- Any process running as `agent` can still use the five entries until
  `NoNewPrivileges` covers the runner (below). `factory-deploy.service` keeps
  `NoNewPrivileges=false` because it needs these entries.
- sudo-rs logs each command and its arguments to the journal, and root can
  rewrite that log. sudo-rs has no I/O logging, so never pass a secret as an
  argument.

## Activation (Devon, from the Mac)

Run these in order. Each step validates before the next one changes anything.

1. Merge this change, then wait for the deployer to log `tools-promoted` for the
   first release that contains it. From that tick on, a release that installs
   anything is held with `staged-assets-held` until step 3. The old allowlist
   stays in place but is unused.
2. Pin the release. `DIGEST` is GitHub's immutable asset digest.

   ```sh
   TAG=REPLACE_WITH_FIRST_RELEASE_CONTAINING_MET_375
   SHA=$(gh api repos/Metacomet-Technologies/factory/commits/"$TAG" --jq .sha)
   DIGEST=$(gh release view "$TAG" -R Metacomet-Technologies/factory --json assets --jq '.assets[] | select(.name == "deployment.tar.gz") | .digest')
   gh release download "$TAG" -R Metacomet-Technologies/factory -p deployment.tar.gz -O /tmp/deployment.tar.gz
   echo "${DIGEST#sha256:}  /tmp/deployment.tar.gz" | shasum -a 256 -c -
   ```

3. Stage and activate. The timer stops first, and root receives the archive into
   a root-only directory, verifies the pinned digest and source SHA, then runs
   `stage-trusted.sh`. `stage-trusted.sh` refuses when any of these is true:
   - The host is not factory-gpu.
   - The running deployer does not call the staged tree.
   - `factory-deploy.service` is busy.
   - The unpacked release contains a symlink.
   - The release's sudoers file does not parse.

   If none applies, it copies the release into
   `/usr/local/lib/factory-deploy` (root:root, nothing group- or other-writable)
   and records `SHA256SUMS`. It keeps the previous tree as `.previous`, validates
   the new tree as the scripts will, then installs the exact sudoers file with
   `visudo` checks and prints `sudo -l -U agent`.

   ```sh
   gpu-ssh 'sudo systemctl stop factory-deploy.timer && systemctl show factory-deploy.service -p ActiveState -p MainPID'
   gpu-ssh 'sudo install -d -o root -g root -m 0700 /root/met-375 && sudo tee /root/met-375/deployment.tar.gz >/dev/null' < /tmp/deployment.tar.gz
   gpu-ssh "sudo bash -s -- '${DIGEST#sha256:}' '$SHA'" <<'ROOT'
   set -euo pipefail
   umask 077
   cd /root/met-375
   echo "$1  deployment.tar.gz" | sha256sum -c -
   rm -rf unpacked && mkdir unpacked
   tar --no-same-owner -xzf deployment.tar.gz -C unpacked
   test "$(cat unpacked/release-source.json)" = "{\"source_sha\":\"$2\"}"
   bash unpacked/deploy/sudoers/stage-trusted.sh /root/met-375/unpacked
   ROOT
   gpu-ssh 'sudo rm -rf /root/met-375 && sudo systemctl start factory-deploy.timer'
   ```

   The next tick installs the held release through the staged tree.

4. Confirm that `sudo -l -U agent` lists only the five
   `/usr/local/lib/factory-deploy/deploy/...` entries and no `/home/agent` path:

   ```sh
   gpu-ssh 'sudo -l -U agent; stat -c "%U:%G %a %n" / /usr /usr/local /usr/local/lib /usr/local/lib/factory-deploy /usr/local/lib/factory-deploy/deploy /usr/local/lib/factory-deploy/deploy/*.sh /usr/local/lib/factory-deploy/SHA256SUMS'
   ```

5. Restage, using steps 2 and 3, whenever `staged-assets-held` names a file that
   differs from a new release, after reviewing that change.

## Runner: NoNewPrivileges (Devon, separate step)

Amp runner threads, including builders and QA, are descendants of
`amp-runner.service`. A drop-in stops them from gaining privileges through
sudo or setuid binaries. `factory-deploy.service` is a separate unit and keeps
the privilege it needs. **The restart interrupts every running runner thread**,
so pick a time when none is mid-turn.

```sh
gpu-ssh 'sudo install -d -m 0755 /etc/systemd/system/amp-runner.service.d && printf "[Service]\nNoNewPrivileges=yes\n" | sudo install -o root -g root -m 0644 /dev/stdin /etc/systemd/system/amp-runner.service.d/50-no-new-privileges.conf && sudo systemctl daemon-reload && sudo systemctl restart amp-runner.service && systemctl show amp-runner.service -p NoNewPrivileges -p ActiveState'
```

Review the runner's flags without printing secrets. Only the command line and
environment variable names are shown:

```sh
gpu-ssh 'systemctl show amp-runner.service -p ExecStart -p DropInPaths; pid=$(systemctl show amp-runner.service -p MainPID --value); sudo tr "\0" "\n" < /proc/$pid/environ | cut -d= -f1 | sort'
```

- Keep `--amp-env`. It injects the scoped server variables that ODD threads use
  for GitHub, such as `AGENT_GH_TOKEN` (`docs/amp-cli.md` §8).
- Remove `--remote-control-terminal` unless you use the runner's Terminal from
  ampcode.com. No ODD role uses it, and it gives anyone who controls the thread
  an interactive shell as `agent`. NoNewPrivileges keeps that shell from using
  sudo, but it remains a shell. If you remove it, edit the runner's `ExecStart`
  and restart in the same window.

Acceptance, posted as a comment on MET-375:

- `NoNewPrivileges=yes` from `systemctl show`.
- From a runner thread: `grep NoNewPrivs /proc/self/status` shows `1`, and
  `sudo -n /usr/bin/bash /usr/local/lib/factory-deploy/deploy/install-kiosk.sh --check-only`
  is denied.
- The `stat` output from step 4: root owns the scripts and every parent, with
  no group or other write bit.
- The next scheduled `factory-deploy` result (`journalctl -u factory-deploy`).
- Which runner flags you kept.

## Rollback

Restore the previous staged tree, or remove the allowlist entirely. Neither
restores the old agent-checkout entries. Those entries are effective root for
`agent`; reinstall them only as a deliberate, reviewed decision.

```sh
gpu-ssh 'sudo rm -f /etc/sudoers.d/factory-agent-deploy && sudo visudo -c && sudo -l -U agent'
gpu-ssh 'sudo mv --exchange --no-copy -T /usr/local/lib/factory-deploy.previous /usr/local/lib/factory-deploy'
gpu-ssh 'sudo rm /etc/systemd/system/amp-runner.service.d/50-no-new-privileges.conf && sudo systemctl daemon-reload && sudo systemctl restart amp-runner.service'
```

Without the allowlist, the deployer's `sudo -n` is refused before the installer
starts, so each pending release ends with a `health=fail` receipt. Stop
`factory-deploy.timer` first.
