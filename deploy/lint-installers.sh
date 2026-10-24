#!/usr/bin/env bash
# MET-159: static lint for the installer/rollback contract (docs/PLAYBOOK.md §3).
#   bash deploy/lint-installers.sh            lint the inventory, with the exemptions below
#   bash deploy/lint-installers.sh FILE...    lint only FILE... (fixtures), without exemptions
# Never runs a linted script. Prints one pass/exempt/TODO/FAIL row per script and
# exits 1 on any FAIL, or on an exemption that is stale or names no inventoried
# script. Inventory: deploy/install-*.sh, deploy/*/install-*.sh,
# deploy/rollback-*.sh and deploy/*/rollback-*.sh.
#
# Checks, in script order (function calls and `source` are followed; heredocs,
# comments and quoted text are not commands):
#   strict     the first command is `set` with -e, -u and -o pipefail (-E too when an ERR trap exists)
#   root       an EUID/`id -u` test against 0 whose failing branch exits for non-root (`-eq 0 ]] || exit`,
#              `-ne 0 ]] && exit`, or `if ... -ne 0; then ... exit`), directly or in a called function, before
#              the first deploy mutation; an inverted guard or one after a mutation on its line does not count
#   preflight  at least one read-only check (test, command -v, getent, stat, curl, systemctl show/is-*, ...)
#              before the first deploy mutation
#   trap       an ERR or EXIT trap that writes a diagnostic to stderr, before the first deploy mutation
#   snapshot   installers back up existing state first: cp of a non-scratch, non-repo path, or sqlite3 .backup,
#              into a /var/backups or $snapshot path (touch markers and recorded states are not backups);
#              rollbacks either do that or validate the snapshot they consume
#   health     after the first deploy mutation, a bounded probe of the component: curl with a positive
#              --max-time/-m, a positive `timeout N` around curl/wget/upsc/nc, systemctl is-active, or starting a
#              repo oneshot unit that sets a positive TimeoutStartSec. A retry loop does not bound the probes in it.
#   rollback   installers name an existing rollback-*.sh in their directory; rollbacks are named by another
#              deploy script or a Markdown doc
# A deploy mutation is a write (install, cp, mv, rm, mkdir, chown, chmod, touch, tee, sed -i, redirection,
# useradd, apt-get, udevadm, systemctl start/stop/enable/...) whose target is not scratch: a mktemp
# directory, /tmp, /var/backups or a variable derived from those or named snapshot.
set -Eeuo pipefail

