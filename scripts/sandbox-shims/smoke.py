#!/usr/bin/env python3
"""Exercise the public sandbox endpoints; print reviewable evidence as JSON."""
import json
from pathlib import Path
import sys
import time
import urllib.request

root = Path(__file__).resolve().parents[2]
ports = json.loads((root / ".sandbox/ports.json").read_text())
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get(service, path):
    with opener.open(f"http://127.0.0.1:{ports[service]}{path}", timeout=60) as response:
        return json.load(response)


evidence = {"ports": ports}
for service, path in [("meter", "/meter/health"), ("factory-api", "/v1/health")]:
    evidence[service] = get(service, path)
    assert evidence[service]["status"] == "ok"
deadline = time.monotonic() + 120
while True:
    usage = get("factory-api", "/v1/llm/usage?range=30d")
    if (usage["totals"]["requests"] > 0 and len(usage["spend_avoided"]) == 2
            and all(spend["usd"] > 0 for spend in usage["spend_avoided"])):
        break
    assert time.monotonic() < deadline, f"meter ingestion did not produce positive spend avoided: {usage}"
    time.sleep(1)
timings = []
for _ in range(20):
    started = time.perf_counter()
    usage = get("factory-api", "/v1/llm/usage?range=30d")
    timings.append((time.perf_counter() - started) * 1000)
assert usage["totals"]["prompt_tokens"] > 0
assert usage["totals"]["output_tokens"] > 0
evidence.update(totals=usage["totals"], usage_p95_ms=sorted(timings)[18], usage_samples_ms=timings)
evidence["spend_avoided"] = usage["spend_avoided"]
assert all(spend["usd"] > 0 for spend in usage["spend_avoided"])
evidence["pricing"] = json.loads((root / ".sandbox/pricing-check.json").read_text())
gpu = get("factory-api", "/v1/gpu")
assert gpu["current"]["memory_used_mib"] == 9255
assert gpu["current"]["memory_total_mib"] == 12288
assert gpu["current"]["power_w"] == 135.5
evidence["gpu"] = gpu["current"]
with opener.open(f"http://127.0.0.1:{ports['factory-api']}/v1/stream", timeout=45) as response:
    deadline = time.monotonic() + 90
    event = ""
    while time.monotonic() < deadline:
        line = response.readline().decode().strip()
        if line.startswith("event:"):
            event = line.partition(":")[2].strip()
        if line.startswith("data:") and event == "llm.request":
            evidence["sse"] = json.loads(line.partition(":")[2])
            break
    else:
        raise AssertionError("No llm.request SSE event")
if "--kiosk" in sys.argv:
    with opener.open(f"http://127.0.0.1:{ports['factory-api']}/", timeout=5) as response:
        html = response.read().decode()
        assert '<div id="root">' in html and '/assets/' in html
        evidence["kiosk_index_bytes"] = len(html.encode())
evidence["isolation"] = json.loads((root / ".sandbox/isolation.json").read_text())
print(json.dumps(evidence, indent=2))
