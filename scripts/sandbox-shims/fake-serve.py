#!/usr/bin/env python3
"""Sandbox-only Serve path/identity proxy and Slack sink; not authentication."""
import http.client
import http.server
import json
from pathlib import Path
import sys

PORT, TARGET, STATE = int(sys.argv[1]), int(sys.argv[2]), Path(sys.argv[3])


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        body = self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 4097))
        if self.path == "/slack/chat.postMessage" and self.command == "POST":
            with (STATE / "slack-posts.jsonl").open("a") as log:
                log.write(json.dumps(json.loads(body)) + "\n")
            code, data = 200, b'{"ok":true,"ts":"sandbox"}'
        elif self.path == "/control" or self.path.startswith("/control/"):
            # Identity comes from a local fixture, never from the HTTP requester.
            login = (STATE / "serve-login").read_text().strip()
            headers = {name: self.headers[name] for name in ("Content-Type", "Sec-Fetch-Site") if name in self.headers}
            if login != "tagged":
                headers["Tailscale-User-Login"] = login
            connection = http.client.HTTPConnection("127.0.0.1", TARGET, timeout=25)
            try:
                connection.request(self.command, self.path[len("/control"):] or "/", body, headers)
                response = connection.getresponse()
                code, data = response.status, response.read()
            finally:
                connection.close()
        else:
            code, data = 404, b'{"error":"unknown fake Serve route"}'
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = handle_request


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
