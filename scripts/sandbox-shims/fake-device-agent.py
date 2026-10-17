#!/usr/bin/env python3
"""Simulated factory-console agent for the sandbox only (docs/devices-ingest.md).

Builds schema-version-1 samples from the contract's example fixtures with current
timestamps and uploads them through this worktree's fake Serve with the synthetic
sandbox token. It follows the agent upload rules closely enough to exercise the
server: one request at a time, oldest first, retry on network errors, 429 and 5xx,
drop on other 4xx, keep the buffer on 401/403. It never prints the token, the
Authorization header or a request body.
"""
import argparse
import copy
import json
from pathlib import Path
import random
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".sandbox"
FIXTURES = ROOT / "factory-api/tests/fixtures/devices-ingest"
BUFFER = 240


def ports():
    return json.loads((STATE / "ports.json").read_text())


def token():
    return (STATE / "credentials/factory-console-device-token").read_text().strip()


def shift(value, delta):
    if isinstance(value, dict):
        for key, item in value.items():
            if key.endswith("_ms") and not key.endswith("interval_ms") and isinstance(item, int):
                value[key] = item + delta
            else:
                shift(item, delta)
    elif isinstance(value, list):
        for item in value:
            shift(item, delta)


def build(variant, session, seq, observed_ms):
    sample = json.loads((FIXTURES / f"{variant}.json").read_text())
    shift(sample, observed_ms - sample["observed_at_ms"])
    sample["session_id"] = session
    sample["seq"] = seq
    sample["cpu"]["utilization"]["value"] = round(8 + 6 * random.random(), 1) \
        if sample["cpu"]["utilization"]["availability"] == "available" else None
    return sample


def post(sample, *, device="factory-console", credential=None, headers=None, port=None, raw=None):
    """One attempt through fake Serve. Returns (status, json body, case-insensitive response headers)."""
    attempt = copy.deepcopy(sample)
    if isinstance(attempt, dict) and "sent_at_ms" in attempt:
        attempt["sent_at_ms"] = max(int(time.time() * 1000), attempt["observed_at_ms"])
    data = raw if raw is not None else json.dumps(attempt).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{port or ports()['fake-serve']}/v1/devices/{device}/samples",
                                     data=data, method="POST",
                                     headers={"Content-Type": "application/json", **(headers or {})})
    if credential:
        request.add_header("Authorization", f"Bearer {credential}")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=5) as response:
            return response.status, json.load(response), response.headers
    except urllib.error.HTTPError as error:
        body = error.read()
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = None
        return error.code, parsed, error.headers


def run(interval, count, variant):
    session = str(uuid.uuid4())
    credential = token()
    buffer, seq, dropped, backoff = [], 0, 0, 1.0
    next_sample = time.monotonic()
    while count is None or seq < count or buffer:
        if (count is None or seq < count) and time.monotonic() >= next_sample:
            seq += 1
            buffer.append(build(variant, session, seq, int(time.time() * 1000)))
            if len(buffer) > BUFFER:
                buffer.pop(0)
                dropped += 1
            next_sample += interval
        while buffer:
            try:
                status, body, headers = post(buffer[0], credential=credential)
            except OSError as error:
                print(json.dumps({"seq": buffer[0]["seq"], "error": type(error).__name__}), flush=True)
                time.sleep(min(backoff, interval))
                backoff = min(backoff * 2, 60)
                break
            line = {"seq": buffer[0]["seq"], "status": status}
            if status == 200:
                line.update(result=body["result"], reason=body["reason"],
                            current_updated=body["current_updated"], history_written=body["history_written"])
                buffer.pop(0)
                backoff = 1.0
            elif status in (429, 500, 503, 504):
                line["code"] = (body or {}).get("error", {}).get("code")
                print(json.dumps(line), flush=True)
                time.sleep(max(float(headers.get("Retry-After", 0)), random.uniform(0, backoff)))
                backoff = min(backoff * 2, 60)
                break
            elif status in (401, 403):
                line["code"] = (body or {}).get("error", {}).get("code")
                print(json.dumps(line), flush=True)
                break
            else:
                line.update(code=(body or {}).get("error", {}).get("code"), field=(body or {}).get("error", {}).get("field"))
                buffer.pop(0)
            print(json.dumps(line), flush=True)
        time.sleep(max(0.0, min(1.0, next_sample - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--interval", type=float, default=15.0)
    parser.add_argument("--count", type=int, help="stop after this many samples (default: run until killed)")
    parser.add_argument("--variant", choices=["complete", "unsupported", "partial"], default="complete")
    args = parser.parse_args()
    try:
        run(args.interval, args.count, args.variant)
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
