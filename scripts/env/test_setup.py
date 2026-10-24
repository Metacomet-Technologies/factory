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
import re
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
items += [(name, "24.22.1", have("js")) for name in ("node", "node:repo-root")]
# Bun resolves like the real checker: whichever `bun` PATH finds in kiosk/, and its version.
import shutil, subprocess
bun = shutil.which("bun")
version = subprocess.run([bun, "--version"], cwd=os.environ["FAKE_KIOSK"], capture_output=True,
                         text=True).stdout.strip() if bun else ""
items.append(("bun", "1.4.2", version == "1.4.2"))
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
  *vite.plus*) echo '. "$FAKE_LATE/vite-install"' ;;
  *) exit 22 ;;
esac
""",
    "cargo": "",
}
LATE = {
    # Shaped like the real Vite+ install: shims in vp/bin (prepended to PATH) or,
    # for a tool the host already has, in vp/fallback-bin (appended, so the host's wins).
    "vite-install": r"""echo "VP_VERSION=$VP_VERSION" >> "$FAKE_LOG"
vp="$HOME/vp"
mkdir -p "$HOME/.config/vite-plus" "$vp/bin" "$vp/fallback-bin"
cp "$FAKE_LATE/vp" "$vp/bin/"
if command -v bun >/dev/null; then shims="$vp/fallback-bin"; else shims="$vp/bin"; fi
printf '#!/bin/sh\nexec "%s/pm/bun" "$@"\n' "$vp" > "$shims/bun"
chmod +x "$shims/bun"
printf 'export PATH="%s/bin:$PATH:%s/fallback-bin"\n' "$vp" "$vp" > "$HOME/.config/vite-plus/env"
: > "$FAKE_STATE/vite-plus"
""",
    "rustup": 'if [ "$*" = "toolchain install" ]; then : > "$FAKE_STATE/rust"; fi\n',
    "vp": """case "$*" in
  "env on bun") if [ -e "$HOME/vp/fallback-bin/bun" ]; then mv "$HOME/vp/fallback-bin/bun" "$HOME/vp/bin/bun"; fi ;;
  "env install")
    mkdir -p "$HOME/vp/pm" && printf '#!/bin/sh\necho 1.4.2\n' > "$HOME/vp/pm/bun" && chmod +x "$HOME/vp/pm/bun"
    : > "$FAKE_STATE/js" ;;
  "install --frozen-lockfile") mkdir -p node_modules ;;
  "exec playwright install chromium") : > "$FAKE_STATE/playwright" ;;
