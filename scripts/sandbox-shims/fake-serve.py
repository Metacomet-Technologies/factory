#!/usr/bin/env python3
"""Sandbox-only Serve path/identity proxy and Slack sink; not authentication.

/control strips the prefix and injects the fixture login (the ups-control mount).
Every other path is the Serve "/" mount: it goes to factory-api unchanged,
Authorization included, with incoming Tailscale identity headers stripped as
real Serve does, and X-Forwarded-For set to the caller.
"""
import http.client
import http.server
import json
from pathlib import Path
import sys

PORT, TARGET, STATE = int(sys.argv[1]), int(sys.argv[2]), Path(sys.argv[3])
API = int(sys.argv[4]) if len(sys.argv) > 4 else None
HOP = {"connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host",
       "content-length"}
STRIPPED_PREFIX = "tailscale-"
BODY_CAP = 1 << 20


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def proxy(self, port, path, body, headers):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=25)
        try:
            connection.request(self.command, path, body, headers)
            response = connection.getresponse()
            return response.status, response.read(), response.getheaders()
        finally:
            connection.close()

    def handle_request(self):
        length = int(self.headers.get("Content-Length", "0"))
        extra = []
        if self.path == "/slack/chat.postMessage" and self.command == "POST":
            body = self.rfile.read(min(length, 4097))
            with (STATE / "slack-posts.jsonl").open("a") as log:
                log.write(json.dumps(json.loads(body)) + "\n")
            code, data = 200, b'{"ok":true,"ts":"sandbox"}'
        elif self.path == "/control" or self.path.startswith("/control/"):
            body = self.rfile.read(min(length, 4097))
            # Identity comes from a local fixture, never from the HTTP requester.
            login = (STATE / "serve-login").read_text().strip()
            headers = {name: self.headers[name] for name in ("Content-Type", "Sec-Fetch-Site") if name in self.headers}
            if login != "tagged":
                headers["Tailscale-User-Login"] = login
            code, data, _ = self.proxy(TARGET, self.path[len("/control"):] or "/", body, headers)
        elif API is not None:
            body = self.rfile.read(min(length, BODY_CAP))
            headers = {name: value for name, value in self.headers.items()
                       if name.lower() not in HOP and not name.lower().startswith(STRIPPED_PREFIX)}
            headers["X-Forwarded-For"] = self.client_address[0]
            # Evidence for the Authorization check: header names only, never values.
            with (STATE / "serve-forwarded.jsonl").open("a") as log:
                log.write(json.dumps({"method": self.command, "path": self.path.split("?")[0],
                                      "forwarded": sorted(headers),
                                      "stripped": sorted(n for n in self.headers if n.lower().startswith(STRIPPED_PREFIX))})
                          + "\n")
            code, data, response_headers = self.proxy(API, self.path, body, headers)
            extra = [(name, value) for name, value in response_headers
                     if name.lower() in ("www-authenticate", "retry-after", "allow")]
        else:
            code, data = 404, b'{"error":"unknown fake Serve route"}'
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for name, value in extra:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_DELETE = handle_request


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
