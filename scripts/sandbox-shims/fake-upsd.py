#!/usr/bin/env python3
"""Synthetic NUT; no host commands. Every received command is recorded, passwords redacted."""
import json
from pathlib import Path
import shlex
import socketserver
import sys
import threading
import uuid

STATUS = Path(sys.argv[2])
VALUES = STATUS.with_name("ups-values.json")
RANGES = STATUS.with_name("ups-ranges.json")
RECEIVED = STATUS.with_name("ups-received.log")
LOCK = threading.Lock()
WRITABLE = {
    "input.sensitivity": "normal", "input.transfer.low": "100", "input.transfer.high": "139",
    "ups.delay.shutdown": "60", "ups.delay.start": "120", "driver.flag.allow_killpower": "0",
}
COMMANDS = ("beeper.disable", "beeper.enable", "beeper.mute", "driver.killpower",
            "driver.reload", "driver.reload-or-error", "driver.reload-or-exit",
            "load.off", "load.off.delay", "load.on", "load.on.delay", "shutdown.default",
            "shutdown.return", "shutdown.stayoff", "shutdown.stop",
            "test.battery.start.quick", "test.battery.start.deep", "test.battery.stop")
ALLOWED = {"beeper.disable", "beeper.enable", "beeper.mute", "shutdown.stop",
           "test.battery.start.quick", "test.battery.stop"}


def overrides():
    return json.loads(VALUES.read_text()) if VALUES.exists() else {}


class Handler(socketserver.StreamRequestHandler):
    def mutation(self, parts):
        mode_file = STATUS.with_name("ups-tracking")
        mode = mode_file.read_text().strip() if mode_file.exists() else "SUCCESS"
        if not self.tracking or mode == "PLAIN_OK":
            self.wfile.write(b"OK\n")
            return
        tracking_id = str(uuid.uuid4()).upper()
        self.jobs[tracking_id] = (mode, parts, False)
        self.wfile.write(f"OK TRACKING {tracking_id}\n".encode())

    def handle(self):
        user = password = None
        self.tracking = False
        self.jobs = {}
        for line in self.rfile:
            command = line.decode().strip()
            parts = shlex.split(command)
            if not parts:
                continue
            with LOCK, RECEIVED.open("a") as log:
                print("PASSWORD <redacted>" if parts[0] == "PASSWORD" else command, file=log)
            if command == "VER":
                self.wfile.write(b"Network UPS Tools upsd sandbox\n")
            elif parts[0] in ("USERNAME", "PASSWORD") and len(parts) == 2:
                if parts[0] == "USERNAME":
                    user = parts[1]
                else:
                    password = parts[1]
                self.wfile.write(b"OK\n")
            elif command == "SET TRACKING ON":
                self.tracking = user is not None and password is not None
                self.wfile.write(b"OK\n" if self.tracking else b"ERR USERNAME-REQUIRED\n")
            elif len(parts) == 3 and parts[:2] == ["GET", "TRACKING"]:
                mode, mutation, applied = self.jobs.get(parts[2], ("FAILURE", [], True))
                if mode == "SUCCESS" and not applied and mutation[:2] == ["SET", "VAR"]:
                    with LOCK:
                        values = overrides()
                        values[mutation[3]] = mutation[4]
                        VALUES.write_text(json.dumps(values))
                self.jobs[parts[2]] = (mode, mutation, True)
                self.wfile.write(({"SUCCESS": "SUCCESS", "PENDING": "PENDING"}.get(mode, "ERR FAILED") + "\n").encode())
            elif command == "LIST VAR cyberpower":
                status = STATUS.read_text().strip()
                if status not in ("OL", "OL CHRG", "OL LB", "OB DISCHRG", "OB DISCHRG LB"):
                    self.wfile.write(b"ERR DATA-STALE\n")
                else:
                    values = {
                        "ups.status": status, "battery.charge": "100" if status == "OL" else "48",
                        "battery.charge.low": "30", "battery.charge.warning": "20",
                        "battery.runtime": "4200" if status == "OL" else "847",
                        "battery.runtime.low": "300", "battery.voltage": "25.9",
                        "ups.load": "24", "ups.realpower": "144", "ups.realpower.nominal": "600",
                        "input.voltage": "121" if status == "OL" else "0", "output.voltage": "120",
                        "ups.test.result": "Done and passed", "ups.model": "CyberPower synthetic",
                    }
                    with LOCK:
                        values.update(WRITABLE)
                        values.update(overrides())
                    self.wfile.write(b"BEGIN LIST VAR cyberpower\n")
                    for key, value in values.items():
                        if value is None:  # A null fixture removes a variable.
                            continue
                        self.wfile.write(f"VAR cyberpower {key} {json.dumps(value)}\n".encode())
                    self.wfile.write(b"END LIST VAR cyberpower\n")
            elif parts[:3] in (["LIST", "ENUM", "cyberpower"], ["LIST", "RANGE", "cyberpower"]) and len(parts) == 4:
                kind, variable = parts[1], parts[3]
                ranges = json.loads(RANGES.read_text()) if RANGES.exists() else {}
                items = (["low", "normal", "high"] if variable == "input.sensitivity" else []) if kind == "ENUM" else ranges.get(variable, [])
                if not items:
                    self.wfile.write(f"ERR NOT-{kind}\n".encode())
                else:
                    self.wfile.write(f"BEGIN {command}\n".encode())
                    for item in items:
                        suffix = json.dumps(item) if kind == "ENUM" else " ".join(map(str, item))
                        self.wfile.write(f"{kind} cyberpower {variable} {suffix}\n".encode())
                    self.wfile.write(f"END {command}\n".encode())
            elif command in ("LIST CMD cyberpower", "LIST RW cyberpower"):
                kind = parts[1]
                self.wfile.write(f"BEGIN {command}\n".encode())
                for name in COMMANDS if kind == "CMD" else WRITABLE:
                    suffix = "" if kind == "CMD" else " " + json.dumps(overrides().get(name, WRITABLE[name]))
                    self.wfile.write(f"{kind} cyberpower {name}{suffix}\n".encode())
                self.wfile.write(f"END {command}\n".encode())
            elif parts[0] in ("INSTCMD", "SET", "FSD"):
                expected = STATUS.with_name("credentials") / "nut-password"
                if user != "factory-control" or not expected.exists() or password != expected.read_text().strip():
                    self.wfile.write(b"ERR ACCESS-DENIED\n")
                elif len(parts) == 3 and parts[:2] == ["INSTCMD", "cyberpower"] and parts[2] in ALLOWED:
                    self.mutation(parts)
                elif len(parts) == 5 and parts[:3] == ["SET", "VAR", "cyberpower"] and parts[3] in WRITABLE:
                    self.mutation(parts)
                elif parts == ["FSD", "cyberpower"]:
                    self.wfile.write(b"OK FSD-SET\n")  # Never invokes shutdown.
                else:
                    self.wfile.write(b"ERR ACCESS-DENIED\n")
            elif command == "LOGOUT":
                self.wfile.write(b"OK Goodbye\n")
                return
            else:
                self.wfile.write(b"ERR UNKNOWN-COMMAND\n")
            self.wfile.flush()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(("127.0.0.1", int(sys.argv[1])), Handler) as server:
    server.serve_forever()