esac
""",
}


def actions(err):
    """(planned or done, action) for each change setup announced."""
    found = []
    for line in err.splitlines():
        match = re.match(r"\[setup \d+s\] (would )?(install|add|write|build)\b(.*)", line)
        if match:
            found.append((bool(match.group(1)), match.group(2) + match.group(3)))
    return found


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
            "FAKE_KIOSK": os.path.join(self.repo, "kiosk"),
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
        code, err, calls = self.run_setup("--env", "factory-gpu")
        self.assertEqual(code, 0, err)
        joined = "\n".join(calls)
        self.assertIn("apt-get install --no-install-recommends -y ca-certificates build-essential pkg-config", joined)
        self.assertIn("rustup toolchain install", calls)
        self.assertIn("VP_VERSION=9.8.7", calls)
        self.assertIn("vp env install", calls)
        self.assertLess(calls.index("vp env on bun"), calls.index("vp env install"))
        self.assertIn("vp env on node", calls)
        self.assertIn("vp exec playwright install chromium", calls)
        self.assertNotIn("cargo", joined)
        with open(self.layout, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), f'. "{self.home}/.config/vite-plus/env"\n')
        with open(os.path.join(self.home, ".profile"), encoding="utf-8") as handle:
            profile = handle.read().splitlines()
        self.assertEqual(profile.count('. "$HOME/.cargo/env"'), 1)
        self.assertIn(f'. "{self.home}/.config/vite-plus/env"', profile)

        before = self.tree()
        code, err, calls = self.run_setup("--env", "factory-gpu")
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

    def test_plan_names_every_effect_of_the_install(self):
        self.mark(*(f"apt-{p}" for p in PACKAGES))
        before = self.tree()
        code, err, calls = self.run_setup("--env", "orb", "--check-only")
        self.assertEqual((code, calls), (0, []), err)
        self.assertEqual(self.tree(), before, "the dry run wrote something")
        plan = actions(err)
        self.assertTrue(plan and all(planned for planned, _ in plan), err)
        plan = {action for _, action in plan}
        profile = os.path.join(self.home, ".profile")
        self.assertIn(f'add . "$HOME/.cargo/env" to {profile}', plan)
        self.assertIn(f'add . "{self.home}/.config/vite-plus/env" to {profile}', plan)

        code, err, _ = self.run_setup("--env", "orb")
        self.assertEqual(code, 0, err)
        done = actions(err)
        self.assertFalse(any(planned for planned, _ in done), err)
        # Everything the install did was planned ...
        self.assertLessEqual({action for _, action in done}, plan)
        # ... and every planned profile line is persisted, whether setup or an installer wrote it.
        with open(profile, encoding="utf-8") as handle:
            lines = set(handle.read().splitlines())
        for action in plan:
            if action.startswith("add "):
                line, _, path = action[len("add "):].rpartition(" to ")
                self.assertEqual(path, profile)
                self.assertIn(line, lines)
        added = {line for line in lines if line.startswith(". ")}
        self.assertEqual({f"add {line} to {profile}" for line in added}, {a for a in plan if a.startswith("add ")})
        self.assertEqual(self.run_setup("--env", "orb", "--check-only")[1].count("would "), 0)

    def test_existing_vite_plus_with_older_system_bun_converges(self):
        # The orb image: its own bun 1.3.10 on PATH, then a Vite+ install that saw it
        # and left the bun shim in fallback-bin, behind the system one.
        system = os.path.join(self.base, "system")
        write(os.path.join(system, "bun"), "#!/bin/sh\necho 1.3.10\n", 0o755)
        self.env["PATH"] = self.env["PATH"].replace(":/usr/bin", f":{system}:/usr/bin")
        self.mark(*(f"apt-{p}" for p in PACKAGES), "rust", "js")
        subprocess.run(["bash", "-c", "curl -fsSL https://vite.plus | bash"], env=self.env, check=True)
        self.assertTrue(os.path.exists(os.path.join(self.home, "vp", "fallback-bin", "bun")))
        with open(os.path.join(self.home, ".profile"), "w", encoding="utf-8") as handle:
            handle.write(f'export PATH="{system}:$PATH"\n. "{self.home}/.config/vite-plus/env"\n')

        def login_bun():
            return subprocess.run(
                ["env", "-i", f"HOME={self.home}", "bash", "-lc", "cd kiosk && bun --version"],
                cwd=self.repo, capture_output=True, text=True, check=False,
            ).stdout.strip()

        self.assertEqual(login_bun(), "1.3.10")
        before = self.tree()
        code, err, calls = self.run_setup("--env", "orb", "--check-only")
        self.assertEqual((code, calls), (0, []), err)
        self.assertEqual(self.tree(), before)
        self.assertIn("would let Vite+ manage bun (vp env on)", err)

        code, err, calls = self.run_setup("--env", "orb")
        self.assertEqual(code, 0, err)  # the final check resolves bun the way setup left PATH
        self.assertEqual(calls[:2], ["vp env on bun", "vp env install"])
        self.assertEqual(login_bun(), "1.4.2")
        with open(os.path.join(system, "bun"), encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "#!/bin/sh\necho 1.3.10\n")

        before = self.tree()
        code, err, calls = self.run_setup("--env", "orb")
        self.assertEqual((code, calls), (0, []), err)
        self.assertEqual(self.tree(), before)

    def test_bare_entry_points_apply_the_full_contract(self):
        before = self.tree()
        code, err, calls = self.run_setup("--check-only")
        self.assertEqual((code, calls), (0, []), err)
        self.assertEqual(self.tree(), before)
        self.assertIn("would install Playwright Chromium", err)
        self.assertIn(f"would write {self.layout}", err)

        code, err, calls = self.run_setup("--prebuild")
        self.assertEqual(code, 0, err)
        self.assertIn("vp exec playwright install chromium", calls)
        self.assertTrue(os.path.isfile(self.layout))
        self.assertTrue(any(c.startswith("cargo build") for c in calls), calls)
        self.assertIn("vp build", calls)

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

        # factory-gpu still requires Playwright and the layout; --ci installs neither, so its check fails.
        code, err, calls = self.run_setup("--ci", "--env", "factory-gpu", GITHUB_PATH=github_path)
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
        self.assertEqual(self.run_setup("--env")[0], 2)
        self.assertEqual(self.run_setup("--env", "nowhere")[0], 2)
        self.assertEqual(self.run_setup("--bogus")[0], 2)


if __name__ == "__main__":
    unittest.main()
