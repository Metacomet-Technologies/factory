#!/usr/bin/env python3
"""One historical CI environment repair; no publication or provisioning commands."""
import argparse
import base64
import datetime as dt
import grp
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = "scripts/release/ci-recoveries.json"
POLICY_FILE = ROOT / POLICY_PATH
SOURCE = "dcc0b84e02c00cfa2d7ef76ce3a74542fdacacef"
TREE = "df95e0488f56f98a8deffc1c0c8a7fd434bb840a"
REPAIR = "dcc0b84-backup-group-v1"
REPO = "Metacomet-Technologies/factory"
REPO_ID = 1413941821
DEVON = 58236685
ORIGINAL_RUN = 40227924006
WORKFLOW = ".github/workflows/ci-recovery.yml"
CONTROLLER_FILES = (WORKFLOW, "scripts/release/ci_recovery.py")
JOBS = ("rust", "kiosk", "scripts", "sandbox")
PENDING = ("queued", "in_progress", "waiting", "requested", "pending")
LIMIT = 256 * 1024
SHA = re.compile(r"[0-9a-f]{40}")
HEX = re.compile(r"[0-9a-f]{64}")
STEPS = {
    "rust": ("Rust toolchain", "Rust format", "Rust lint", "Rust tests", "Installer dependencies", "Installer DB tests"),
    "kiosk": ("Kiosk toolchain", "Kiosk versions", "Kiosk dependencies", "Kiosk check", "Kiosk tests", "Kiosk build"),
    "scripts": ("Node toolchain", "Dispatcher tests", "Release tests", "Script dependencies", "Script checks",
                "Client lint", "Installer contract", "Ollama tests", "Dispatch installer tests", "Backup tests",
                "UV toolchain", "Offsite group fixture", "Offsite tests", "Reboot tests", "Device tests"),
    "sandbox": ("Sandbox toolchain", "Host configuration tests", "Sandbox script checks", "Sandbox up", "Sandbox smoke", "Sandbox down"),
}


