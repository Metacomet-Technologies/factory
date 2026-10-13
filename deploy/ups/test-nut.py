#!/usr/bin/env python3
"""Exercise the real installers without root, packages, USB or systemd."""
import os
import pathlib
import shlex
import stat
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
NAMES = ("nut.conf", "ups.conf", "upsd.conf", "upsd.users", "upsmon.conf")
STUB = '''#!/usr/bin/env python3
import os, pathlib, subprocess, sys
root = pathlib.Path(os.environ["NUT_TEST_ROOT"])
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with (root.parent / "calls").open("a") as log:
    log.write(name + " " + " ".join(args) + "\\n")
if name == "dpkg-query":
    print("install ok installed" if (root / ".installed").exists() else "unknown")
elif name == "getent":
    print("nut:x:999:")
elif name == "apt-get":
    assert args == ["install", "-y", "nut"]
    snapshots = list((root / "var/backups").glob("nut-*/complete"))
    assert snapshots, "config changed without a complete snapshot"
    for config in ("nut.conf", "ups.conf", "upsd.conf", "upsd.users", "upsmon.conf"):
        assert (root / "etc/nut" / config).is_file(), "package installed before config"
    (root / ".installed").touch()
elif name == "install":
    filtered = []
    while args:
        arg = args.pop(0)
        if arg in ("-o", "-g"):
            args.pop(0)
        else:
            filtered.append(arg)
    sys.exit(subprocess.call(["/usr/bin/install", *filtered]))
elif name == "openssl":
    sys.exit(subprocess.call(["/usr/bin/openssl", *args]))
elif name == "upsc":
    assert args == ["cyberpower@localhost", "ups.status"]
    print(os.environ.get("UPS_STATUS", "OL"))
elif name == "journalctl":
    assert args[:5] == ["-u", "nut-server", "--no-pager", "-o", "cat"]
    print("User upsmon@127.0.0.1 logged into UPS [cyberpower]")
elif name == "systemctl":
    assert args[0] in ("restart", "stop") and args[1] in ("nut-server", "nut-monitor")
    if os.environ.get("FAIL_RESTART") and args[0] == "restart":
        sys.exit(1)
elif name == "udevadm":
    assert args in (["control", "--reload-rules"], ["trigger", "--subsystem-match=usb", "--attr-match=idVendor=0764", "--action=add"], ["settle"])
elif name not in ("chown", "groupadd"):
    sys.exit("Unexpected stub command")
'''


