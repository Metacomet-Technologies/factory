#!/usr/bin/env python3
"""install-factory-api.sh --enroll-device and rollback-factory-api.sh --unenroll-device
against a fake root. Tokens are synthetic; every run asserts none appears in output."""

import hashlib
import os
import pathlib
import re
import subprocess
import tempfile
import unittest

here = pathlib.Path(__file__).resolve().parent
A = "fdv1_" + "A" * 43
B = "fdv1_" + "B" * 42 + "-"
C = "fdv1_" + "C" * 42 + "_"


def sha(token):
    return hashlib.sha256(token.encode()).hexdigest()


class EnrollTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0, "Run fake-root tests unprivileged")
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.file = self.root / "etc/factory-api/device-tokens"
        self.env = {**os.environ, "FACTORY_API_TEST_ROOT": str(self.root)}

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, script, *args, stdin="", ok=True):
        result = subprocess.run(["bash", str(here / script), *args], input=stdin, env=self.env,
                                capture_output=True, text=True, timeout=30)
        output = result.stdout + result.stderr
        for secret in (A, B, C, A[5:], B[5:], C[5:]):
            self.assertNotIn(secret, output)
        for token in (A, B, C):
            self.assertNotIn(sha(token), output)
        self.assertEqual(result.returncode == 0, ok, output)
        return output

    def enroll(self, token, *extra, ok=True, device="factory-console"):
        return self.run_script("install-factory-api.sh", "--enroll-device", device, *extra, stdin=token + "\n", ok=ok)

    def snapshot(self, output):
        return re.search(r"--unenroll-device (\S+)$", output, re.M).group(1)

    def lines(self):
        return self.file.read_text().splitlines()

    def test_enroll_is_idempotent_capped_and_rollback_removes_only_its_line(self):
        first = self.enroll(A, "--label", "console-2026")
        self.assertEqual(self.lines(), [f"factory-console {sha(A)} console-2026"])
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.file.parent.stat().st_mode & 0o777, 0o750)
        self.assertIn("no restart", first)

        again = self.enroll(A)
        self.assertIn("Already enrolled", again)
        self.assertEqual(self.lines(), [f"factory-console {sha(A)} console-2026"])
        self.assertEqual(len(list((self.root / "var/backups/factory-api").iterdir())), 1)

        second = self.enroll(B)
        self.assertEqual(len(self.lines()), 2)
        self.assertTrue(self.lines()[1].startswith(f"factory-console {sha(B)} enrolled-"))
        refused = self.enroll(C, ok=False)
        self.assertIn("already has two credentials", refused)
        self.assertEqual(len(self.lines()), 2)
        self.enroll(B, ok=False, device="factory-other")
        self.assertEqual(len(self.lines()), 2)

        # Another device's line and a comment survive both rollbacks.
        self.file.write_text(self.file.read_text() + "# keep me\n")
        self.enroll(C, device="factory-other")
        first_line, second_line, comment, other = self.lines()
        self.assertEqual(comment, "# keep me")
        self.assertTrue(other.startswith(f"factory-other {sha(C)} "))
        self.assertIn("Removed only the enrolled line", self.run_script("rollback-factory-api.sh", "--unenroll-device", self.snapshot(second)))
        self.assertEqual(self.lines(), [first_line, comment, other])
        self.assertIn("already absent", self.run_script("rollback-factory-api.sh", "--unenroll-device", self.snapshot(second)))
        self.assertEqual(self.lines(), [first_line, comment, other])
        self.run_script("rollback-factory-api.sh", "--unenroll-device", self.snapshot(first))
        self.assertEqual(self.lines(), [comment, other])
        self.assertNotIn(second_line, self.file.read_text())
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o640)

    def test_rollback_of_the_first_enrollment_restores_absence(self):
        output = self.enroll(A)
        self.run_script("rollback-factory-api.sh", "--unenroll-device", self.snapshot(output))
        self.assertFalse(self.file.exists())
        self.assertFalse(self.file.parent.exists())

    def test_refusals_change_nothing(self):
        for token in ("", "fdv1_short", "xoxb-1234567890-abcdefghij", A + "x"):
            self.enroll(token, ok=False)
        self.assertFalse(self.file.exists())
        for device in ("factory-gpu", "fs", "Bad_Id"):
            self.enroll(A, ok=False, device=device)
        # The token never goes in argv.
        self.run_script("install-factory-api.sh", "--enroll-device", "factory-console", A, stdin="", ok=False)
        self.enroll(A, "--label", "has space", ok=False)
        self.assertFalse(self.file.exists())
        self.file.parent.mkdir(parents=True)
        self.file.symlink_to(self.root / "elsewhere")
        self.enroll(A, ok=False)
        self.assertFalse((self.root / "elsewhere").exists())


if __name__ == "__main__":
    unittest.main()
