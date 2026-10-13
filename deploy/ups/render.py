#!/usr/bin/env python3
"""Render NUT templates without exposing credentials in arguments or diffs."""
import difflib
import pathlib
import re
import shlex
import subprocess
import sys

NAMES = ("nut.conf", "ups.conf", "upsd.conf", "upsd.users", "upsmon.conf")


def tokens(line):
    line = re.sub(r"^(\s*[\w.]+)\s*=\s*", r"\1 = ", line)
    return shlex.split(line, comments=True)


def password_from(path):
    if not path.exists():
        return None
    section = None
    passwords = []
    for line in path.read_text().splitlines():
        parts = tokens(line)
        if parts and parts[0].startswith("["):
            section = parts[0]
        elif section == "[upsmon]" and parts and parts[0] == "password":
            if len(parts) != 3 or parts[1] != "=" or not parts[2]:
                raise ValueError("Invalid existing upsmon password assignment")
            passwords.append(parts[2])
    if len(passwords) > 1:
        raise ValueError("Ambiguous existing upsmon password assignments")
    return passwords[0] if passwords else None


def normalized(text, mask=False):
    result = []
    for line in text.splitlines():
        parts = tokens(line)
        if not parts:
            continue
        if mask and parts[0] == "password":
            parts = ["password", "=", "<masked>"]
        elif mask and parts[0] == "MONITOR":
            if len(parts) != 6:
                raise ValueError("Invalid MONITOR directive")
            parts[4] = "<masked>"
        result.append(shlex.join(parts) + "\n")
    return result


def main():
    live = pathlib.Path(sys.argv[1])
    dry = sys.argv[2] == "--dry-run"
    password = password_from(live / "upsd.users")
    if password is None:
        password = "<generated-on-install>" if dry else subprocess.check_output(
            ["openssl", "rand", "-hex", "16"], text=True
        ).strip()
    if any(c in password for c in "\r\n\x00"):
        raise ValueError("Unsupported control character in password")
    quoted = '"' + password.replace("\\", "\\\\").replace('"', '\\"') + '"'
    templates = pathlib.Path(__file__).parent
    for name in NAMES:
        rendered = (templates / (name + ".in")).read_text().replace("@PASSWORD@", quoted)
        old = (live / name).read_text() if (live / name).exists() else ""
        if dry:
            old_masked = normalized(old, mask=True)
            new_masked = normalized(rendered, mask=True)
            if old_masked == new_masked and normalized(old) != normalized(rendered):
                print(f"/etc/nut/{name}: credential differs (masked).")
            sys.stdout.writelines(difflib.unified_diff(
                old_masked, new_masked, fromfile=f"/etc/nut/{name}",
                tofile=f"rendered/{name}",
            ))
        else:
            # Preserve comments/formatting and avoid restarts for equivalent config.
            if normalized(old) == normalized(rendered):
                rendered = old
            (pathlib.Path(sys.argv[2]) / name).write_text(rendered)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError):
        # Never echo parser errors or file contents: either can contain a password.
        sys.exit("ERROR: Cannot read/render NUT config; review files privately.")
