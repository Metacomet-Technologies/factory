#!/usr/bin/env python3
"""Tests for scripts/env/check against stubbed commands and a fixture host tree."""

import json
import os
import re
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
        engines = json.load(handle)["devEngines"]
    return {
        "rust": rust,
        "node": engines["runtime"]["version"],
        "pnpm": engines["packageManager"]["version"],
        "vp": "1.1.0",
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
        os.makedirs(os.path.join(self.browsers, "chromium-1248"))
        os.makedirs(self.home)
        self.outputs = fixture_outputs()

    def run_check(self, env_name):
        stubs = {}
        for command, text in self.outputs.items():
            name, _, sub = command.partition(" ")
            stubs.setdefault(name, {})[sub] = text
        for name, by_sub in stubs.items():
            cases = "".join(f"  {sub or '*'}) printf '%s\\n' '{text}' ;;\n" for sub, text in by_sub.items())
            if "" not in by_sub:
                cases += "  *) exit 1 ;;\n"
            write(os.path.join(self.bin, name), f'#!/bin/sh\ncase "$1" in\n{cases}esac\n', 0o755)
        env = {
            "PATH": self.bin,
            "HOME": self.home,
            "PLAYWRIGHT_BROWSERS_PATH": self.browsers,
            "FACTORY_TEST_TOKEN": SENTINEL,
        }
        out = subprocess.run(
            [sys.executable, CHECK, "--env", env_name, "--root", self.root],
            env=env, capture_output=True, text=True, check=False,
        )
        self.assertNotIn(SENTINEL, out.stdout + out.stderr)
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
        self.assertEqual(items["node"]["actual"], "v24.21.0")
        self.assertTrue(items["rust"]["ok"])

    def test_missing_shellcheck_fails(self):
        del self.outputs["shellcheck"]
        code, _, items = self.run_check("ci")
        self.assertEqual(code, 1)
        self.assertFalse(items["shellcheck"]["ok"])
        self.assertIsNone(items["shellcheck"]["actual"])

    def test_missing_playwright_fails_only_where_required(self):
        os.rmdir(os.path.join(self.browsers, "chromium-1248"))
        code, _, items = self.run_check("factory-console")
        self.assertEqual(code, 1)
        self.assertFalse(items["playwright"]["ok"])
        self.assertTrue(items["playwright"]["required"])

        code, report, items = self.run_check("ci")
        self.assertEqual(code, 0)
        self.assertTrue(report["ok"])
        self.assertFalse(items["playwright"]["ok"])
        self.assertFalse(items["playwright"]["required"])

    def test_unknown_env_is_a_usage_error(self):
        out = subprocess.run(
            [sys.executable, CHECK, "--env", "nowhere"], capture_output=True, text=True, check=False
        )
        self.assertEqual(out.returncode, 2)


if __name__ == "__main__":
    unittest.main()