def tree(path):
    """Bytes, permissions and timestamps: dry-run must not even rewrite a file."""
    return {
        str(p.relative_to(path)): (
            p.read_bytes() if p.is_file() else None,
            stat.S_IMODE(p.stat().st_mode), p.stat().st_mtime_ns,
        ) for p in path.rglob("*")
    }


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0, "Run fake-root tests unprivileged")
        scratch = HERE.parents[1] / ".amp/in"
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.base = pathlib.Path(self.tmp.name)
        self.root = self.base / "root"
        self.live = self.root / "etc/nut"
        self.live.mkdir(parents=True)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name in ("apt-get", "dpkg-query", "systemctl", "udevadm", "upsc", "journalctl", "getent", "groupadd", "install", "chown", "openssl"):
            path = self.bin / name
            path.write_text(STUB)
            path.chmod(0o755)
        self.env = {**os.environ, "NUT_TEST_ROOT": str(self.root), "PATH": f"{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONDONTWRITEBYTECODE": "1"}

    def run_script(self, script="install-nut.sh", args=(), success=True):
        result = subprocess.run(["bash", str(HERE / script), *args], env=self.env, text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def calls(self):
        path = self.base / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def credentials(self):
        users = shlex.split((self.live / "upsd.users").read_text(), comments=True)
        password = users[users.index("password") + 2]
        monitor = shlex.split((self.live / "upsmon.conf").read_text(), comments=True)
        self.assertEqual(monitor[4], password)
        return password

    def test_reuse_dry_rerun_and_rollback(self):
        secret = 'fixture # spaces = quote" backslash\\'
        quoted = '"' + secret.replace("\\", "\\\\").replace('"', '\\"') + '"'
        (self.live / "upsd.users").write_text(f"[other]\npassword = other-fixture\n[upsmon]\npassword={quoted}\nupsmon primary\n")
        (self.live / "upsmon.conf").write_text(f"MONITOR cyberpower@localhost 1 upsmon {quoted} primary\nFINALDELAY 9\n")
        (self.live / "upssched.conf").write_bytes(b"# stock sample\n\x00")
        (self.live / "extra").write_bytes(b"preserve me\n")
        original = tree(self.live)
        before = tree(self.root)
        output = self.run_script(args=("--dry-run",))
        self.assertNotIn(secret, output)
        self.assertNotIn("other-fixture", output)
        self.assertIn("<masked>", output)
        self.assertIn("-FINALDELAY 9", output)
        self.assertEqual(before, tree(self.root))
        self.assertEqual(self.calls(), [])
        output = self.run_script()
        self.assertNotIn(secret, output)
        self.assertEqual(self.credentials(), secret)
        self.assertFalse(any(c.startswith("openssl") for c in self.calls()))
        snapshots = list((self.root / "var/backups").glob("nut-*"))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(tree(snapshots[0] / "nut"), original)
        self.assertEqual((self.live / "upssched.conf").read_bytes(), original["upssched.conf"][0])
        for name in NAMES:
            self.assertEqual(stat.S_IMODE((self.live / name).stat().st_mode), 0o640)
        calls = self.calls()
        self.assertLess(calls.index("apt-get install -y nut"), calls.index("udevadm control --reload-rules"))
        self.assertLess(calls.index("udevadm settle"), calls.index("systemctl restart nut-server"))
        installed = tree(self.live)
        (self.base / "calls").unlink()
        self.env["UPS_STATUS"] = "OB DISCHRG"
        self.run_script()
        self.assertEqual(tree(self.live), installed)
        self.assertFalse(any(c.startswith(("systemctl", "apt-get", "openssl")) for c in self.calls()))
        self.run_script(script="rollback-nut.sh", args=(str(snapshots[0]),))
        self.assertEqual(tree(self.live), original)

    def test_fresh_defaults_and_equivalent_config(self):
        self.live.rmdir()
        before = tree(self.root)
        output = self.run_script(args=("--dry-run",))
        self.assertIn("<masked>", output)
        self.assertEqual(before, tree(self.root))
        self.assertEqual(self.calls(), [])
        self.run_script()
        password = self.credentials()
        self.assertRegex(password, r"^[0-9a-f]{32}$")
        self.assertEqual((self.live / "nut.conf").read_text(), "MODE=standalone\n")
        self.assertEqual((self.live / "upsd.conf").read_text(), "LISTEN 127.0.0.1 3493\n")
        ups = (self.live / "ups.conf").read_text()
        for line in ("driver = usbhid-ups", "vendorid = 0764", "productid = 0601", "ignorelb", "override.battery.charge.low = 30", "override.battery.runtime.low = 300"):
            self.assertIn(line, ups)
        monitor = (self.live / "upsmon.conf").read_text()
        for line in ("MINSUPPLIES 1", 'SHUTDOWNCMD "/sbin/shutdown -h +0"', "POWERDOWNFLAG /etc/killpower", "FINALDELAY 5"):
            self.assertIn(line, monitor)
        # Equivalent hand-built config must not restart just for spacing/comments.
        (self.live / "ups.conf").write_text("# hand-built\n" + ups.replace(" = ", "="))
        equivalent = tree(self.live)
        (self.base / "calls").unlink()
        self.assertNotIn("---", self.run_script(args=("--dry-run",)))
        self.run_script()
        self.assertEqual(tree(self.live), equivalent)
        self.assertFalse(any(c.startswith("systemctl") for c in self.calls()))
        (self.live / "upsmon.conf").write_text(monitor.replace(password, "different-fixture"))
        before = tree(self.root)
        output = self.run_script(args=("--dry-run",))
        self.assertIn("credential differs (masked)", output)
        self.assertNotIn("different-fixture", output)
        self.assertNotIn(password, output)
        self.assertEqual(tree(self.root), before)
        self.run_script()
        self.assertEqual(self.credentials(), password)
        snapshot = sorted((self.root / "var/backups").glob("nut-*"))[0]
        self.run_script(script="rollback-nut.sh", args=(str(snapshot),))
        self.assertFalse(self.live.exists())

    def test_failure_retains_snapshot_and_prints_rollback(self):
        self.env["FAIL_RESTART"] = "1"
        output = self.run_script(success=False)
        self.assertIn("Recover with: sudo bash", output)
        self.assertIn("rollback-nut.sh", output)
        self.assertEqual(len(list((self.root / "var/backups").glob("nut-*/complete"))), 1)

    def test_bad_password_and_symlink_fail_before_changes(self):
        (self.live / "upsd.users").write_text('[upsmon]\npassword = "unterminated-fixture\n')
        before = tree(self.root)
        output = self.run_script(args=("--dry-run",), success=False)
        self.assertNotIn("unterminated-fixture", output)
        self.assertEqual(tree(self.root), before)
        (self.live / "upsd.users").unlink()
        (self.live / "ups.conf").symlink_to(self.base / "outside")
        output = self.run_script(success=False)
        self.assertIn("Unsafe config", output)
        self.assertFalse((self.base / "outside").exists())
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
