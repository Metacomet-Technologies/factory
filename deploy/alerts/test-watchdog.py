#!/usr/bin/env python3
"""factory-watchdog against a fake health endpoint and a fake Slack API."""

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

here = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("watchdog", here / "factory-watchdog.py")
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)
TOKEN = "xoxb-test-token"
MINUTE = 60_000


class Fake(BaseHTTPRequestHandler):
    healthy = True
    posts = []
    slack_fail = 0

    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        assert self.path == "/v1/health"
        self.reply(200 if Fake.healthy else 503, {"status": "ok"})

    def do_POST(self):
        assert self.path == "/api/chat.postMessage"
        assert self.headers["Authorization"] == f"Bearer {TOKEN}"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if Fake.slack_fail:
            Fake.slack_fail -= 1
            return self.reply(200, {"ok": False, "error": "ratelimited"})
        Fake.posts.append(body)
        self.reply(200, {"ok": True, "ts": f"1791900000.{len(Fake.posts):06}"})


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        Fake.healthy, Fake.posts, Fake.slack_fail = True, [], 0
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{self.server.server_port}"
        self.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temp.name)
        (root / "credentials").mkdir()
        (root / "credentials" / "slack-bot-token").write_text(TOKEN + "\n")
        self.env = {
            "FACTORY_WATCHDOG_HEALTH_URL": f"{base}/v1/health",
            "FACTORY_WATCHDOG_STATE": str(root / "state.json"),
            "FACTORY_ALERTS_SLACK_URL": f"{base}/api",
            "FACTORY_ALERTS_CHANNEL": "C-test",
            "CREDENTIALS_DIRECTORY": str(root / "credentials"),
        }
        self.state = root / "state.json"
        self.clock = True
        self.now = 1_791_900_000_000

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def run_once(self, healthy):
        Fake.healthy = healthy
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(watchdog.run(self.env, self.now, lambda: self.clock), 0)
        self.now += MINUTE
        self.assertNotIn(TOKEN, output.getvalue())
        return output.getvalue()

    def test_alert_after_five_failures_then_threaded_recovery(self):
        self.run_once(True)
        for _ in range(4):
            self.run_once(False)
        self.assertEqual(Fake.posts, [])
        self.run_once(False)
        for _ in range(10):
            self.run_once(False)
        self.assertEqual(len(Fake.posts), 1)
        self.assertEqual(Fake.posts[0]["channel"], "C-test")
        self.assertNotIn("thread_ts", Fake.posts[0])
        self.assertTrue(Fake.posts[0]["text"].startswith(
            ":rotating_light: factory-gpu unreachable: 5 consecutive health checks failed"))
        self.assertIn("HTTP 503", Fake.posts[0]["text"])
        self.assertIn("https://factory-gpu.bearded-pompano.ts.net", Fake.posts[0]["text"])
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        self.run_once(True)
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 2)
        self.assertEqual(Fake.posts[1]["thread_ts"], "1791900000.000001")
        self.assertEqual(Fake.posts[1]["channel"], "C-test")
        self.assertTrue(Fake.posts[1]["text"].startswith(
            ":white_check_mark: Recovered after 11 min: factory-gpu reachable again"))
        self.assertEqual(json.loads(self.state.read_text()), {"failures": 0, "open": None})

    def test_interrupted_streak_and_unsynchronized_clock_do_not_alert(self):
        for healthy in [False] * 4 + [True] + [False] * 4:
            self.run_once(healthy)
        self.clock = False
        for _ in range(5):
            self.assertIn("not counted", self.run_once(False))
        self.assertEqual(Fake.posts, [])
        self.clock = None  # Unknown clock still counts.
        self.run_once(False)
        self.assertEqual(len(Fake.posts), 1)

    def test_missing_token_posts_nothing_and_failed_posts_retry(self):
        del self.env["CREDENTIALS_DIRECTORY"]
        for _ in range(6):
            output = self.run_once(False)
        self.assertIn("No Slack token; alert not posted", output)
        self.run_once(True)
        self.assertEqual(Fake.posts, [])
        self.env["CREDENTIALS_DIRECTORY"] = str(pathlib.Path(self.temp.name) / "credentials")
        Fake.slack_fail = 1
        for _ in range(4):
            self.run_once(False)
        self.assertIn("Alert post failed; will retry", self.run_once(False))
        self.assertEqual(len(Fake.posts), 0)
        self.run_once(False)
        self.assertEqual(len(Fake.posts), 1)
        Fake.slack_fail = 1
        self.assertIn("Recovery post failed", self.run_once(True))
        self.run_once(True)
        self.assertEqual(Fake.posts[-1]["thread_ts"], "1791900000.000001")

    def test_test_alert_posts_and_threads(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(watchdog.test_alert(self.env), 0)
        self.assertEqual(len(Fake.posts), 2)
        self.assertEqual(Fake.posts[1]["thread_ts"], "1791900000.000001")


if __name__ == "__main__":
    os.environ.pop("CREDENTIALS_DIRECTORY", None)
    unittest.main()
