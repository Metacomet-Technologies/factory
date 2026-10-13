#!/usr/bin/env python3
"""Synthetic Slack chat.postMessage for the sandbox (MET-150). Namespace-local only.

Appends each accepted payload to the given JSONL file and answers with a
sequential `ts`, so factory-api's threaded recoveries can be checked. Requests
must carry the synthetic sandbox token; it is never recorded.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT, RECORD, TOKEN = int(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]).read_text().strip()
posts = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply({"ok": True})

    def do_POST(self):
        global posts
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path != "/api/chat.postMessage" or self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self.reply({"ok": False, "error": "invalid_auth"})
        posts += 1
        ts = f"1700000000.{posts:06}"
        with RECORD.open("a") as out:
            print(json.dumps({"ts": ts, "payload": body}), file=out)
        self.reply({"ok": True, "channel": body.get("channel"), "ts": ts})


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