# One line per exemption: path|check|reason. A reason starting with `TODO MET-<new>` is a genuine
# gap to fix in a follow-up issue; otherwise the check does not fit that component's contract.
# `path|check!|TODO ...` records an audited gap the static checks cannot see, such as one branch of a
# script or a delegated helper. It must be a TODO, shows TODO whether or not the check passes, and is
# never stale.
exemptions=(
    'deploy/rollback-meter.sh|snapshot|By design it rewrites only OLLAMA_HOST; install-meter.sh snapshots the full drop-in (README, proxy-removal rollback).'
    'deploy/devices/install-devices.sh|trap|TODO MET-<new>: the ERR trap is set after mkdir -p of the lib, state and unit directories.'
    'deploy/devices/install-devices.sh|snapshot|TODO MET-<new>: mkdir -p of the lib, state and unit directories runs before the snapshot.'
    'deploy/devices/install-devices.sh|health|TODO MET-<new>: the first oneshot runs have no TimeoutStartSec, and oneshot units default to no start timeout.'
    'deploy/devices/rollback-devices.sh|trap|TODO MET-<new>: no ERR/EXIT trap.'
    'deploy/devices/rollback-devices.sh|health|TODO MET-<new>: restored SMART and maintenance units stay enabled and running, and nothing checks them after the restore.'
    'deploy/devices-agent/install-devices-agent.sh|health|TODO MET-<new>: restarts factory-devices-agent.service without a bounded probe.'
    'deploy/devices-agent/rollback-devices-agent.sh|trap|TODO MET-<new>: no ERR/EXIT trap.'
    'deploy/devices-agent/rollback-devices-agent.sh|health|TODO MET-<new>: the SMART timer and service stay enabled when the snapshot had them, and nothing checks them after the restore.'
    'deploy/backup/rollback-backup-config.sh|trap|TODO MET-<new>: no ERR/EXIT trap.'
    'deploy/backup/rollback-backup-config.sh|health|TODO MET-<new>: restarts factory-backup units to their recorded state with no bounded check.'
    'deploy/ups/rollback-nut.sh|health|TODO MET-<new>: restarts nut-server and nut-monitor without the bounded upsc probe the installer uses.'
    'deploy/ups/rollback-ups-control.sh|trap|TODO MET-<new>: no ERR/EXIT trap.'
    'deploy/ups/rollback-ups-control.sh|health|TODO MET-<new>: restarts the control service without a bounded probe.'
    'deploy/reboot/install-reboot-policy.sh|health|TODO MET-<new>: the probe, reboot-check.sh --mode observe, has no outer deadline, and reboot-policy.py waits on fcntl LOCK_EX of policy.lock with no timeout.'
    'deploy/ups/install-nut.sh|health|TODO MET-<new>: every upsc status probe runs with no timeout, so the 45 s deadline loop cannot bound a hung call.'
    'deploy/alerts/rollback-alerts.sh|health!|TODO MET-<new>: the factory-console path restarts factory-watchdog.timer with no bounded probe; only the factory-gpu path waits for health.'
    'deploy/alerts/rollback-alerts.sh|snapshot!|TODO MET-<new>: with no snapshot argument it removes the token, drop-in and watchdog files without saving them first.'
    'deploy/install-factory-api.sh|snapshot!|TODO MET-<new>: --enroll-device execs device-tokens.sh, which creates and chowns /etc/factory-api before its snapshot; the snapshot holds only the added line, not the previous file.'
    'deploy/rollback-factory-api.sh|snapshot!|TODO MET-<new>: --unenroll-device execs device-tokens.sh, which rewrites /etc/factory-api/device-tokens without saving the current file.'
    'deploy/reboot/rollback-reboot-policy.sh|snapshot|TODO MET-<new>: deletes /etc/factory-reboot/node.conf without saving it, so local edits since the last install are lost.'
    'deploy/reboot/rollback-reboot-policy.sh|health|Removal only; no service remains to probe.'
    'deploy/rollback-dispatch.sh|health|Removal only; no service remains to probe.'
    'deploy/rollback-usage.sh|health|Removal only; no service remains to probe.'
    'deploy/rollback-deploy.sh|health|Removal only; no service remains to probe.'
)

