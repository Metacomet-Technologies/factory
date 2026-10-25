"""Offline behavior checks. Run with: python3 -B client/test_factory.py."""

import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest


CLIENT = Path(__file__).resolve().parent
ZSH = os.environ.get("ZSH", "zsh")


class FactoryHelpers(unittest.TestCase):
    def run_zsh(self, body, *, env=None):
        with tempfile.TemporaryDirectory(prefix="factory-client-") as home:
            variables = {
                **os.environ,
                "HOME": home,
                "USER": "mac-user",
                "FACTORY_SSH_USER": "",
                "FACTORY_RDP_USER": "",
                "FACTORY_RDP_KEYCHAIN_ACCOUNT": "",
                **(env or {}),
            }
            return subprocess.run(
                [ZSH, "-f", "-c", f"source {shlex.quote(str(CLIENT / 'factory.zsh'))}\n{body}"],
                cwd=home,
                env=variables,
                text=True,
                capture_output=True,
                timeout=10,
            )

    def test_relative_env_and_all_helpers(self):
        result = self.run_zsh("""
            for helper in gpu-ssh gpu-desktop gpu-dash gpu-agent console-ssh console-desktop console-agent kvm-ssh kvm-web factory-status; do
                (( $+functions[$helper] )) || exit 1
            done
            print -r -- "$FACTORY_GPU|$FACTORY_CONSOLE|$FACTORY_KVM_WEB"
        """)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "factory-gpu|factory-console|https://100.115.254.114")

    def test_node_user_and_argument_forwarding(self):
        for helper, host in (("gpu-ssh", "factory-gpu"), ("console-ssh", "factory-console")):
            for override, user in (("", "mac-user"), ("david", "david")):
                with self.subTest(helper=helper, override=override):
                    result = self.run_zsh(f"""
                        _factory_ready() {{ return 0; }}
                        ssh() {{ printf '<%s>\\n' "$@"; }}
                        {helper} 'one two' '' 'a;b'
                    """, env={"FACTORY_SSH_USER": override})
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.splitlines(), [f"<{user}@{host}>", "<one two>", "<>", "<a;b>"])

    def test_kvm_and_browser_targets(self):
        result = self.run_zsh("""
            _factory_ready() { return 0; }
            ssh() { print -r -- "$TERM|$*"; }
            open() { print -r -- "$*"; }
            kvm-ssh uptime
            kvm-web
            gpu-dash
        """, env={"FACTORY_SSH_USER": "david"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "xterm-256color|root@factory-kvm uptime",
            "https://100.115.254.114",
            "https://factory-gpu.bearded-pompano.ts.net",
        ])

    def test_unreachable_node_blocks_actions(self):
        result = self.run_zsh("""
            tailscale() {
                case "$1 $2" in
                    'status --json') print '{"BackendState":"Running"}' ;;
                    'switch --list') print 'id metacomet-technologies.org.github *' ;;
                    'ping -c') return 1 ;;
                esac
            }
            ssh() { print UNEXPECTED_SSH; }
            gpu-ssh
        """)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("can't reach factory-gpu", result.stdout)
        self.assertNotIn("UNEXPECTED_SSH", result.stdout)

    def test_tailnet_switch_before_ssh(self):
        result = self.run_zsh("""
            tailscale() {
                case "$1 $2" in
                    'status --json') print '{"BackendState":"Running"}' ;;
                    'switch --list') print 'id other-tailnet *' ;;
                    *) print -r -- "$*" >> "$HOME/actions" ;;
                esac
            }
            ssh() { print -r -- "ssh $*" >> "$HOME/actions"; }
            console-ssh uptime
            cat "$HOME/actions"
        """)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[-3:], [
            "switch metacomet-technologies.org.github",
            "ping -c 1 --timeout 5s factory-console",
            "ssh mac-user@factory-console uptime",
        ])

    def test_desktop_host_and_argument_dispatch(self):
        result = self.run_zsh("""
            _factory_rdp() { printf '<%s>\\n' "$@"; }
            gpu-desktop /size:1280x800
            console-desktop /size:1920x1080
        """)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "<factory-gpu>", "</size:1280x800>",
            "<factory-console>", "</size:1920x1080>",
        ])

    def test_agent_tools_and_quoted_arguments(self):
        args = ["one two", "", "a;b", "$(touch unexpected)", "it's quoted"]
        for helper, host in (("gpu-agent", "factory-gpu"), ("console-agent", "factory-console")):
            for tool in ("claude", "amp", "agent", "opencode", "codex", "kimi"):
                with self.subTest(helper=helper, tool=tool):
                    result = self.run_zsh(f"""
                        _factory_ready() {{ return 0; }}
                        ssh() {{ printf '%s\\n' "$@"; }}
                        {helper} {tool} {shlex.join(args)}
                    """, env={"FACTORY_SSH_USER": "david"})
                    self.assertEqual(result.returncode, 0, result.stderr)
                    lines = result.stdout.splitlines()
                    self.assertEqual(lines[:2], ["-t", f"david@{host}"])
                    self.assertEqual(shlex.split(lines[2]), [
                        "sudo", "-iu", "agent", "env", "-C", "/home/agent/work/factory", tool, *args,
                    ])
        result = self.run_zsh("gpu-agent not-a-tool")
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage: gpu-agent", result.stderr)
        result = self.run_zsh("console-agent")
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage: console-agent", result.stderr)

    def test_rdp_stdin_and_keychain_accounts(self):
        for overrides, user, account in (
            ({}, "mac-user", "mac-user"),
            ({"FACTORY_SSH_USER": "david"}, "david", "david"),
            ({"FACTORY_RDP_USER": "desktop", "FACTORY_RDP_KEYCHAIN_ACCOUNT": "legacy"}, "desktop", "legacy"),
        ):
            with self.subTest(overrides=overrides):
                result = self.run_zsh("""
                    _factory_ready() { return 0; }
                    security() { printf '%s\n' "$@" > "$HOME/keychain-args"; print 'test-password'; }
                    nohup() {
                        printf '%s\n' "$@" > "$HOME/freerdp-args"
                        cat > "$HOME/freerdp-stdin"
                        touch "$HOME/done"
                    }
                    gpu-desktop /size:1280x800 >/dev/null
                    for i in {1..100}; do [[ -f $HOME/done ]] && break; sleep 0.01; done
                    [[ -f $HOME/done ]] || exit 1
                    cat "$HOME/keychain-args" "$HOME/freerdp-args" "$HOME/freerdp-stdin"
                    [[ -s $HOME/Library/Logs/factory-gpu-desktop.pid ]]
                """, env=overrides)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [
                    "find-generic-password", "-s", "factory-gpu-rdp", "-a", account, "-w",
                    "sdl-freerdp", "/args-from:stdin", "/v:factory-gpu", f"/u:{user}",
                    "/p:test-password", "/cert:tofu", "/dynamic-resolution", "+clipboard",
                    "/kbd:remap:0x15b=0x1d", "/size:1280x800",
                ])

    def test_status_uses_node_override_and_env_in_remote_script(self):
        result = self.run_zsh("""
            _factory_ready() { return 0; }
            tailscale() { print 'id metacomet-technologies.org.github *'; }
            ssh() { printf 'SSH <%s>\n' "$@"; cat > "$HOME/remote-script"; }
            curl() {
                case "$*" in
                    *time_total*) printf '200 0.1' ;;
                    *http_code*) printf 302 ;;
                    *version.json*) print '{"build":"test"}' ;;
                    *v1/fleet*) print '{"nodes":[{"services":[{"ok":true}]}]}' ;;
                esac
            }
            factory-status
            bash -n "$HOME/remote-script" || exit 1
        """, env={"FACTORY_SSH_USER": "david"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("SSH <david@factory-gpu>", result.stdout)
        self.assertIn("SSH <david@factory-console>", result.stdout)
        self.assertEqual(result.stdout.count("SSH <factory-gpu>"), 2)
        plain = re.sub(r"\x1b\[[0-9;]*m", "", result.stdout)
        self.assertIn("✓ fleet all green", plain)
        self.assertIn("✓ kvm web redirects to login", plain)
        self.assertIn("✓ v1/pricing 0.1s", plain)


if __name__ == "__main__":
    if not shutil.which(ZSH):
        raise SystemExit("zsh is required (or set ZSH to its executable path)")
    unittest.main()
