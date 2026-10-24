#!/usr/bin/env python3
"""Tests for deploy/lint-installers.sh. Lints fixtures and the inventory; runs nothing it lints."""

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent
LINT = DEPLOY / "lint-installers.sh"
FIXTURES = DEPLOY / "testdata" / "lint-installers"
CHECKS = ["strict", "root", "preflight", "trap", "snapshot", "health", "rollback"]
EXPECTED_FAILURE = {
    "install-good.sh": None,
    "install-good-oneshot.sh": None,
    "rollback-good.sh": None,
    "install-no-strict.sh": "strict",
    "install-no-root.sh": "root",
    "install-late-root.sh": "root",
    "install-no-preflight.sh": "preflight",
    "install-no-trap.sh": "trap",
    "install-no-snapshot.sh": "snapshot",
    "install-no-health.sh": "health",
    "install-no-health-oneshot.sh": "health",
    "install-no-rollback.sh": "rollback",
    "rollback-no-snapshot.sh": "snapshot",
    "rollback-unnamed.sh": "rollback",
}


def run(lint, *paths):
    result = subprocess.run(["bash", str(lint), *map(str, paths)], capture_output=True, text=True, check=False)
    rows = {}
    for line in result.stdout.splitlines():
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) == len(CHECKS) + 1 and cells[0] not in ("Script", "---"):
            rows[cells[0]] = dict(zip(CHECKS, cells[1:]))
    return result, rows


class FixtureTest(unittest.TestCase):
    def test_every_fixture_is_covered(self):
        self.assertEqual(sorted(p.name for p in FIXTURES.glob("*.sh")), sorted(EXPECTED_FAILURE))
        self.assertEqual({c for c in EXPECTED_FAILURE.values() if c}, set(CHECKS))

    def test_each_fixture_fails_only_its_check(self):
        for name, check in EXPECTED_FAILURE.items():
            with self.subTest(name):
                result, rows = run(LINT, FIXTURES / name)
                self.assertEqual(len(rows), 1, result.stdout + result.stderr)
                expected = {c: "FAIL" if c == check else "pass" for c in CHECKS}
                self.assertEqual(next(iter(rows.values())), expected, result.stderr)
                self.assertEqual(result.returncode, 1 if check else 0, result.stderr)


class InventoryTest(unittest.TestCase):
    def test_inventory_passes_with_reasoned_exemptions(self):
        inventory = sorted(
            str(p.relative_to(DEPLOY.parent))
            for pattern in ("install-*.sh", "*/install-*.sh", "rollback-*.sh", "*/rollback-*.sh")
            for p in DEPLOY.glob(pattern)
        )
        result, rows = run(LINT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sorted(rows), inventory)
        cells = {cell for row in rows.values() for cell in row.values()}
        self.assertLessEqual(cells, {"pass", "exempt", "TODO"})
        for line in result.stdout.split("Exemptions:", 1)[1].splitlines()[1:]:
            reason = line.split(": ", 1)[1]
            self.assertTrue(reason.startswith("TODO MET-<new>: ") or not reason.startswith("TODO"), line)

    def test_stale_and_unknown_exemptions_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            deploy = Path(directory) / "deploy"
            deploy.mkdir()
            for name in ("install-good.sh", "rollback-good.sh", "lint-demo.service"):
                shutil.copy(FIXTURES / name, deploy / name)
            text = re.sub(
                r"^exemptions=\(\n.*?^\)$",
                "exemptions=(\n    'deploy/install-good.sh|health|Passes, so this is stale.'\n"
                "    'deploy/install-gone.sh|root|No such script.'\n)",
                LINT.read_text(), count=1, flags=re.M | re.S,
            )
            (deploy / LINT.name).write_text(text)
            result, rows = run(deploy / LINT.name)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(rows["deploy/install-good.sh"]["health"], "STALE")
        self.assertIn("STALE deploy/install-good.sh health", result.stderr)
        self.assertIn("INVALID exemption deploy/install-gone.sh|root", result.stderr)


if __name__ == "__main__":
    unittest.main()
