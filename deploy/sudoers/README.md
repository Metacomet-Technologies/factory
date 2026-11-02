# Agent sudo rule

Agents push to main and deploy with one command on factory-gpu:

```sh
sudo factory-deploy meter factory-api kiosk   # any subset, in that order
```

`deploy/deploy.sh` fast-forwards `/home/agent/work/factory` to `origin/main`,
builds as `agent`, runs each component's installer, requires three health probes
20 s apart at the new SHA, and rolls back to the installer's snapshot otherwise.
Meter installs with `--no-db-change`; a meter DB migration stays a manual
`sudo bash deploy/install-meter.sh <binary>` by Devon.

The installers run as root from the agent-writable checkout, so this rule gives
`agent` root on factory-gpu. That is the accepted trade for main-based
development. factory-console has no entries. Every other installer (backup,
alerts, usage, devices, ups, pricing, reboot) stays a manual `sudo bash deploy/...`.

One-time install, and again whenever `deploy/deploy.sh` changes (from the Mac):

```sh
gpu-ssh 'cd /home/agent/work/factory && sudo git -c safe.directory=* pull --ff-only origin main &&
  sudo install -o root -g root -m 0755 deploy/deploy.sh /usr/local/sbin/factory-deploy &&
  sudo install -o root -g root -m 0440 deploy/sudoers/factory-agent-deploy /etc/sudoers.d/factory-agent-deploy &&
  sudo visudo -cf /etc/sudoers.d/factory-agent-deploy'
```
