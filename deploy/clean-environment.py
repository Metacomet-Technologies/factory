#!/usr/bin/env python3
"""Remove only the four legacy presentation overrides from an environment file."""

import re
import sys

pattern = re.compile(rb"^[ \t]*(?:export[ \t]+)?(?:PAGER|GIT_PAGER|SYSTEMD_PAGER|NO_COLOR)[ \t]*=")
for line in sys.stdin.buffer:
    if not pattern.match(line):
        sys.stdout.buffer.write(line)
