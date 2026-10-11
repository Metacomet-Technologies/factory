#!/usr/bin/env python3
"""Change only OLLAMA_HOST assignments; preserve other drop-in content."""

import os
from pathlib import Path
import re
import shlex
import sys
import tempfile


def set_host(path: Path, host: str) -> None:
    original = path.read_bytes().decode() if path.exists() else ""
    found = False
    lines = []
    for line in original.splitlines(keepends=True):
        if line.lstrip().startswith("Environment="):
            prefix, assignments = line.split("=", 1)
            tokens = list(re.finditer(r'''(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+''', assignments))
            for token in reversed(tokens):
                if shlex.split(token[0])[0].startswith("OLLAMA_HOST="):
                    quote = token[0][0] if token[0][0] in "\"'" else ""
                    replacement = f"{quote}OLLAMA_HOST={host}{quote}"
                    assignments = assignments[:token.start()] + replacement + assignments[token.end():]
                    found = True
            line = prefix + "=" + assignments
        lines.append(line)
    updated = "".join(lines)
    if not found:
        updated += ("" if updated.endswith("\n") or not updated else "\n")
        updated += f'[Service]\nEnvironment="OLLAMA_HOST={host}"\n'
    if updated == original:
        return
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(updated.encode())
            file.flush()
            os.fsync(file.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


if __name__ == "__main__":
    set_host(Path(sys.argv[1]), sys.argv[2])
