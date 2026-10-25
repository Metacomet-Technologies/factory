# Apply the agent environment and Atuin handoff

These are operator steps, not automatic deployment. Run node commands as an
administrator from the reviewed, merged checkout at `/home/agent/work/factory`.
Do not run them from an agent worktree. None has been applied by this change.
Keep each installer's printed snapshot path for rollback.

## Prepare both nodes

1. Apply dotfiles host-base and the user roles on both nodes using the dotfiles
   bootstrap instructions. Confirm that the `agent` role created
   `/home/agent/.config/agent/env` with `NO_COLOR=1`. Do not print the full
   environment. Dotfiles owns shell config, the Atuin client, and shared tools.
2. On each node, run `sudo bash deploy/install-agent-env.sh`.
   The installer saves the previous drop-in, runs `daemon-reload`, and prints
   the restart command. It does not restart anything.
3. At an approved maintenance point, restart each runner explicitly:
   `sudo systemctl restart amp-runner.service`. This can interrupt agent work.
   The unit loads `/etc/factory/agent.env` first as a transitional hotfix, then
   `/home/agent/.config/agent/env`. The user file wins for duplicate keys.
4. On each node, run `sudo bash deploy/install-environment-cleanup.sh`.
   It refuses unless the live `amp-runner` MainPID contains exactly
   `NO_COLOR=1`. It removes only `PAGER`, `GIT_PAGER`, `SYSTEMD_PAGER`, and
   `NO_COLOR` assignments from `/etc/environment`. Comments, other variables,
   and `/etc/gitconfig` stay unchanged. Existing login sessions keep their old
   environment. Open a new session to check human color and pager behavior.

## Prepare and activate Atuin on factory-gpu

1. Run `sudo bash deploy/install-atuin-server.sh` on factory-gpu.
   It first displays `tailscale serve status`, downloads standalone
   `atuin-server` v18.23.0 (published September 22, 2026), and verifies SHA256
   `ad42a2696e73af09c9e9c5726a268097611299162ddb5c6f1c52c885f0da674c`.
   It installs `/usr/local/bin/atuin-server`, a dedicated system account,
   `/etc/atuin/server.toml`, and the hardened unit. It reloads units without
   starting or enabling the service. It refuses to replace a running server.
2. Run `sudo systemctl enable --now atuin-server.service` when activation is
   approved. `StateDirectory=atuin` creates `/var/lib/atuin` with mode 0700.
   The server owns SQLite at `/var/lib/atuin/atuin.db` and listens only on
   `127.0.0.1:8888`.
3. Verify the local endpoint and listener:

   ```sh
   curl --fail --max-time 5 http://127.0.0.1:8888/
   ss -H -ltn 'sport = :8888'
   ```

4. Inspect `sudo tailscale serve status` again. If HTTPS :8888 already has a
   handler, stop and review it. Otherwise add only the new port:

   ```sh
   sudo tailscale serve --bg --https=8888 http://127.0.0.1:8888
   sudo tailscale serve status
   ```

   Confirm that factory-api's existing :443 handler still forwards to
   `127.0.0.1:8080`. Never use `serve reset`, replace the whole Serve config,
   or change that handler. Check HTTPS from your Mac:
   `curl --fail --max-time 5 https://factory-gpu.bearded-pompano.ts.net:8888/`.

## Register accounts once

Registration is closed by default. Restrict tailnet access to intended admins
before this temporary window. In `/etc/atuin/server.toml`, change
`open_registration = false` to `true` with `sudoedit`, then explicitly restart
`atuin-server.service`. Set each client's sync address to
`https://factory-gpu.bearded-pompano.ts.net:8888` using dotfiles. Devon registers
with `atuin register` interactively. Other admins register only if they want
their own account.

Immediately set `open_registration = false` again and restart the service.
Confirm that new registration is rejected while existing accounts can log in
and sync. Never include passwords or history in command lines, logs, or PRs.

## Add verified backups before relying on sync

Update the backup installation on both nodes, even before Atuin is activated.
Run the receiver (factory-console) first, then the sender (factory-gpu):

```sh
sudo bash deploy/backup/install-backup.sh
```

After both installers finish and GPU has pushed its first backup, run on both nodes:

```sh
sudo /usr/local/lib/factory-backup/restore-check.sh all
```

The existing installer restarts backup units and performs an immediate backup.
Approve that activation separately from preparing Atuin. The GPU config adds
the `atuin` database. The console config accepts and retains its replica.
Until the Atuin DB exists, backup logs and skips it without blocking the other
databases or retention. Restore checks skip an Atuin archive tree that does not
exist yet. Once Atuin is activated, the next backup includes it automatically.
Confirm integrity, checksum, and restore-check success for the Atuin archive
without displaying history. Backup runs as root and reads the private DB
without widening its permissions. Off-site backup remains MET-308.

For Mac setup, use [the shared client instructions](../client/README.md).
Remove old manually sourced helper copies to avoid duplicate definitions.
`install-factory-agent.sh` and its `~/.zsh_factory` writer are absent from this
repository and its fetched history. No replacement writer is added here.

## Roll back prepared files

Run each rollback with the corresponding installer's snapshot path:

```sh
sudo bash deploy/rollback-environment-cleanup.sh /var/backups/factory-environment/install.EXAMPLE
sudo bash deploy/rollback-agent-env.sh /var/backups/factory-agent-env/install.EXAMPLE
sudo bash deploy/rollback-atuin-server.sh /var/backups/factory-atuin/install.EXAMPLE
```

Each rollback saves current files before restoring the selected snapshot.
The runner rollback reloads units but never restarts the runner. Restart it
explicitly at a maintenance point if you need the old environment in memory.

If Atuin was activated, first disable and stop it explicitly with
`sudo systemctl disable --now atuin-server.service`, then remove only its
handler with `sudo tailscale serve --https=8888 off`. The Atuin rollback
refuses an active service and retains the account, DB, and backups. It does
not revert database migrations. Before downgrading an existing server, verify
upstream schema compatibility and take a fresh verified SQLite backup.
Restore backup configuration with `deploy/backup/rollback-backup-config.sh`
as described in the backup runbook. Never delete history or archive trees.
