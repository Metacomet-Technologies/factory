# Factory Mac helpers

On your Mac, clone the repository:

```sh
git clone https://github.com/metacomet-technologies/factory.git ~/factory
```

Add this single source line to `~/.zshrc`, then start a new terminal:

```zsh
source ~/factory/client/factory.zsh
```

The helpers load `factory.env` beside the zsh file, regardless of your current
directory. That file contains shared host values, not passwords or personal
usernames. SSH uses your Mac's `$USER` by default. If your node login differs,
set `FACTORY_SSH_USER` in `~/.zshrc` (before or after the source line). For Dave,
whose node account is `david`:

```zsh
export FACTORY_SSH_USER=david
```

You need node SSH access and access to the factory Tailscale network. Install
the Tailscale Mac app and ensure `tailscale`, `ssh`, `curl`, and `jq` are on PATH.
Desktop helpers additionally require FreeRDP's `sdl-freerdp` and macOS Keychain
(`security`). If needed, install the command-line dependencies with Homebrew:
`brew install freerdp jq`.

## Commands

| Command | Action |
| --- | --- |
| `gpu-ssh [args...]`, `console-ssh [args...]` | SSH to a node, forwarding arguments. |
| `gpu-desktop [args...]`, `console-desktop [args...]` | Open RDP, replacing an existing helper-launched session to that node. Extra arguments go to FreeRDP. |
| `gpu-dash` | Open the GPU dashboard over HTTPS. |
| `gpu-agent <tool> [args...]`, `console-agent <tool> [args...]` | Run `claude`, `amp`, `agent`, `opencode`, `codex`, or `kimi` as the remote `agent` user. |
| `kvm-ssh [args...]` | SSH as `root@factory-kvm`, with compatible terminal settings. |
| `kvm-web` | Open `https://100.115.254.114` (the appliance uses a self-signed certificate). |
| `factory-status` | Show node reachability, services, GPU, network, disk, dashboard, meter, fleet, API latency, and KVM login health. |

Helpers start/connect Tailscale, switch to the factory tailnet if necessary, and
check reachability before connecting. This can change your active tailnet.
`factory-status` displays individual failures; it is not a CI exit-code gate.
The KVM redirect probe skips certificate verification for the self-signed URL;
dashboard HTTPS and RDP retain certificate checks (RDP uses trust-on-first-use).

## RDP credentials

In Keychain Access, create a generic password item named `factory-gpu-rdp`, with
the Account field set to your node username and the password set to your shared
RDP password for both nodes. Do not put passwords in `factory.env` or `.zshrc`.
The helpers pass credentials to FreeRDP via stdin, not process arguments.
Logs and PID files live in `~/Library/Logs/factory-{gpu,console}-desktop.*`.

RDP defaults to `${FACTORY_SSH_USER:-$USER}`. If the desktop login is different,
set `FACTORY_RDP_USER`. If an existing Keychain item's Account differs from the
desktop login, set `FACTORY_RDP_KEYCHAIN_ACCOUNT` to that Account field. Neither
override changes SSH or the KVM's root login.

## Agent access

Agent commands use your node SSH account, then `sudo -iu agent` on the node.
That account must be authorized for this transition. The working directory is
`/home/agent/work/factory`, the main checkout: use it for read-only work only;
implementation belongs in an assigned worktree. Arguments are shell-quoted
before transmission. Tool completions are registered when `compdef` is loaded.

## Checks

From the repository root:

```sh
zsh -n client/factory.zsh
shellcheck -s bash -e SC2034 client/factory.env
shellcheck -s bash -x client/factory.zsh
python3 -B client/test_factory.py
```

ShellCheck's bash mode checks the shared shell syntax. Line-scoped exclusions
cover zsh's nested expansions (`SC2296`, `SC2298`), builtin arrays (`SC2154`),
intentional SSH argument forwarding (`SC2029`), and an unused retry counter
(`SC2034`). The standalone env check excludes `SC2034` because its assignments
are consumed by the sourced helper. The file is for zsh, not bash.

The Python checks need Python 3.8 or newer, zsh, jq, and bash. They
run offline with mocked SSH, Tailscale, Keychain, browser, and FreeRDP commands.
They cover usernames, argument quoting, blocked connections, RDP stdin, host
URLs, and status probes. They do not connect to factory hosts or start a GUI.
