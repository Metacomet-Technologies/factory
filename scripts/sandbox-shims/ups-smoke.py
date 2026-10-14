#!/usr/bin/env python3
"""Exercise the real control service through sandbox fake Serve; no live addresses."""
import json
from pathlib import Path
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".sandbox"
PORT = json.loads((STATE / "ports.json").read_text())["fake-serve"]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path, body=None, expected=200):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/control/v1/{path}",
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Tailscale-User-Login": "forged@github"})
    try:
        response = OPENER.open(req, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        data = json.load(response)
        assert response.status == expected, (response.status, data)
        return data


def action(name, value=None):
    pending = request("actions", {"action": name, "value": value})
    result = request(f"actions/{pending['id']}/confirm", {"phrase": pending["confirm_phrase"]})
    return {"request": pending, "confirm": result}


report = {}
try:
    (STATE / "serve-login").write_text("DGarbs51@github")
    (STATE / "ups-status").write_text("OL")
    report["state"] = request("state")
    assert report["state"]["login"] == "DGarbs51@github"
    report["direct_forgery_production_uid_phase"] = json.loads((STATE / "ups-guard-check.json").read_text())
    assert report["direct_forgery_production_uid_phase"]["status"] == 403
    for login in ("unlisted@github", "tagged"):
        (STATE / "serve-login").write_text(login)
        report[login] = request("state", expected=403)
    (STATE / "serve-login").write_text("DGarbs51@github")
    report["test.quick"] = action("test.quick")
    assert report["test.quick"]["confirm"]["executed"] is True
    assert report["test.quick"]["confirm"]["tracking_status"] == "SUCCESS"
    report["input.sensitivity"] = action("input.sensitivity", "high")
    (STATE / "ups-status").write_text("OB DISCHRG")
    report["power.cycle_on_battery"] = request("actions", {"action": "power.cycle"}, expected=409)
    assert "on battery" in report["power.cycle_on_battery"]["error"]
    (STATE / "ups-status").write_text("OL")
    report["power.cycle"] = action("power.cycle")
    assert report["power.cycle"]["confirm"]["tracking_status"] == "FSD_SET"
    report["audit"] = request("audit?limit=100")["rows"]
    assert any(row["action"] == "input.sensitivity" and row["event"] == "execute"
               and row["old_value"] == "normal" and row["value"] == "high" for row in report["audit"])
    report["received_mutations"] = [line for line in (STATE / "ups-received.log").read_text().splitlines()
                                    if line.startswith(("INSTCMD", "SET VAR", "SET TRACKING", "GET TRACKING", "FSD"))]
    assert "FSD cyberpower" in report["received_mutations"]
    assert "INSTCMD cyberpower test.battery.start.quick" in report["received_mutations"]
    output = json.dumps(report, indent=2)
    assert "sandbox-only-" not in output
    (STATE / "ups-check.json").write_text(output + "\n")
    print(output)
finally:
    (STATE / "ups-status").write_text("OL")
    (STATE / "serve-login").write_text("DGarbs51@github")
