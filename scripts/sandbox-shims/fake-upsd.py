#!/usr/bin/env python3
"""Synthetic NUT read protocol; status is controlled only by this sandbox's file."""
import json
from pathlib import Path
import socketserver
import sys

STATUS = Path(sys.argv[2])


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        for line in self.rfile:
            command = line.decode().strip()
            if command == "VER":
                self.wfile.write(b"Network UPS Tools upsd sandbox\n")
            elif command == "LIST VAR cyberpower":
                status = STATUS.read_text().strip()
                if status not in ("OL", "OB DISCHRG", "OB DISCHRG LB"):
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
                    self.wfile.write(b"BEGIN LIST VAR cyberpower\n")
                    for key, value in values.items():
                        self.wfile.write(f"VAR cyberpower {key} {json.dumps(value)}\n".encode())
                    self.wfile.write(b"END LIST VAR cyberpower\n")
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
