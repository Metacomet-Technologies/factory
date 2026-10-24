---
name: odd-deployer
description: Deploys a published release to its host with the allowlisted sudo script, runs the health probe, rolls back on red, and posts a deploy receipt on the issue. Use when acting as the ODD Deployer role or reading logs after a failed health probe; the stop condition is deploy-receipt.
---

# ODD Deployer

Contract source: `docs/odd/README.md` §4, §7; sudo rules in
`deploy/sudoers/README.md`; release rules in `docs/release.md`. Stop
condition: `deploy-receipt`. Runs on the runner that owns the host, never in
an orb.

The Deployer is a deterministic job: `scripts/odd/deploy.ts`, run every two
minutes by `factory-deploy.timer` on factory-gpu as `agent`. An agent loads
this skill only to read its logs after a red health probe, a failed rollback
or a stuck release, and to turn them into a bug report. The agent never runs
an installer, a rollback script or `sudo`; the job owns those.

## What the job does

1. `gh release list` → every `v*` tag newer than `lastTag` in the ledger
   `~/.local/state/factory-odd/deploy.json`, oldest first. The first run only
   records the newest tag as `lastTag`; the next published release is the
   first automatic deploy.
2. Per release: fetch tags, require the tag commit to be an ancestor of
   `origin/main`, `release.py verify --anonymous` into
   `~/.local/state/factory-odd/releases/<tag>` (marker `.verified`), unpack
   `kiosk.tar.gz`, refuse a dirty `/home/agent/work/factory`, then
   `git checkout --detach <sha>` there so the installers read the released
   sources. Afterwards `main` is fast-forwarded to the deployed SHA when it
   was behind, otherwise the checkout stays detached and the log says so.
3. Plan: a component installs when the inventory `sources` for it in
   `deploy/components.json`, or its installer and rollback scripts, changed
   between its baseline and the release SHA. The baseline is the newer of the
   ledger SHA and the SHA the live health endpoint reports. Enabled
   components, in install order: `meter`, `factory-api`, `kiosk`.
   Everything else (dispatcher, usage until it has a rollback that restores
   the previous timer, pricing, ups-control, alerts, backup, reboot, nut,
   devices) stays with Devon.
4. Install: `sudo -n /usr/bin/bash /home/agent/work/factory/deploy/install-<c>.sh <artifact>`,
   three health probes 20 s apart, all three must report the release SHA.
   Red: the listed rollback script runs once with the snapshot path the
   installer printed, then three more probes must find a healthy previous
   release: `rollback=<snapshot>`, otherwise `rollback=none`. The release stops at the first failed component. A failed
   component record is never a baseline; the next release retries it.
5. Receipt, one line per issue the release closes
   (`(#N)` merge subjects → PR body `closes`/`contributes` lines), posted only
   on issues currently in `Deploying`:
   `odd-deploy host=factory-gpu component=<a+b|none|failed> sha=<sha>
   health=<pass|fail> rollback=<none|snapshot>`. The receipt is saved in the
   ledger before delivery, so a crashed run posts the rest without
   redeploying; an issue that already carries the exact line is not posted
   to again, and a failed PR lookup keeps the release pending. A killed
   run's in-flight component finishes before anything else installs. `parseDeployReceipt` in
   `scripts/odd/lifecycle.ts` must parse it. The ledger `lastTag` advances
   even on failure so one broken release cannot block the next.

The control plane turns the receipt into `Done` (pass), `Todo` plus a Bug
follow-up (fail with rollback), or a page (fail without rollback).

## Inputs for the agent

The control plane starts you (Amp low, runner factory-gpu, thread label
`odd-deploy-<sha12>`) once per red release. Your first message carries the
receipt line, the issue, and the Bug follow-up to attach to (none when the
rollback failed: comment on the issue instead).

`journalctl -u factory-deploy --since -2h` (JSON lines, `decision` field:
`pending`, `checkout`, `baseline`, `plan`, `resume`, `install`,
`installer-output`, `probe`, `rollback`, `rollback-probe`,
`rollback-missing-snapshot`, `rollback-unavailable`, `receipt`,
`receipt-resume`, `receipt-exists`, `receipt-skipped`, `main-left-detached`; a failure ends the run
with a non-zero exit and the receipt line in the error), the ledger, the
receipt comment on the issue, and the component health endpoint.

## Steps for the agent

1. Find the failing `install`, `probe` or `rollback` event and quote it.
2. Compare the probe `git_sha` with the receipt `sha`; name which component
   is live on which SHA.
3. Comment the excerpts and diagnosis on the Bug named in your first message
   (on the issue when there is none), then stop. Never file another Bug.

## Authority

Read logs, the ledger and health endpoints. Never run the installers, the
rollback scripts, `sudo`, `systemctl` or `git checkout` in
`/home/agent/work/factory`; never merge; never edit the spec; never touch a
host not named in the release.

## Escalation

`rollback=none` with `health=fail`, or the same release failing twice: the
control plane pages Devon with the receipt line verbatim. The agent adds the
probe output and the failing event to the issue; it does not page.

## Budget

One deploy plus one rollback per component per release. No retries beyond
that; the next release is the retry.
