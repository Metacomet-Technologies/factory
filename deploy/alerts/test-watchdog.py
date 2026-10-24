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
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

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
    requests = []
    method_failures = {}

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
        assert self.path in ("/api/chat.postMessage", "/api/chat.update")
        assert self.headers["Authorization"] == f"Bearer {TOKEN}"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method = self.path.rsplit("/", 1)[1]
        Fake.requests.append((method, body))
        if Fake.slack_fail or Fake.method_failures.get(method, 0):
            if Fake.slack_fail:
                Fake.slack_fail -= 1
            else:
                Fake.method_failures[method] -= 1
            return self.reply(200, {"ok": False, "error": "ratelimited"})
        Fake.posts.append(body)
        self.reply(200, {"ok": True, "channel": "C-test",
                         "ts": body.get("ts", f"1791900000.{len(Fake.posts):06}")})


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        Fake.healthy, Fake.posts, Fake.slack_fail = True, [], 0
        Fake.requests, Fake.method_failures = [], {}
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

    def expected(self, title, fields, now_ms, color, emoji, suffix="", **routing):
        utc = datetime.fromtimestamp(now_ms // 1000, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        blocks = [{"type": "section", "text": {"type": "mrkdwn", "verbatim": True, "text": f"*{title}*"}}]
        if fields:
            blocks.append({"type": "section", "fields": [
                {"type": "mrkdwn", "verbatim": True, "text": f"*{label}*\n{value}"} for label, value in fields]})
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "verbatim": True, "text":
            f"factory-gpu · watchdog · <!date^{now_ms // 1000}^{{date_short_pretty}} {{time}}|{utc}>"
            " · <https://factory-gpu.bearded-pompano.ts.net/devices/factory-gpu|Open devices page>"
            + suffix}]})
        return {"channel": "C-test", "text": f"{emoji} {title}",
                "attachments": [{"color": color, "blocks": blocks}],
                "unfurl_links": False, "unfurl_media": False, **routing}

    def open_alert(self):
        for _ in range(5):
            self.run_once(False)

    def test_alert_after_five_failures_then_threaded_recovery(self):
        self.run_once(True)
        for _ in range(4):
            self.run_once(False)
        self.assertEqual(Fake.posts, [])
        opened_at = self.now
        self.run_once(False)
        for _ in range(10):
            self.run_once(False)
        self.assertEqual(len(Fake.posts), 1)
        fields = [("Failed checks", "5"), ("Checking node", "factory-console"), ("Detail", "HTTP 503")]
        self.assertEqual(Fake.posts[0], self.expected(
            "factory-gpu unreachable", fields, opened_at, "#ff6a4f", ":rotating_light:"))
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        recovered_at = self.now
        self.env["FACTORY_ALERTS_CHANNEL"] = "C-changed"
        self.run_once(True)
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 3)
        self.assertEqual(Fake.posts[1], self.expected(
            "Resolved after 11 min: factory-gpu unreachable",
            [("Checking node", "factory-console"), ("Detail", "HTTP 200")],
            recovered_at, "#7ee081", ":white_check_mark:", thread_ts="1791900000.000001"))
        self.assertEqual(Fake.posts[2], self.expected(
            "Resolved: factory-gpu unreachable", fields, opened_at, "#7ee081", ":white_check_mark:",
            " · resolved after 11 min", ts="1791900000.000001"))
        self.assertEqual([method for method, _ in Fake.requests],
                         ["chat.postMessage", "chat.postMessage", "chat.update"])
        self.assertEqual(json.loads(self.state.read_text()),
                         {"failures": 0, "open": None, "replies": [], "updates": []})

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
        self.assertIn("Slack replies failed", self.run_once(True))
        self.run_once(True)
        self.assertEqual(Fake.posts[-1]["thread_ts"], "1791900000.000001")

    def test_test_alert_posts_and_threads(self):
        with contextlib.redirect_stdout(io.StringIO()), patch.object(watchdog.time, "time", return_value=self.now / 1000):
            self.assertEqual(watchdog.test_alert(self.env), 0)
        fields = [("Checking node", "factory-console"), ("Detail", "No action needed")]
        self.assertEqual(Fake.posts, [
            self.expected("factory-watchdog alert test", fields, self.now, "#728894", ":information_source:"),
            self.expected("Resolved after 0 min: factory-watchdog alert test", [("Detail", "Test completed")],
                          self.now, "#7ee081", ":white_check_mark:", thread_ts="1791900000.000001"),
            self.expected("Resolved: factory-watchdog alert test", fields, self.now, "#7ee081",
                          ":white_check_mark:", " · resolved after 0 min", ts="1791900000.000001")])
        self.assertEqual([method for method, _ in Fake.requests],
                         ["chat.postMessage", "chat.postMessage", "chat.update"])

    def test_escaping_and_optional_fields_and_limit(self):
        raw = "http://x @here <!channel> & <http://x|y>"
        escaped = "http://x @here &lt;!channel&gt; &amp; &lt;http://x|y&gt;"
        for severity, color, emoji in [("critical", "#ff6a4f", ":rotating_light:"),
                                       ("warning", "#ffd447", ":warning:"),
                                       ("resolved", "#7ee081", ":white_check_mark:"),
                                       ("neutral", "#728894", ":information_source:")]:
            for count in (0, 1, 12):
                body = watchdog.message(raw, [(raw, raw)] * count,
                                        self.now, severity, " · " + raw)
                body["channel"] = "C-test"
                self.assertEqual(body, self.expected(
                    escaped, [(escaped, escaped)] * min(count, 10),
                    self.now, color, emoji, " · " + escaped))

    def test_health_errors_are_escaped_on_open_and_resolution(self):
        with patch.object(watchdog, "check_health", return_value=(False, "TLS & <failed>")):
            self.open_alert()
        with patch.object(watchdog, "check_health", return_value=(True, "OK & <recovered>")):
            self.run_once(True)
        for index in (0, 2):
            self.assertEqual(Fake.posts[index]["attachments"][0]["blocks"][1]["fields"][-1],
                             {"type": "mrkdwn", "verbatim": True, "text": "*Detail*\nTLS &amp; &lt;failed&gt;"})
        self.assertEqual(Fake.posts[1]["attachments"][0]["blocks"][1]["fields"][-1],
                         {"type": "mrkdwn", "verbatim": True, "text": "*Detail*\nOK &amp; &lt;recovered&gt;"})

    def test_legacy_open_state_recovers_without_reposting(self):
        self.state.write_text(json.dumps({"failures": 7, "open": {
            "opened_at_ms": self.now - 2 * MINUTE, "ts": "old-ts", "detail": "old & <error>"}}))
        self.run_once(True)
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 2)
        self.assertEqual(Fake.posts[0]["thread_ts"], "old-ts")
        self.assertEqual(Fake.posts[1]["ts"], "old-ts")
        self.assertEqual(Fake.posts[1]["attachments"][0]["blocks"][1]["fields"], [
            {"type": "mrkdwn", "verbatim": True, "text": "*Failed checks*\n7"},
            {"type": "mrkdwn", "verbatim": True, "text": "*Checking node*\nfactory-console"},
            {"type": "mrkdwn", "verbatim": True, "text": "*Detail*\nold &amp; &lt;error&gt;"}])

    def test_missing_token_keeps_resolution_outboxes(self):
        self.open_alert()
        credentials = self.env.pop("CREDENTIALS_DIRECTORY")
        self.run_once(True)
        state = json.loads(self.state.read_text())
        self.assertIsNone(state["open"])
        self.assertEqual((len(state["replies"]), len(state["updates"])), (1, 1))
        self.env["CREDENTIALS_DIRECTORY"] = credentials
        self.run_once(True)
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 3)

    def test_update_failure_does_not_block_or_repeat_reply(self):
        self.open_alert()
        Fake.method_failures = {"chat.update": 1}
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 2)
        self.assertEqual([method for method, _ in Fake.requests][-2:], ["chat.postMessage", "chat.update"])
        self.run_once(True)
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 3)
        self.assertEqual(sum("thread_ts" in body for body in Fake.posts), 1)

    def test_reply_failure_does_not_block_or_repeat_update(self):
        self.open_alert()
        Fake.method_failures = {"chat.postMessage": 1}
        self.run_once(True)
        self.assertEqual(Fake.posts[-1]["ts"], "1791900000.000001")
        self.run_once(True)
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 3)
        self.assertEqual(sum("ts" in body for body in Fake.posts), 1)

    def test_retry_schedule_and_cap_are_persisted_independently(self):
        self.open_alert()
        Fake.method_failures = {"chat.postMessage": 100, "chat.update": 100}
        for attempt in range(1, 13):
            attempted_at = self.now
            self.run_once(True)
            state = json.loads(self.state.read_text())
            delay = min(30_000 * 2 ** (attempt - 1), 900_000)
            for key in ("replies", "updates"):
                self.assertEqual(state[key][0]["attempts"], attempt)
                self.assertEqual(state[key][0]["next_attempt_ms"], attempted_at + delay)
            count = len(Fake.requests)
            self.now = attempted_at + delay - 1
            self.run_once(True)
            self.assertEqual(len(Fake.requests), count)
            self.now = attempted_at + delay
        self.now += 24 * 60 * MINUTE
        self.run_once(True)
        self.assertEqual(len(Fake.requests), 25)  # Opening plus twelve attempts of each kind.

    def test_opening_retries_beyond_twelve_with_capped_backoff(self):
        self.env["FACTORY_WATCHDOG_THRESHOLD"] = "1"
        Fake.method_failures = {"chat.postMessage": 14}
        for attempt in range(1, 15):
            attempted_at = self.now
            self.run_once(False)
            opened = json.loads(self.state.read_text())["open"]
            self.assertEqual(opened["attempts"], attempt)
            next_attempt = attempted_at + min(30_000 * 2 ** (attempt - 1), 900_000)
            self.assertEqual(opened["next_attempt_ms"], next_attempt)
            self.now = next_attempt - 1
            self.run_once(False)
            self.assertEqual(len(Fake.requests), attempt)
            self.now = next_attempt
        self.run_once(False)
        self.assertEqual(len(Fake.requests), 15)
        self.assertEqual(len(Fake.posts), 1)
        self.run_once(False)
        self.assertEqual(len(Fake.requests), 15)
        self.run_once(True)
        self.assertEqual(len(Fake.requests), 17)
        self.assertEqual(len(Fake.posts), 3)

    def test_crash_before_update_preserves_acknowledged_reply(self):
        self.open_alert()
        real_slack = watchdog.slack

        def crash_on_update(env, token, method, body):
            state = json.loads(self.state.read_text())
            self.assertIsNone(state["open"])
            if method == "chat.update":
                self.assertEqual(state["replies"], [])
                raise InterruptedError("simulated process interruption")
            self.assertEqual(len(state["replies"]), 1)
            self.assertEqual(len(state["updates"]), 1)
            return real_slack(env, token, method, body)

        with patch.object(watchdog, "slack", side_effect=crash_on_update):
            with self.assertRaises(InterruptedError):
                self.run_once(True)
        self.run_once(True)
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 3)

    def test_crash_after_update_does_not_repeat_it(self):
        self.open_alert()
        Fake.method_failures = {"chat.postMessage": 1}
        real_save = watchdog.save_state

        def crash_after_saved_update(path, state):
            real_save(path, state)
            if state.get("replies") and state.get("updates") == []:
                raise InterruptedError("simulated process interruption")

        with patch.object(watchdog, "save_state", side_effect=crash_after_saved_update):
            with self.assertRaises(InterruptedError):
                self.run_once(True)
        self.now += MINUTE
        self.run_once(True)
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 3)

    def test_crash_after_opening_acknowledgement_does_not_repost(self):
        self.env["FACTORY_WATCHDOG_THRESHOLD"] = "1"
        real_save = watchdog.save_state

        def crash_after_saved_opening(path, state):
            real_save(path, state)
            if state.get("open", {}).get("ts"):
                raise InterruptedError("simulated process interruption")

        with patch.object(watchdog, "save_state", side_effect=crash_after_saved_opening):
            with self.assertRaises(InterruptedError):
                self.run_once(False)
        self.run_once(False)
        self.assertEqual(len(Fake.posts), 1)
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 3)

    def test_old_outboxes_are_delivered_during_a_new_outage(self):
        self.open_alert()
        Fake.slack_fail = 2
        self.run_once(True)
        original_reply, original_update = [body for _, body in Fake.requests[-2:]]
        self.run_once(False)
        self.assertEqual(Fake.posts[1:], [original_reply, original_update])
        for _ in range(4):
            self.run_once(False)
        self.assertEqual(len(Fake.posts), 4)
        self.assertNotIn("thread_ts", Fake.posts[-1])
        self.run_once(True)
        self.assertEqual(len(Fake.posts), 6)
        self.assertEqual(Fake.posts[4]["thread_ts"], "1791900000.000004")
        self.assertEqual(Fake.posts[5]["ts"], "1791900000.000004")

    def test_test_alert_requires_a_token(self):
        del self.env["CREDENTIALS_DIRECTORY"]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(watchdog.test_alert(self.env), 1)
        self.assertEqual(Fake.requests, [])


if __name__ == "__main__":
    os.environ.pop("CREDENTIALS_DIRECTORY", None)
    unittest.main()
