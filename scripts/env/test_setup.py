#!/usr/bin/env python3
"""Tests for scripts/env/setup.sh against a fake checker and stubbed installers.

The fake checker reports contract items from marker files in a state
directory; the stubs (apt-get, sudo, curl, rustup, vp, cargo) create those
markers and log every call. Exemptions and system packages come from the real
checker, so the tests follow the contract.
"""

import importlib.machinery
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SETUP = os.path.join(HERE, "setup.sh")


def real_checker():
    loader = importlib.machinery.SourceFileLoader("env_check", os.path.join(HERE, "check"))
    spec = importlib.util.spec_from_loader("env_check", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


CHECK = real_checker()
PACKAGES = ["ca-certificates"] + [name for name, _ in CHECK.SYSTEM]

FAKE_CHECK = f"""#!{sys.executable}
import os, sys
state = os.environ["FAKE_STATE"]
EXEMPT = {CHECK.EXEMPT!r}
PACKAGES = {PACKAGES!r}
env = sys.argv[sys.argv.index("--env") + 1]
if env not in EXEMPT:
    sys.exit(2)
have = lambda marker: os.path.exists(os.path.join(state, marker))
layout = os.environ["FAKE_LAYOUT"]
items = [("os", "ubuntu", not have("bad-os")), ("layout:checkout", "checkout", have("checkout")),
         ("layout:vite-plus-env", layout, os.path.isfile(layout)), ("playwright", "chromium", have("playwright")),
         ("vite-plus", "9.8.7", have("vite-plus"))]
items += [(name, "1.99.0", have("rust")) for name in ("rust", "rust:rustfmt", "rust:clippy")]
items += [(name, "24.22.0", have("js")) for name in ("node", "node:repo-root", "bun")]
items += [(name, name, have("apt-" + name.split(":")[0])) for name in PACKAGES]
failing = [(n, e) for n, e, ok in items if not ok and n not in EXEMPT[env]]
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write("check " + " ".join(sys.argv[1:]) + "\\n")
if "--failing" in sys.argv:
    for name, expected in failing:
        print(f"{{name}}\\t{{expected}}\\tNone")
else:
    print('{{"ok": %s}}' % ("false" if failing else "true"))
sys.exit(1 if failing else 0)
"""

# Each stub logs its call; mutating ones then create the marker the fake checker reads.
STUBS = {
    "sudo": 'if [ -e "$FAKE_STATE/no-sudo" ]; then exit 1; fi\n[ "$1" = -n ] && shift\nexec "$@"\n',
    "apt-get": 'if [ "$1" = install ]; then for p; do case "$p" in -*|install) ;; *) : > "$FAKE_STATE/apt-$p" ;; esac; done; fi\n',
    "curl": """case "$*" in
  *sh.rustup.rs*) printf '%s\\n' 'mkdir -p "$HOME/.cargo/bin" && cp "$FAKE_LATE/rustup" "$HOME/.cargo/bin/"' \\
      'echo "export PATH=\\"\\$HOME/.cargo/bin:\\$PATH\\"" > "$HOME/.cargo/env"' 'echo ". \\"\\$HOME/.cargo/env\\"" >> "$HOME/.profile"' ;;
  *vite.plus*) printf '%s\\n' 'echo "VP_VERSION=$VP_VERSION" >> "$FAKE_LOG"' 'mkdir -p "$HOME/.config/vite-plus" "$HOME/vp/bin"' \\
      'cp "$FAKE_LATE/vp" "$HOME/vp/bin/" && : > "$FAKE_STATE/vite-plus"' \\
      'echo "export PATH=\\"$HOME/vp/bin:\\$PATH\\"" > "$HOME/.config/vite-plus/env"' ;;
  *) exit 22 ;;
esac
""",
    "cargo": "",
}
LATE = {
    "rustup": 'if [ "$*" = "toolchain install" ]; then : > "$FAKE_STATE/rust"; fi\n',
    "vp": """case "$*" in
  "env install") : > "$FAKE_STATE/js" ;;
  "install --frozen-lockfile") mkdir -p node_modules ;;
  "exec playwright install chromium") : > "$FAKE_STATE/playwright" ;;
esac
""",
}


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(path, mode)


class SetupTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = tmp.name
        self.repo = os.path.join(self.base, "repo")
        self.home = os.path.join(self.base, "home")
        self.state = os.path.join(self.base, "state")
        self.log = os.path.join(self.base, "calls.log")
        self.layout = os.path.join(self.base, "agent", ".config", "vite-plus", "env")
        os.makedirs(os.path.join(self.repo, "kiosk"))
        os.makedirs(self.home)
        os.makedirs(self.state)
        os.makedirs(os.path.join(self.repo, "scripts", "env"))
        shutil.copy(SETUP, os.path.join(self.repo, "scripts", "env", "setup.sh"))
        write(os.path.join(self.base, "check"), FAKE_CHECK, 0o755)
        stubs, late = os.path.join(self.base, "bin"), os.path.join(self.base, "late")
        for name, body in STUBS.items():
            write(os.path.join(stubs, name), f'#!/bin/sh\necho "{name} $*" >> "$FAKE_LOG"\n{body}', 0o755)
        for name, body in LATE.items():
            write(os.path.join(late, name), f'#!/bin/sh\necho "{name} $*" >> "$FAKE_LOG"\n{body}', 0o755)
        self.env = {
            "PATH": f"{stubs}:/usr/bin:/bin",
            "HOME": self.home,
            "ENV_CHECK": os.path.join(self.base, "check"),
            "FAKE_STATE": self.state,
            "FAKE_LOG": self.log,
            "FAKE_LATE": late,
            "FAKE_LAYOUT": self.layout,
        }
        self.mark("checkout")

    def mark(self, *names):
        for name in names:
            write(os.path.join(self.state, name), "")

    def run_setup(self, *args, **env):
        if os.path.exists(self.log):
            os.remove(self.log)
        out = subprocess.run(
            ["bash", os.path.join(self.repo, "scripts", "env", "setup.sh"), *args],
            env={**self.env, **env}, capture_output=True, text=True, check=False,
        )
        calls = []
        if os.path.exists(self.log):
            with open(self.log, encoding="utf-8") as handle:
                calls = [line for line in handle.read().splitlines() if not line.startswith("check ")]
        return out.returncode, out.stderr, calls

    def tree(self):
        found = {}
        for directory in (self.home, self.state, self.repo, os.path.join(self.base, "agent")):
            for parent, _, files in os.walk(directory):
                for name in files:
                    path = os.path.join(parent, name)
                    with open(path, "rb") as handle:
                        found[path] = handle.read()
                found[parent] = None
        return found

    def test_converges_then_reruns_without_changes(self):
        code, err, calls = self.run_setup("--env", "cursor")
        self.assertEqual(code, 0, err)
        joined = "\n".join(calls)
        self.assertIn("apt-get install --no-install-recommends -y ca-certificates build-essential pkg-config", joined)
        self.assertIn("rustup toolchain install", calls)
        self.assertIn("VP_VERSION=9.8.7", calls)
        self.assertIn("vp env install", calls)
        self.assertIn("vp exec playwright install chromium", calls)
        self.assertNotIn("cargo", joined)
        with open(self.layout, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), f'. "{self.home}/.config/vite-plus/env"\n')
        with open(os.path.join(self.home, ".profile"), encoding="utf-8") as handle:
            profile = handle.read().splitlines()
        self.assertEqual(profile.count('. "$HOME/.cargo/env"'), 1)
        self.assertIn(f'. "{self.home}/.config/vite-plus/env"', profile)

        before = self.tree()
        code, err, calls = self.run_setup("--env", "cursor")
        self.assertEqual((code, calls), (0, []), err)
        self.assertIn("0 change(s)", err)
        self.assertEqual(self.tree(), before)

    def test_check_only_changes_nothing(self):
        before = self.tree()
        code, err, calls = self.run_setup("--env", "factory-console", "--check-only", "--prebuild")
        self.assertEqual((code, calls), (0, []), err)
        self.assertEqual(self.tree(), before)
        for plan in ("would install apt packages", "would install rustup", "would install Vite+ 9.8.7",
                     "would install Playwright Chromium", "would build the release"):
            self.assertIn(plan, err)

    def test_exempt_items_are_left_alone(self):
        code, err, calls = self.run_setup("--env", "orb")
        self.assertEqual(code, 0, err)
        self.assertNotIn("vp exec playwright install chromium", calls)
        self.assertFalse(os.path.exists(self.layout))

    def test_ci_skips_layout_profiles_and_playwright_and_exports_path(self):
        github_path = os.path.join(self.base, "github_path")
        code, err, calls = self.run_setup("--ci", GITHUB_PATH=github_path)
        self.assertEqual(code, 0, err)
        apt = next(c for c in calls if c.startswith("apt-get install"))
        self.assertNotIn("bubblewrap", apt)
        self.assertNotIn("vp exec playwright install chromium", calls)
        self.assertNotIn("vp install --frozen-lockfile", calls)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".bash_profile")))
        with open(github_path, encoding="utf-8") as handle:
            # Reversed, because each GITHUB_PATH line is prepended.
            self.assertEqual(handle.read().splitlines(), [f"{self.home}/.cargo/bin", f"{self.home}/vp/bin"])

        # Cursor still requires Playwright and the layout; --ci installs neither, so its check fails.
        code, err, calls = self.run_setup("--ci", "--env", "cursor", GITHUB_PATH=github_path)
        self.assertEqual(code, 1, err)
        self.assertNotIn("vp exec playwright install chromium", calls)
        self.assertFalse(os.path.exists(self.layout))

    def test_prebuild_builds_sandbox_binaries_and_kiosk(self):
        code, err, calls = self.run_setup("--env", "sandbox", "--prebuild")
        self.assertEqual(code, 0, err)
        build = next(c for c in calls if c.startswith("cargo "))
        self.assertIn("build", build)
        self.assertIn("--release --locked -p sandbox -p meter -p factory-api -p factory-ups-control", build)
        self.assertIn("vp build", calls)

    def test_unmeetable_item_fails(self):
        self.mark("bad-os")
        code, err, calls = self.run_setup("--env", "orb", "--check-only")
        self.assertEqual((code, calls), (1, []))
        self.assertIn("cannot install os", err)
        code, err, _ = self.run_setup("--env", "orb")
        self.assertEqual(code, 1, err)

    def test_apt_without_root_names_the_command(self):
        if os.geteuid() == 0:
            self.skipTest("root needs no sudo")
        self.mark("no-sudo", "apt-ca-certificates", *(f"apt-{p}" for p in PACKAGES if p != "shellcheck"))
        code, err, calls = self.run_setup("--env", "factory-gpu")
        self.assertEqual(code, 1)
        self.assertIn("sudo apt-get install --no-install-recommends -y shellcheck", err)
        self.assertFalse(any(c.startswith(("apt-get", "rustup", "vp")) for c in calls), calls)

    def test_usage_errors(self):
        self.assertEqual(self.run_setup()[0], 2)
        self.assertEqual(self.run_setup("--env", "nowhere")[0], 2)
        self.assertEqual(self.run_setup("--bogus")[0], 2)


if __name__ == "__main__":
    unittest.main()