repo=$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]}")")")
program=$(cat <<'PY'
import re
import sys
from pathlib import Path

CHECKS = ("strict", "root", "preflight", "trap", "snapshot", "health", "rollback")
repo = Path(sys.argv[1])
arguments = sys.argv[2:]

HEREDOC = re.compile(r"(?<!<)<<-?\s*(['\"]?)([A-Za-z_]\w*)\1(?!<)")
FUNCTION = re.compile(r"^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{(.*)$")
ASSIGN = re.compile(r"(?:^|[\s;(])(?:local\s+|declare\s+-\w+\s+)?([A-Za-z_]\w*)=(.*)")
KEYWORDS = {"if", "elif", "while", "until", "then", "do", "else", "!", "time", "{", "}", "fi", "done", "esac", "case", "for", "in"}
FILE_WRITES = {"install", "cp", "mv", "rm", "rmdir", "ln", "mkdir", "chown", "chmod", "chgrp", "touch", "tee"}
ALWAYS_WRITES = {"useradd", "groupadd", "usermod", "userdel", "groupdel", "apt-get", "apt", "dpkg"}
SYSTEMCTL_WRITES = {"start", "stop", "restart", "reload", "enable", "disable", "daemon-reload", "mask", "unmask",
                    "kill", "clean", "reset-failed", "try-restart", "reload-or-restart"}
SYSTEMCTL_READS = {"show", "is-active", "is-enabled", "is-failed", "cat", "status", "list-timers", "list-units"}
CHECK_COMMANDS = {"[[", "[", "test", "command", "getent", "id", "stat", "cmp", "curl", "hostname", "df",
                  "dpkg-query", "timedatectl", "systemd-analyze", "sqlite3", "find", "ss", "fuser"}
PROBES = {"curl", "wget", "upsc", "nc"}
REPO_SOURCE = re.compile(r"^\"?\$\{?(here|repo)\b|^\"?\$\{?root\}?/deploy\b")
ROOT_TEST = re.compile(r"(\bEUID\b|\$\(id -u\))[^]\n]*?(-eq|-ne|==|!=)\s*0\b")
MAX_TIME = re.compile(r"(?:^|\s)(?:--max-time(?:\s+|=)|-m\s*)(\S+)")


def positive(value):
    """False for an empty or zero duration such as 0, 0s or 0.0; curl and timeout treat 0 as no limit."""
    value = value.strip("\"'")
    return bool(value) and not re.fullmatch(r"0*\.?0*[smhd]?", value)


def flatten(line):
    """Blank quoted text and arithmetic; turn $(...) and <(...) into command separators."""
    out, stack, i = [], ["top"], 0
    while i < len(line):
        c, state = line[i], stack[-1]
        if c == "\\" and i + 1 < len(line):
            out.append(" " if state == "dq" else line[i:i + 2])
            i += 2
            continue
        if state != "dq" and c == "#" and (i == 0 or line[i - 1] in " \t;"):
            break
        if state != "dq" and c == "'":
            end = line.find("'", i + 1)
            out.append("''")
            i = len(line) if end < 0 else end + 1
            continue
        if line.startswith("((", i) or line.startswith("$((", i):
            depth, j = 0, i
            while j < len(line):
                depth += {"(": 1, ")": -1}.get(line[j], 0)
                if depth == 0 and line[j] == ")":
                    break
                j += 1
            out.append(" ARITH ")
            i = j + 1
            continue
        if line.startswith("$(", i) or (state != "dq" and line.startswith("<(", i)):
            stack.append("cmd")
            out.append(" ; ")
            i += 2
            continue
        if c == '"':
            if state == "dq":
                stack.pop()
            else:
                stack.append("dq")
            out.append('"')
        elif state == "dq":
            out.append(" " if c in ";&|()<>`" else c)
        elif c == ")" and state == "cmd":
            stack.pop()
            out.append(" ; ")
        elif c in "()`":
            out.append(" ; ")
        else:
            out.append(c)
        i += 1
    return "".join(out)


def open_quote(text):
    """True when text ends inside a single- or double-quoted string."""
    state, i = None, 0
    while i < len(text):
        c = text[i]
        if state is None and c == "#" and (i == 0 or text[i - 1] in " \t;"):
            return False
        if c == "\\" and state != "'":
            i += 2
            continue
        if state is None and c in "'\"":
            state = c
        elif state == c:
            state = None
        i += 1
    return state is not None


def segments(line):
    text = re.sub(r"(^|\s)[{}](?=\s|$|;)", " ; ", flatten(line))
    return [s.strip() for s in re.split(r"&&|\|\||;;|;|\||&(?![>0-9])", text) if s.strip()]


class Script:
    def __init__(self, path, kind):
        self.path, self.kind = path, kind
        self.functions = {}
        self.lines = []
        self.load(path, set())
        self.scratch, self.backup = self.variables()

    def logical(self, path):
        raw = path.read_text().splitlines()
        result, heredoc, buffer, start = [], None, "", 0
        for number, line in enumerate(raw, 1):
            if heredoc:
                if line.strip() == heredoc:
                    heredoc = None
                continue
            if not buffer:
                start = number
            if line.rstrip().endswith("\\") and not line.lstrip().startswith("#"):
                buffer += line.rstrip()[:-1] + " "
                continue
            if not (buffer + line).lstrip().startswith("#") and open_quote(buffer + line):
                buffer += line + " "
                continue
            text, buffer = (buffer + line).strip(), ""
            if not text or text.startswith("#"):
                continue
            match = HEREDOC.search(text)
            if match:
                heredoc = match.group(2)
            result.append((path, start, text))
        return result

    def load(self, path, seen):
        seen.add(path)
        lines = self.logical(path)
        i = 0
        while i < len(lines):
            source, number, text = lines[i]
            match = FUNCTION.match(text)
            if match:
                depth = 1 + match.group(2).count("{") - match.group(2).count("}")
                body = [(source, number, match.group(2))] if match.group(2).strip() else []
                while depth > 0 and i + 1 < len(lines):
                    i += 1
                    depth += lines[i][2].count("{") - lines[i][2].count("}")
                    body.append(lines[i])
                self.functions[match.group(1)] = body
                i += 1
                continue
            sourced = re.match(r"^(?:source|\.)\s+\"?(?:\$\{?\w+\}?/)?([^\"\s]+)\"?$", text)
            if sourced and (path.parent / sourced.group(1)).is_file() and (path.parent / sourced.group(1)) not in seen:
                self.load(path.parent / sourced.group(1), seen)
            else:
                self.lines.append(lines[i])
            i += 1

    def variables(self):
        assignments = []
        for _, _, text in self.lines + [line for body in self.functions.values() for line in body]:
            assignments += ASSIGN.findall(text)
        scratch, backup, changed = {"snapshot"}, {"snapshot"}, True
        refers = lambda value, names: any(re.search(r"\$\{?" + n + r"\b", value) for n in names)
        while changed:
            changed = False
            for name, value in assignments:
                if name not in scratch and ("mktemp" in value or "/var/backups" in value or refers(value, scratch)):
                    scratch.add(name)
                    changed = True
                if name not in backup and ("/var/backups" in value or refers(value, backup)):
                    backup.add(name)
                    changed = True
        return scratch, backup

    def in_area(self, token, names):
        token = token.strip('"')
        return (token.startswith(("/var/backups", "/tmp", "/dev/null")) or "/var/backups" in token
                or any(re.search(r"\$\{?" + n + r"\b", token) for n in names))

    def command(self, segment):
        tokens, i, bounded = segment.split(), 0, False
        while i < len(tokens):
            token = tokens[i]
            if token in KEYWORDS or re.match(r"^[A-Za-z_]\w*(\[[^]]*\])?\+?=", token):
                i += 1
            elif token == "sudo":
                i += 1
                while i < len(tokens) and tokens[i].startswith("-"):
                    i += 2 if re.match(r"^-\w*[ug]$", tokens[i]) else 1
                    if tokens[i - 1] == "--":
                        break
            elif token == "env":
                i += 1
                while i < len(tokens) and (tokens[i].startswith("-") or "=" in tokens[i]):
                    i += 2 if tokens[i] == "-u" else 1
            elif token == "runuser":
                i += 1
                while i < len(tokens) and tokens[i].startswith("-"):
                    i += 2 if tokens[i] == "-u" else 1
                    if tokens[i - 1] == "--":
                        break
            elif token == "timeout" and i + 1 < len(tokens):
                i += 1
                while i < len(tokens) and tokens[i].startswith("-"):
                    i += 2 if tokens[i] in ("-s", "-k", "--signal", "--kill-after") else 1
                if i < len(tokens):
                    bounded, i = positive(tokens[i]), i + 1
            elif token == "exec" and i + 1 < len(tokens) and not re.match(r"^\d*[<>]", tokens[i + 1]):
                i += 1
            elif token in self.functions and self.wrapper(token):
                i += 1
            else:
                break
        return tokens[i:], bounded

    def wrapper(self, name):
        return any(
            self.command(segment)[0][:1] == ['"$@"']
            for _, _, text in self.functions[name] for segment in segments(text)
        )

    def targets(self, name, args, segment):
        plain = [a for a in args if not a.startswith("-")]
        if name == "install":
            values, skip = [], False
            for a in args:
                if skip:
                    skip = False
                elif a in ("-m", "-o", "-g", "-t", "-S"):
                    skip = True
                elif not a.startswith("-"):
                    values.append(a)
            return values if "-d" in args else values[-1:]
        if name in ("cp", "ln", "sed"):
            return plain[-1:]
        if name in ("chown", "chgrp", "chmod"):
            return plain[1:]
        return plain

    def effects(self, text, stack=()):
        """Return the set of effects of one logical line, following called functions."""
        found = set()
        if re.match(r"^trap\s", text):
            return found
        if re.search(r"-[fde]\s+\"?\$\{?(1|" + "|".join(map(re.escape, self.backup)) + r")\b", text):
            found.add("consume")
        for segment in segments(text):
            tokens, bounded = self.command(segment)
            if not tokens:
                continue
            if tokens[0] in PROBES and bounded:
                found.add("health")
            name, args = tokens[0], []
            skip = False
            for token in tokens[1:]:
                if skip:
                    skip = False
                elif re.match(r"^\d*(>>?|<)", token):
                    skip = token in (">", ">>", "<") or re.fullmatch(r"\d*(>>?|<)", token) is not None
                else:
                    args.append(token)
            if name in self.functions and name not in stack:
                found |= self.function_effects(name, stack + (name,))
                continue
            redirect = [m.group(1) for m in re.finditer(r"(?<![<&])\d*>>?\s*([^&\s][^\s]*)", segment)
                        if m.group(1) != "/dev/null"]
            writes = None
            if name in ALWAYS_WRITES or (name == "udevadm" and args[:1] in (["control"], ["trigger"])):
                writes = [None]
            elif name == "systemctl" and any(a in SYSTEMCTL_WRITES for a in args[:2]):
                writes = [None]
            elif name == "sed" and "-i" in args:
                writes = self.targets(name, args, segment)
            elif name in FILE_WRITES:
                writes = self.targets(name, args, segment)
            elif name == "mktemp":
                writes = ["/tmp"]
            if redirect:
                writes = (writes or []) + redirect
            if writes:
                scratch = all(t is not None and self.in_area(t, self.scratch) for t in writes)
                found.add("scratch" if scratch else "mutation")
                into_backup = [t for t in writes if t is not None and self.in_area(t, self.backup) and t.strip('"') != "/dev/null"]
                sources = [a for a in args if not a.startswith("-")][:-1] if name == "cp" else []
                if into_backup and any(not self.in_area(a, self.scratch) and not REPO_SOURCE.match(a) for a in sources):
                    found.add("snapshot")
            if name == "bash" and any(re.search(r"rollback-[\w.-]+\.sh", a) for a in args) and "--snapshot" in args:
                found.add("snapshot")
            if name == "sqlite3" and ".backup" in segment and self.in_area(segment.split(".backup", 1)[1], self.backup):
                found.add("snapshot")
            if name in CHECK_COMMANDS or (name == "systemctl" and args[:1] and args[0] in SYSTEMCTL_READS):
                if "$#" not in segment:
                    found.add("check")
            limit = MAX_TIME.search(segment) if name == "curl" else None
            if limit and positive(limit.group(1)):
                found.add("health")
            if name == "systemctl" and "is-active" in args:
                found.add("health")
            if name == "systemctl" and args[:1] in (["start"], ["restart"]) and all(self.bounded_oneshot(a) for a in args[1:] if not a.startswith("-")) and len(args) > 1:
                found.add("health")
            if ">&2" in segment or (name in ("printf", "echo") and "/dev/stderr" in segment):
                found.add("diagnostic")
        return found

    def function_effects(self, name, stack):
        found = set()
        for _, _, text in self.functions[name]:
            found |= self.effects(text, stack)
        return found

    def bounded_oneshot(self, unit):
        if not re.fullmatch(r"[\w@.-]+\.service", unit):
            return False
        roots = [self.path.parent] if arguments else [self.path.parent, repo / "deploy"]
        for root in roots:
            for candidate in sorted(root.rglob(unit)):
                if "testdata" in candidate.relative_to(root).parts and not arguments:
                    continue
                text = candidate.read_text()
                timeout = re.search(r"^TimeoutStartSec=(\S+)", text, re.M)
                return bool(re.search(r"^Type=oneshot\s*$", text, re.M) and timeout and timeout.group(1) not in ("infinity", "0"))
        return False


WORD = r"(?<![\w$-]){}(?![\w-])"


def exits(script, text, stack=()):
    """True when text runs `exit` with a non-zero or default status, directly or in a called function."""
    if re.search(WORD.format("exit") + r"(?!\s+0\b)", flatten(text)):
        return True
    for segment in segments(text):
        tokens, _ = script.command(segment)
        name = tokens[0] if tokens else None
        if name in script.functions and name not in stack:
            if any(exits(script, body, stack + (name,)) for _, _, body in script.functions[name]):
                return True
    return False


def branch(texts, i, after):
    """The then-branch of the `if` whose condition ends in texts[i] just before `after`."""
    joined = " ; ".join([flatten(after)] + [flatten(t) for t in texts[i + 1:i + 200]])
    start = re.search(WORD.format("then"), joined)
    if not start:
        return ""
    depth = 0
    for word in re.finditer(WORD.format("(if|fi|else|elif)"), joined[start.end():]):
        if word.group(1) == "if":
            depth += 1
        elif depth and word.group(1) == "fi":
            depth -= 1
        elif not depth:
            return joined[start.end():start.end() + word.start()]
    return ""


def root_guard(script, texts, i, stack=()):
    """True when texts[i] refuses non-root before any mutation on the same line."""
    text = texts[i]
    test = ROOT_TEST.search(text)
    if test and "mutation" not in script.effects(text[:test.start()]):
        prefix, rest = text[:test.start()], text[test.end():]
        close = re.search(r"\]\]|\)\)|\]", rest)
        inner, after = (rest[:close.start()], rest[close.end():].lstrip()) if close else (rest, "")
        nonroot = test.group(2) in ("-ne", "!=")
        if re.search(r"!\s*(\[\[|\(\(|\[)\s*\$?$", prefix):
            nonroot = not nonroot
        if after.startswith("||") and not nonroot and "||" not in inner:
            return exits(script, after[2:].split("&&")[0])
        if after.startswith("&&") and nonroot and "&&" not in inner:
            return exits(script, after[2:].split("||")[0])
        if re.search(r"(^|[;&|]\s*)(el)?if\s+(!\s*)?(\[\[|\(\(|\[)\s*\$?$", prefix) and nonroot and "||" not in inner:
            return exits(script, branch(texts, i, after))
    for segment in segments(text):
        tokens, _ = script.command(segment)
        name = tokens[0] if tokens else None
        if name in script.functions and name not in stack:
            body = [t for _, _, t in script.functions[name]]
            before = text[:text.find(name)]
            if "mutation" not in script.effects(before) and any(
                    root_guard(script, body, j, stack + (name,)) for j in range(len(body))):
                return True
    return False


def lint(script, references):
    lines = [(source, number, text, script.effects(text)) for source, number, text in script.lines]
    first = next((i for i, (*_, e) in enumerate(lines) if "mutation" in e), len(lines))
    where = lambda i: f"line {lines[i][1]}" if i < len(lines) else "end of script"
    before, after = lines[:first], lines[first:]
    failures = {}

    strict_line = lines[0][2] if lines else ""
    flags, options, tokens = set(), set(), strict_line.split()[1:] if strict_line.startswith("set ") else []
    i = 0
    while i < len(tokens):
        if tokens[i].startswith("-"):
            for letter in tokens[i][1:]:
                if letter == "o" and i + 1 < len(tokens):
                    i += 1
                    options.add(tokens[i])
                else:
                    flags.add(letter)
        i += 1
    traps = [(i, text) for i, (_, _, text, _) in enumerate(lines) if re.match(r"^trap\s+(?!-\s)", text)]
    err_trap = any(re.search(r"\bERR\b", text.rsplit(None, 2)[-1] + " " + text.rsplit(None, 2)[-2]) for _, text in traps)
    missing = [f for f in ("e", "u") if f not in flags] + ([] if "pipefail" in options else ["pipefail"])
    if err_trap and "E" not in flags:
        missing.append("E (an ERR trap exists)")
    if missing:
        failures["strict"] = f"first command is not set -Eeuo pipefail (missing {', '.join(missing)})"

    texts = [text for _, _, text, _ in lines]
    guard = next((i for i in range(len(texts)) if root_guard(script, texts, i)), None)
    if guard is None or guard > first:
        failures["root"] = f"no root guard before the first deploy mutation ({where(first)})"

    if not any("check" in e for i, (*_, e) in enumerate(before) if i != guard):
        failures["preflight"] = f"no read-only check before the first deploy mutation ({where(first)})"

    diagnostic = False
    for i, text in traps:
        signals = re.findall(r"\b(ERR|EXIT)\b", text.split("'")[-1] if "'" in text else text.split('"')[-1])
        body = text[len("trap"):]
        if i <= first and signals and (">&2" in body or any(
                f in script.functions and "diagnostic" in script.function_effects(f, (f,))
                for f in re.findall(r"[\w-]+", body))):
            diagnostic = True
    if not diagnostic:
        failures["trap"] = f"no ERR/EXIT trap with a stderr diagnostic before the first deploy mutation ({where(first)})"

    events = set().union(*(e for *_, e in before)) if before else set()
    if first < len(lines) and not ("snapshot" in events or (script.kind == "rollback" and "consume" in events)):
        wanted = "snapshot copy" if script.kind == "install" else "snapshot copy or validated snapshot argument"
        failures["snapshot"] = f"no {wanted} before the first deploy mutation ({where(first)})"

    if first < len(lines) and not any("health" in e for *_, e in after):
        failures["health"] = f"no bounded health check after the first deploy mutation ({where(first)})"

    text = script.path.read_text()
    if script.kind == "install":
        named = set(re.findall(r"rollback-[\w.-]+\.sh", text))
        if not any((script.path.parent / name).is_file() for name in named):
            failures["rollback"] = "names no existing rollback-*.sh in its directory"
    elif not any(script.path.name in body for path, body in references if path != script.path):
        failures["rollback"] = "no deploy script or Markdown doc names this rollback"
    return failures


def references(paths):
    found = []
    for path in paths:
        try:
            found.append((path, path.read_text()))
        except (OSError, UnicodeDecodeError):
            pass
    return found


if arguments:
    scripts = [Path(a).resolve() for a in arguments]
    reference_files = sorted({p for s in scripts for p in s.parent.iterdir() if p.suffix in (".sh", ".md")})
    exemptions = {}
else:
    deploy = repo / "deploy"
    scripts = sorted(set(deploy.glob("install-*.sh")) | set(deploy.glob("*/install-*.sh"))
                     | set(deploy.glob("rollback-*.sh")) | set(deploy.glob("*/rollback-*.sh")))
    reference_files = sorted(p for p in list(deploy.rglob("*.sh")) + list(deploy.rglob("*.md"))
                             + list((repo / "docs").rglob("*.md")) + list(repo.glob("*.md"))
                             if "testdata" not in p.relative_to(repo).parts)
    exemptions = {}
    for line in sys.stdin.read().splitlines():
        path, check, reason = line.split("|", 2)
        exemptions[(path, check)] = reason

refs = references(reference_files)
errors = []
known = set()
print("| Script | " + " | ".join(CHECKS) + " |")
print("|---" * (len(CHECKS) + 1) + "|")
details = []
for path in scripts:
    name = str(path.relative_to(repo)) if path.is_relative_to(repo) else str(path)
    known.add(name)
    kind = "install" if path.name.startswith("install-") else "rollback"
    failures = lint(Script(path, kind), refs)
    cells = []
    for check in CHECKS:
        reason = exemptions.get((name, check))
        if exemptions.get((name, check + "!")):
            cells.append("TODO")
        elif check in failures and reason:
            cells.append("TODO" if reason.startswith("TODO") else "exempt")
        elif check in failures:
            cells.append("FAIL")
            details.append(f"FAIL {name} {check}: {failures[check]}")
        elif reason:
            cells.append("STALE")
            errors.append(f"STALE {name} {check}: the check now passes; delete the exemption")
        else:
            cells.append("pass")
    print(f"| {name} | " + " | ".join(cells) + " |")
for (path, check), reason in exemptions.items():
    audited = check.endswith("!")
    if (path not in known or check.rstrip("!") not in CHECKS or not reason.strip()
            or (audited and (not reason.startswith("TODO") or (path, check[:-1]) in exemptions))):
        errors.append(f"INVALID exemption {path}|{check}: unknown script or check, or empty reason")
if exemptions:
    print("\nExemptions:")
    for (path, check), reason in exemptions.items():
        label = f"{check[:-1]} (audited; the lint cannot see it)" if check.endswith("!") else check
        print(f"- {path} {label}: {reason}")
for line in details + errors:
    print(line, file=sys.stderr)
sys.exit(1 if details or errors else 0)
PY
)
printf '%s\n' "${exemptions[@]}" | python3 -I -c "$program" "$repo" "$@"
