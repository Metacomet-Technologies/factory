#!/usr/bin/env python3
"""Synthetic network endpoints inside the sandbox namespace; private loopback only."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit

TAILNET_PORT, STATE, SPEED_PORT = int(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
TAILNET = STATE / "network-tailnet"
SPEED = STATE / "network-speed"
CHUNK = memoryview(bytes(256 * 1024))
SLOW_BPS = 50_000_000
MAX_BYTES = 200_000_000


def tailnet_up():
    return not TAILNET.exists() or TAILNET.read_text().strip() == "up"


def speed_mode():
    """ok (default), slow, fail or hang; read again for every request."""
    try:
        return SPEED.read_text().strip() or "ok"
    except FileNotFoundError:
        return "ok"


class Speed(BaseHTTPRequestHandler):
    """Cloudflare-style GET /__down?bytes=N and POST /__up. slow paces bodies at
    50 Mb/s, fail answers 500, and hang holds the request unanswered."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def answer(self, status, length=0):
        self.send_response(status)
        self.send_header("Content-Length", str(length))
        if status == 200:
            self.send_header("cf-meta-colo", "SBX")
        self.end_headers()

    def pace(self, started, moved):
        time.sleep(max(0.0, started + moved * 8 / SLOW_BPS - time.monotonic()))

    def stall(self):
        deadline = time.monotonic() + 90
        while speed_mode() == "hang" and time.monotonic() < deadline:
            time.sleep(0.5)
        self.close_connection = True

    def do_GET(self):
        url = urlsplit(self.path)
        try:
            length = int(parse_qs(url.query, strict_parsing=True)["bytes"][0])
        except (KeyError, ValueError):
            length = -1
        if url.path != "/__down" or not 0 <= length <= MAX_BYTES:
            return self.answer(404 if url.path != "/__down" else 400)
        # speed.cloudflare.com answers 403 here without a Referer.
        if length >= 100_000_000 and not self.headers.get("Referer"):
            return self.answer(403)
        mode = speed_mode()
        if mode == "hang":
            return self.stall()
        if mode == "fail":
            return self.answer(500)
        self.answer(200, length)
        started, sent = time.monotonic(), 0
        while sent < length:
            chunk = CHUNK[:min(len(CHUNK), length - sent)]
            self.wfile.write(chunk)
            sent += len(chunk)
            if mode == "slow":
                self.pace(started, sent)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if self.path != "/__up" or not 0 <= length <= MAX_BYTES:
            self.close_connection = True
            return self.answer(404 if self.path != "/__up" else 400)
        mode = speed_mode()
        if mode == "hang":
            return self.stall()
        buffer = memoryview(bytearray(len(CHUNK)))
        started, received = time.monotonic(), 0
        while received < length:
            count = self.rfile.readinto(buffer[:min(len(buffer), length - received)])
            if not count:
                return
            received += count
            if mode == "slow":
                self.pace(started, received)
        self.answer(500 if mode == "fail" else 200)


def serve_speed():
    server = ThreadingHTTPServer(("127.0.0.1", SPEED_PORT), Speed)
    server.daemon_threads = True
    server.serve_forever()


def serve_tailnet():
    """Accept and drop TCP handshakes while the fixture reads `up`; refuse them otherwise."""
    listener = None
    while True:
        if tailnet_up() and listener is None:
            listener = socket.create_server(("127.0.0.1", TAILNET_PORT))
            listener.settimeout(0.5)
        elif not tailnet_up() and listener is not None:
            listener.close()
            listener = None
        if listener is None:
            time.sleep(0.5)
            continue
        try:
            connection, _ = listener.accept()
            connection.close()
        except TimeoutError:
            pass


threading.Thread(target=serve_speed, daemon=True).start()
serve_tailnet()
