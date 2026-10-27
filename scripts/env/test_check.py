#!/usr/bin/env python3
"""Tests for scripts/env/check against stubbed commands and a fixture host tree."""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.realpath(os.path.join(HERE, "..", ".."))
CHECK = os.path.join(HERE, "check")
SENTINEL = "env-check-sentinel-7f3a"


def repo_pins():
    with open(os.path.join(REPO, "rust-toolchain.toml"), encoding="utf-8") as handle:
        rust = re.search(r'channel\s*=\s*"([^"]+)"', handle.read()).group(1)
    with open(os.path.join(REPO, "kiosk", "package.json"), encoding="utf-8") as handle:
        package = json.load(handle)
    engines = package["devEngines"]
    return {
        "rust": rust,
        "node": engines["runtime"]["version"],
        "bun": engines["packageManager"]["version"],
        "vp": package["catalog"]["vite-plus"],
    }


def fixture_outputs():
    with open(os.path.join(HERE, "fixtures", "commands.json"), encoding="utf-8") as handle:
        outputs = json.load(handle)
    pins = repo_pins()
    return {command: text.format(**pins) for command, text in outputs.items()}


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(path, mode)


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = self.tmp.name
        self.bin = os.path.join(base, "bin")
        self.root = os.path.join(base, "root")
        self.browsers = os.path.join(base, "browsers")
        self.home = os.path.join(base, "home")
        write(os.path.join(self.root, "etc/os-release"), 'ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 26.04.1 LTS"\n')
        write(os.path.join(self.root, "etc/ssl/certs/ca-certificates.crt"), "")
        write(os.path.join(self.root, "home/agent/work/factory/kiosk/package.json"), "{}")
        write(os.path.join(self.root, "home/agent/.config/vite-plus/env"), "")
        self.install_chromium(self.browsers)
        os.makedirs(self.home, exist_ok=True)
        self.outputs = fixture_outputs()
        self.env = {"PLAYWRIGHT_BROWSERS_PATH": self.browsers}
        modules = os.path.join(base, "tools", "node_modules")
        self.link(self.package(os.path.join(modules, "vite-plus"), "vite-plus", repo_pins()["vp"], "vp"), "vp")

    def package(self, directory, name, version, binary):
        """An npm-style package with a launcher; the checker reads only its manifest."""
        write(os.path.join(directory, "package.json"), json.dumps({"name": name, "version": version}))
        launcher = os.path.join(directory, "bin", binary)
        write(launcher, "#!/bin/sh\nexit 1\n", 0o755)
        return launcher

    def link(self, target, tool):
        os.makedirs(self.bin, exist_ok=True)
        if os.path.lexists(os.path.join(self.bin, tool)):
            os.remove(os.path.join(self.bin, tool))
        os.symlink(target, os.path.join(self.bin, tool))

    def install_chromium(self, base):
        write(os.path.join(base, "chromium-1248", "INSTALLATION_COMPLETE"), "")
        write(os.path.join(base, "chromium-1248", "chrome-linux64", "chrome"), "#!/bin/sh\n", 0o755)

    def vite_plus_shims(self, installed):
        """Replace node/bun/vp with Vite+ 1.1.0-style shims: links to one `vp` binary.

        Running a shim as node/bun records a mutation; `vp env current --json`
        reports the pinned runtime and package manager like the real CLI.
        """
        pins = repo_pins()
        del self.outputs["node"]
        del self.outputs["bun"]
        home = os.path.join(self.tmp.name, "vp-home")
        runtime = os.path.join(home, "js_runtime", "node", pins["node"], "bin", "node")
        manager = os.path.join(home, "package_manager", "bun", pins["bun"], "bun", "bin", "bun")
        if installed:
            write(runtime, f"#!/bin/sh\nprintf 'v{pins['node']}\\n'\n", 0o755)
            write(manager, f"#!/bin/sh\nprintf '{pins['bun']}\\n'\n", 0o755)
        current = {
            "node": {"version": pins["node"], "bin_path": runtime, "installed": installed, "mode": "managed"},
            "package_manager": {
                "name": "bun", "version": pins["bun"], "bin_paths": {"bun": manager},
                "installed": installed, "mode": "managed",
            },
        }
        self.mutated = os.path.join(self.tmp.name, "shim-ran")
        write(os.path.join(home, pins["vp"], "package.json"), json.dumps({"name": "vp-global", "version": pins["vp"]}))
        os.symlink(pins["vp"], os.path.join(home, "current"))
        vp = os.path.join(home, pins["vp"], "bin", "vp")
        write(vp, f"""#!/bin/sh
# Only shell builtins: PATH holds nothing but these stubs.
case "${{0##*/}} $*" in
  "vp env current --json") printf '%s\\n' '{json.dumps(current)}' ;;
  "vp --version") printf 'vp v{pins['vp']}\\n' ;;
  *) : > '{self.mutated}'; printf 'v0.0.1\\n' ;;
esac
""", 0o755)
        for tool in ("node", "bun", "vp"):
            self.link(os.path.join(home, "current", "bin", "vp"), tool)

    def run_check(self, env_name, *extra):
        stubs = {}
        for command, text in self.outputs.items():
            name, _, sub = command.partition(" ")
            stubs.setdefault(name, {})[sub] = text
        for name, by_sub in stubs.items():
            cases = "".join(f"  {sub or '*'}) printf '%s\\n' '{text}' ;;\n" for sub, text in by_sub.items())
            if "" not in by_sub:
                cases += "  *) exit 1 ;;\n"
            write(os.path.join(self.bin, name), f'#!/bin/sh\ncase "$1" in\n{cases}esac\n', 0o755)
        env = {"PATH": self.bin, "HOME": self.home, "FACTORY_TEST_TOKEN": SENTINEL, **self.env}
        out = subprocess.run(
            [sys.executable, CHECK, "--env", env_name, "--root", self.root, *extra],
            env=env, capture_output=True, text=True, check=False,
        )
        self.assertNotIn(SENTINEL, out.stdout + out.stderr)
        if extra:
            return out.returncode, out.stdout
        report = json.loads(out.stdout)
        self.assertEqual(report["env"], env_name)
        return out.returncode, report, {item["name"]: item for item in report["items"]}

    def test_everything_matches(self):
        code, report, items = self.run_check("factory-console")
        self.assertEqual(code, 0, [i for i in items.values() if not i["ok"]])
        self.assertTrue(report["ok"])
        self.assertTrue(all(item["ok"] and item["required"] for item in items.values()))
        for item in items.values():
            self.assertEqual(set(item), {"name", "expected", "actual", "ok", "required"})

    def test_rust_mismatch_fails(self):
        self.outputs["rustc"] = "rustc 1.98.0 (aaaaaaaaa 2026-08-01)"
        code, report, items = self.run_check("factory-gpu")
        self.assertEqual(code, 1)
        self.assertFalse(report["ok"])
        self.assertFalse(items["rust"]["ok"])
        self.assertEqual(items["rust"]["expected"], repo_pins()["rust"])
        self.assertTrue(items["node"]["ok"])

    def test_node_mismatch_fails(self):
        self.outputs["node"] = "v24.21.0"
        code, _, items = self.run_check("orb")
        self.assertEqual(code, 1)
        self.assertFalse(items["node"]["ok"])
        self.assertTrue(items["node"]["actual"].startswith("v24.21.0 ("))
        self.assertTrue(items["rust"]["ok"])

    def test_bun_mismatch_fails(self):
        self.outputs["bun"] = "1.4.3"
        code, _, items = self.run_check("ci")
        self.assertEqual(code, 1)
        self.assertFalse(items["bun"]["ok"])
        self.assertTrue(items["bun"]["actual"].startswith("1.4.3 ("))
        self.assertEqual(items["bun"]["expected"], repo_pins()["bun"])

    def test_missing_bun_fails(self):
        del self.outputs["bun"]
        code, _, items = self.run_check("orb")
        self.assertEqual(code, 1)
        self.assertFalse(items["bun"]["ok"])
        self.assertIsNone(items["bun"]["actual"])

    def test_missing_shellcheck_fails(self):
        del self.outputs["shellcheck"]
        code, _, items = self.run_check("ci")
        self.assertEqual(code, 1)
        self.assertFalse(items["shellcheck"]["ok"])
        self.assertIsNone(items["shellcheck"]["actual"])

    def test_release_linker_is_required_everywhere(self):
        code, _, items = self.run_check("orb")
        self.assertEqual(code, 0, [i for i in items.values() if not i["ok"]])
        self.assertEqual((items["lld"]["expected"], items["lld"]["actual"]),
                         ("ld.lld on PATH", os.path.join(self.bin, "ld.lld")))
        del self.outputs["ld.lld"]
        os.remove(os.path.join(self.bin, "ld.lld"))
        for env_name in ("orb", "sandbox", "ci", "factory-gpu", "factory-console"):
            code, report, items = self.run_check(env_name)
            self.assertEqual(code, 1, env_name)
            self.assertFalse(report["ok"], env_name)
            self.assertEqual((items["lld"]["ok"], items["lld"]["required"], items["lld"]["actual"]),
                             (False, True, None), env_name)
        self.assertEqual(self.run_check("orb", "--failing"), (1, "lld\tld.lld on PATH\tNone\n"))

    def test_vite_plus_shims_resolve_the_pin_without_running(self):
        self.vite_plus_shims(installed=True)
        code, _, items = self.run_check("factory-gpu")
        self.assertEqual(code, 0, [i for i in items.values() if not i["ok"]])
        self.assertIn("js_runtime/node", items["node"]["actual"])
        self.assertIn("package_manager/bun", items["bun"]["actual"])
        self.assertFalse(os.path.exists(self.mutated), "a Vite+ shim ran")

    def test_vite_plus_missing_pins_fail_without_installing(self):
        self.vite_plus_shims(installed=False)
        code, _, items = self.run_check("ci")
        self.assertEqual(code, 1)
        for name in ("node", "node:repo-root", "bun"):
            self.assertFalse(items[name]["ok"], name)
            self.assertIn("not installed", items[name]["actual"])
        self.assertFalse(os.path.exists(self.mutated), "a Vite+ shim ran")

    def test_playwright_in_default_cache_counts(self):
        del self.env["PLAYWRIGHT_BROWSERS_PATH"]
        self.install_chromium(os.path.join(self.home, ".cache", "ms-playwright"))
        code, _, items = self.run_check("factory-gpu")
        self.assertEqual(code, 0)
        self.assertIn("chromium-1248/chrome-linux64/chrome", items["playwright"]["actual"])

    def test_playwright_without_a_chromium_executable_fails(self):
        chromium = os.path.join(self.browsers, "chromium-1248")
        for broken in ("empty directory", "regular file", "not executable"):
            shutil.rmtree(chromium, ignore_errors=True)
            if os.path.isfile(chromium):
                os.remove(chromium)
            if broken == "empty directory":
                os.makedirs(chromium)
            elif broken == "regular file":
                write(chromium, "")
            else:
                self.install_chromium(self.browsers)
                os.chmod(os.path.join(chromium, "chrome-linux64", "chrome"), 0o644)
            for env_name in ("factory-console", "factory-gpu"):
                code, _, items = self.run_check(env_name)
                self.assertEqual(code, 1, (broken, env_name))
                self.assertFalse(items["playwright"]["ok"], (broken, env_name))

    def test_missing_explicit_browsers_path_is_not_rescued(self):
        self.env["PLAYWRIGHT_BROWSERS_PATH"] = os.path.join(self.tmp.name, "absent")
        self.install_chromium(os.path.join(self.home, ".cache", "ms-playwright"))
        code, _, items = self.run_check("factory-console")
        self.assertEqual(code, 1)
        self.assertFalse(items["playwright"]["ok"])

    def test_missing_playwright_fails_only_where_required(self):
        shutil.rmtree(os.path.join(self.browsers, "chromium-1248"))
        code, _, items = self.run_check("factory-console")
        self.assertEqual(code, 1)
        self.assertFalse(items["playwright"]["ok"])
        self.assertTrue(items["playwright"]["required"])

        code, report, items = self.run_check("ci")
        self.assertEqual(code, 0)
        self.assertTrue(report["ok"])
        self.assertFalse(items["playwright"]["ok"])
        self.assertFalse(items["playwright"]["required"])

    def test_failing_lists_only_failing_required_items(self):
        self.outputs["rustc"] = "rustc 1.98.0 (aaaaaaaaa 2026-08-01)"
        del self.outputs["shellcheck"]
        shutil.rmtree(os.path.join(self.browsers, "chromium-1248"))
        code, out = self.run_check("orb", "--failing")
        self.assertEqual(code, 1)
        self.assertEqual(
            out.splitlines(),
            [f"rust\t{repo_pins()['rust']}\trustc 1.98.0 (aaaaaaaaa 2026-08-01)", "shellcheck\tshellcheck on PATH\tNone"],
        )
        self.outputs["rustc"] = f"rustc {repo_pins()['rust']} (b940084d7 2026-09-28)"
        self.outputs["shellcheck"] = ""
        self.assertEqual(self.run_check("orb", "--failing"), (0, ""))

    def test_unknown_env_is_a_usage_error(self):
        out = subprocess.run(
            [sys.executable, CHECK, "--env", "nowhere"], capture_output=True, text=True, check=False
        )
        self.assertEqual(out.returncode, 2)


if __name__ == "__main__":
    unittest.main()