def require(condition, message):
    if not condition:
        raise ValueError("CI recovery: " + message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def positive(value):
    return type(value) is int and value > 0


def timestamp(value):
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(result.tzinfo is not None, "timestamp has no timezone")
    return result


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def source_check(root):
    require(git(root, "rev-parse", "HEAD") == SOURCE, "wrong source HEAD")
    require(git(root, "rev-parse", "HEAD^{tree}") == TREE, "wrong source tree")
    require(git(root, "write-tree") == TREE and not git(root, "diff", "--name-only"), "modified source/index")


def receipt_check(receipt, record, job):
    expected = {"repository_id": REPO_ID, "source_sha": SOURCE, "source_tree": TREE,
                "repair": REPAIR, "workflow_sha": record["workflow_sha"], "run_id": record["run_id"],
                "attempt": record["attempt"], "job": job}
    require(isinstance(receipt, dict) and set(receipt) == set(expected) | {"uid", "gid", "image", "image_version", "offsite"}, "receipt fields")
    require(all(type(receipt[k]) is type(v) and receipt[k] == v for k, v in expected.items()), "receipt identity")
    require(positive(receipt["uid"]) and positive(receipt["gid"]), "tests must not run as root")
    require(receipt["image"] == ("ubuntu22" if job == "sandbox" else "ubuntu24")
            and isinstance(receipt["image_version"], str) and 0 < len(receipt["image_version"]) < 100, "runner image")
    if job != "scripts":
        require(receipt["offsite"] is None, "unexpected group repair")
        return
    group = receipt["offsite"]
    require(isinstance(group, dict) and set(group) == {"uid", "gid", "groups", "backup_gid"}, "group receipt")
    require(group["uid"] == receipt["uid"] and group["gid"] == receipt["gid"], "test identity changed")
    require(positive(group["backup_gid"]) and isinstance(group["groups"], list)
            and all(type(g) is int and g >= 0 for g in group["groups"])
            and group["backup_gid"] in group["groups"], "ineffective backup group membership")


def record_check(record):
    require(isinstance(record, dict) and set(record) == {
        "source_sha", "repair", "workflow_sha", "workflow_id", "run_id", "attempt", "approval_pr", "jobs"}, "approval fields")
    require(record["source_sha"] == SOURCE and record["repair"] == REPAIR, "unsupported source/repair")
    require(isinstance(record["workflow_sha"], str) and SHA.fullmatch(record["workflow_sha"])
            and record["workflow_sha"] != SOURCE, "controller SHA")
    require(all(positive(record[k]) for k in ("workflow_id", "run_id", "attempt", "approval_pr")), "approval identifiers")
    require(isinstance(record["jobs"], dict) and set(record["jobs"]) == set(JOBS), "required job set")
    for job, item in record["jobs"].items():
        require(isinstance(item, dict) and set(item) == {"job_id", "artifact_id", "artifact_sha256", "receipt"}, "job evidence fields")
        require(positive(item["job_id"]) and positive(item["artifact_id"]), "job/artifact ID")
        require(isinstance(item["artifact_sha256"], str) and HEX.fullmatch(item["artifact_sha256"]), "artifact digest")
        receipt_check(item["receipt"], record, job)
    for key in ("job_id", "artifact_id"):
        require(len({item[key] for item in record["jobs"].values()}) == len(JOBS), "duplicate " + key)


def provenance_check(value, source, run, attempt):
    require(isinstance(value, dict) and set(value) == {"kind", "event", "approval_merge", "original_run", "original_attempt", "record"},
            "provenance fields")
    require(value["kind"] == "historical-ci-recovery-v1" and value["event"] == "workflow_dispatch"
            and value["original_run"] == ORIGINAL_RUN and value["original_attempt"] == 1, "provenance policy")
    require(isinstance(value["approval_merge"], str) and SHA.fullmatch(value["approval_merge"]), "approval merge SHA")
    record_check(value["record"])
    require(source == SOURCE and run == value["record"]["run_id"] and attempt == value["record"]["attempt"], "provenance binding")


def contents(api, path, ref):
    value = api.request(f"contents/{path}?ref={ref}")
    require(value["type"] == "file" and value["encoding"] == "base64" and 0 < value["size"] <= LIMIT, "controller/policy file")
    data = base64.b64decode(value["content"].replace("\n", ""), validate=True)
    require(len(data) == value["size"], "truncated controller/policy file")
    return data


def artifact_receipt(raw):
    require(len(raw) <= LIMIT, "artifact too large")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        require(len(entries) == 1 and entries[0].filename == "receipt.json"
                and entries[0].file_size <= LIMIT and not entries[0].is_dir()
                and (entries[0].external_attr >> 16) & 0o170000 in (0, 0o100000), "unsafe receipt archive")
        return json.loads(archive.read(entries[0]))


def evidence(api, source, original):
    if source != SOURCE:
        return None
    record = json.loads(POLICY_FILE.read_bytes())
    if record == {}:
        return None
    record_check(record)
    require(original["id"] == ORIGINAL_RUN and original["run_attempt"] == 1
            and original["status"] == "completed" and original["conclusion"] == "failure", "original CI changed")
    original_live = api.request(f"actions/runs/{ORIGINAL_RUN}")
    require(original_live["repository"]["id"] == REPO_ID and original_live["head_repository"]["id"] == REPO_ID
            and original_live["workflow_id"] == 381513212 and original_live["head_sha"] == SOURCE
            and original_live["event"] == "push" and original_live["head_branch"] == "main"
            and original_live["path"] == ".github/workflows/ci.yml"
            and all(original_live[k] == original[k] for k in ("id", "run_attempt", "status", "conclusion")), "original CI provenance")
    old_jobs = api.pages(f"actions/runs/{ORIGINAL_RUN}/attempts/1/jobs", "jobs")
    for name in JOBS:
        matches = [j for j in old_jobs if j["name"] == name]
        require(len(matches) == 1 and matches[0]["head_sha"] == SOURCE and matches[0]["run_attempt"] == 1
                and matches[0]["status"] == "completed"
                and matches[0]["conclusion"] == ("failure" if name == "scripts" else "success"), "original job changed")
        if name == "scripts":
            failed = [s for s in matches[0]["steps"] if s["conclusion"] == "failure"]
            require(len(failed) == 1 and failed[0]["name"] == "Test encrypted off-site backups against loopback moto",
                    "original failure differs from diagnosed fixture")

    current = json.loads(contents(api, POLICY_PATH, "main"))
    require(current == record, "approval changed on main")
    tip = api.request("git/ref/heads/main")["object"]["sha"]
    require(isinstance(tip, str) and SHA.fullmatch(tip), "main ref")
    history = git(ROOT, "rev-list", "--first-parent", tip).splitlines()
    pr = api.request(f"pulls/{record['approval_pr']}", api_version="2022-11-28")
    merge = pr["merge_commit_sha"]
    require(pr["merged"] is True and pr["merged_at"] and pr["merged_by"]["id"] == DEVON
            and pr["base"]["ref"] == "main" and pr["base"]["repo"]["id"] == REPO_ID
            and merge in history and record["workflow_sha"] in history and SOURCE in history
            and history.index(merge) < history.index(record["workflow_sha"]) < history.index(SOURCE), "approval/first-parent provenance")
    files = api.pages(f"pulls/{record['approval_pr']}/files")
    require(len(files) == 1 and files[0]["filename"] == POLICY_PATH and files[0]["status"] == "modified", "approval-only PR required")
    require(git(ROOT, "diff-tree", "--no-commit-id", "--name-only", "-r", merge + "^", merge) == POLICY_PATH,
            "approval merge changes other files")
    require(json.loads(contents(api, POLICY_PATH, merge)) == record, "record differs from approved merge")
    require(json.loads(contents(api, POLICY_PATH, record["workflow_sha"])) == {}, "controller must precede evidence approval")
    for path in CONTROLLER_FILES:
        require(contents(api, path, record["workflow_sha"]) == (ROOT / path).read_bytes(), "unapproved controller code")

    runs = api.pages(f"actions/workflows/{record['workflow_id']}/runs?event=workflow_dispatch&branch=main", "workflow_runs")
    require(runs, "recovery run missing")
    latest = max(runs, key=lambda row: row["id"])
    if latest["status"] in PENDING:
        api.waiting_for_ci = True
        return None
    require(latest["id"] == record["run_id"] and latest["run_attempt"] == record["attempt"], "newer run/attempt requires new approval")
    expected = {"id": record["run_id"], "run_attempt": record["attempt"], "workflow_id": record["workflow_id"],
                "head_sha": record["workflow_sha"], "head_branch": "main", "path": WORKFLOW,
                "event": "workflow_dispatch", "status": "completed", "conclusion": "success"}
    for run in (latest, api.request(f"actions/runs/{record['run_id']}/attempts/{record['attempt']}")):
        require(all(run[k] == v for k, v in expected.items()) and run["repository"]["id"] == REPO_ID
                and run["head_repository"]["id"] == REPO_ID
                and run["actor"]["id"] == DEVON and run["triggering_actor"]["id"] == DEVON, "recovery run provenance")
    jobs = api.pages(f"actions/runs/{record['run_id']}/attempts/{record['attempt']}/jobs", "jobs")
    require(len(jobs) == len(JOBS) and {j["name"] for j in jobs} == set(JOBS), "recovery job set")
    artifacts = api.pages(f"actions/runs/{record['run_id']}/artifacts", "artifacts")
    for job in jobs:
        name = job["name"]
        item = record["jobs"][name]
        require(job["id"] == item["job_id"] and job["run_id"] == record["run_id"]
                and job["run_attempt"] == record["attempt"] and job["head_sha"] == record["workflow_sha"]
                and job["status"] == "completed" and job["conclusion"] == "success", "job identity/attempt/result")
        require(timestamp(job["started_at"]) <= timestamp(job["completed_at"]) < timestamp(pr["merged_at"]),
                "approval must follow completed tests")
        numbers = []
        for step_name in ("Validate source", *STEPS[name], "Record evidence", "Upload evidence"):
            steps = [s for s in job["steps"] if s["name"] == step_name]
            require(len(steps) == 1 and steps[0]["status"] == "completed" and steps[0]["conclusion"] == "success", "missing/skipped/failed step: " + step_name)
            numbers.append(steps[0]["number"])
        require(numbers == sorted(set(numbers)), "functional step order")
        artifact_name = f"ci-recovery-{record['run_id']}-{record['attempt']}-{name}"
        matches = [a for a in artifacts if a["name"] == artifact_name]
        require(len(matches) == 1 and matches[0]["id"] == item["artifact_id"], "missing/replaced artifact")
        artifact = api.request(f"actions/artifacts/{item['artifact_id']}")
        require(artifact["id"] == item["artifact_id"] and artifact["name"] == artifact_name
                and artifact["expired"] is False and 0 < artifact["size_in_bytes"] <= LIMIT
                and artifact["digest"] == "sha256:" + item["artifact_sha256"], "artifact metadata")
        require(timestamp(artifact["expires_at"]) > dt.datetime.now(dt.timezone.utc), "expired artifact")
        require(timestamp(job["started_at"]) <= timestamp(artifact["created_at"])
                <= timestamp(artifact["updated_at"]) <= timestamp(job["completed_at"]), "artifact outside approved job attempt")
        origin = artifact["workflow_run"]
        require(origin["id"] == record["run_id"] and origin["head_sha"] == record["workflow_sha"]
                and origin["repository_id"] == REPO_ID and origin["head_repository_id"] == REPO_ID
                and origin["head_branch"] == "main", "artifact origin")
        raw = api.request(f"actions/artifacts/{item['artifact_id']}/zip", binary=True)
        require(len(raw) == artifact["size_in_bytes"] and sha256(raw) == item["artifact_sha256"], "artifact bytes/digest")
        require(artifact_receipt(raw) == item["receipt"], "artifact receipt substitution")
    return {"ci_run": record["run_id"], "ci_attempt": record["attempt"], "ci_recovery": {
        "kind": "historical-ci-recovery-v1", "event": "workflow_dispatch", "approval_merge": merge,
        "original_run": ORIGINAL_RUN, "original_attempt": 1, "record": record}}


def context():
    controller = os.environ["RECOVERY_WORKFLOW_SHA"]
    require(SHA.fullmatch(controller) and controller == os.environ["EXPECTED_CONTROLLER"]
            and controller == os.environ["GITHUB_SHA"] and controller == git(ROOT, "rev-parse", "HEAD"), "controller revision")
    require(os.environ["GITHUB_EVENT_NAME"] == "workflow_dispatch" and os.environ["GITHUB_REF"] == "refs/heads/main"
            and os.environ["GITHUB_REPOSITORY"] == REPO and int(os.environ["GITHUB_REPOSITORY_ID"]) == REPO_ID
            and int(os.environ["GITHUB_ACTOR_ID"]) == DEVON, "dispatch identity")
    require(os.getuid() == os.geteuid() != 0 and os.getgid() == os.getegid() != 0, "non-root runner required")
    return controller


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "offsite", "record"))
    parser.add_argument("--job", choices=JOBS, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    source_check(Path.cwd())
    if args.command == "offsite":
        require(args.job == "scripts" and args.output is not None, "offsite arguments")
        group = grp.getgrnam("factory-backup")
        facts = {"uid": os.geteuid(), "gid": os.getegid(), "groups": os.getgroups(), "backup_gid": group.gr_gid}
        require(facts["uid"] != 0 and facts["gid"] != 0 and group.gr_gid > 0
                and group.gr_gid in facts["groups"], "non-root effective membership required")
        # The original command, without replacing its Python, tests or PATH tools.
        subprocess.run(["uvx", "--from", "moto[server]==5.2.4", "--with", "pyrage==1.4.0", "--with", "boto3==1.43.118",
                        "python", "-B", "deploy/backup/test-offsite.py"], check=True)
        source_check(Path.cwd())
        args.output.write_bytes(canonical(facts))
        return
    controller = context()
    if args.command == "check":
        print(f"Historical source {SOURCE} tree {TREE}; controller {controller}")
        return
    require(args.output is not None, "receipt destination required")
    record = {"workflow_sha": controller, "run_id": int(os.environ["GITHUB_RUN_ID"]),
              "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"])}
    receipt = {"repository_id": REPO_ID, "source_sha": SOURCE, "source_tree": TREE, "repair": REPAIR,
               **record, "job": args.job, "uid": os.getuid(), "gid": os.getgid(),
               "image": os.environ["ImageOS"], "image_version": os.environ["ImageVersion"],
               "offsite": json.loads((Path(os.environ["RUNNER_TEMP"]) / "offsite.json").read_bytes()) if args.job == "scripts" else None}
    receipt_check(receipt, record, args.job)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(canonical(receipt))


if __name__ == "__main__":
    main()
