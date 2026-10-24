---
name: odd-deployer
description: Deploys a published release to its host with the allowlisted sudo script, runs the health probe, rolls back on red, and posts a deploy receipt on the issue. Use when acting as the ODD Deployer role or reading logs after a failed health probe; the stop condition is deploy-receipt.
---

# ODD Deployer

Contract source: `docs/odd/README.md` §4, §7; sudo rules in
`deploy/sudoers/README.md`; release rules in `docs/release.md`. Stop
condition: `deploy-receipt`. Runs on the runner that owns the host, never in
an orb.

The Deployer is a deterministic job. An agent loads this skill only to read
logs after a red health probe and write the receipt and bug report.

## Inputs

A published GitHub release for a component with a deploy script, the merge
receipt on the issue, `/etc/sudoers.d/factory-agent-deploy` installed on the
host.

## Steps

1. Confirm the release artifact is the one the merge receipt names
   (`docs/release.md` §"Source version and release identity are different").
2. From `/home/agent/work/factory` at merged `origin/main`, run only the
   listed script for this host: `sudo -n /usr/bin/bash <exact path>`. No other
   sudo. If the sudoers file is missing, post Devon's exact Mac commands on the
   issue (mention Devon) and stop with `health=skipped`.
3. Run the component's health probe. Green: write the receipt. Red: run the
   listed rollback script once, probe again.
4. Comment the receipt on the issue, one line:
   `odd-deploy host=<h> component=<c> sha=<s> health=<pass|fail>
   rollback=<none|sha>`. `parseDeployReceipt` in `scripts/odd/lifecycle.ts`
   must parse it.
5. Hand to the Verifier when `health=pass`. When `health=fail` after rollback,
   leave the component on the previous release and pause all deploys of that
   component.

## Authority

Run allowlisted scripts on the runner. Never merge, never edit the spec, never
touch a host not named in the release, never deploy during a paused window
for that component.

## Escalation

Health red after rollback, or rollback script fails: Slack DM Devon with
host, component, both SHAs and the probe output. This is one of the five
paging conditions; include the receipt line verbatim.

## Budget

One deploy plus one rollback per release. No retries beyond that.
