#!/usr/bin/env python3
"""Offline release contracts; all publication requests go to FakeGitHub."""
import base64
import copy
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import zipfile

import release as r
import ci_recovery as recovery

_spec = importlib.util.spec_from_file_location("prove_cache", Path(__file__).with_name("prove-cache.py"))
prove_cache = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prove_cache)

ROOT = Path(__file__).resolve().parents[2]
INVENTORY = json.loads((ROOT / "deploy/components.json").read_bytes())
SHA = "a" * 40


def plan(sha=SHA, tag="v0.2.1"):
    return {"schema_version": 1, "repository": r.REPO, "source_sha": sha,
            "source_version": "0.2.0", "release_tag": tag, "bump": "patch",
            "pull_request": 1, "ci_run": 1, "ci_attempt": 1}


def fixture_build(reservation, directory, inventory=INVENTORY):
    directory.mkdir(parents=True, exist_ok=True)
    identity = {"version": reservation["release_tag"][1:], "git_sha": reservation["source_sha"],
                "git_dirty": False, "built_at_ms": 1792000000000, "inputs_fingerprint": "123456abcdef"}
    for name in r.ASSETS - {"kiosk.tar.gz", "deployment.tar.gz"}:
        (directory / name).write_bytes(b"fixture binary: " + name.encode() + r.canonical(identity))
    r.make_archive(directory / "kiosk.tar.gz", {
        "index.html": (b"fixture kiosk", False), "version.json": (b'{"build":"fixture"}', False),
        "release-build.json": (r.canonical(identity), False)})
    scripts = {path: (b"fixture; never execute\n", False) for path in inventory["required_files"]}
    scripts["deploy/components.json"] = (r.canonical(inventory), False)
    scripts["release-source.json"] = (r.canonical({"source_sha": reservation["source_sha"]}), False)
    r.make_archive(directory / "deployment.tar.gz", scripts)
    manifest = {"schema_version": 1, "state": "complete", "repository": r.REPO,
                "source_sha": reservation["source_sha"], "source_version": "0.2.0",
                "release_tag": reservation["release_tag"], "release_version": reservation["release_tag"][1:],
                "bump": reservation["bump"], "inventory": inventory,
                "fingerprints": {c: "b" * 64 for c in r.COMPONENTS},
                "build_identity": {c: identity for c in ("meter", "factory-api", "kiosk")},
                "archive_files": {name: {p: r.digest(data) for p, data in r.archive_entries((directory / name).read_bytes()).items()}
                                  for name in ("kiosk.tar.gz", "deployment.tar.gz")},
                "evidence": reservation, "artifacts": [
                    {"name": name, "size": (directory / name).stat().st_size,
                     "sha256": r.digest((directory / name).read_bytes())} for name in sorted(r.ASSETS)]}
    (directory / "manifest.json").write_bytes(r.canonical(manifest))


class FakeGitHub(r.GitHub):
    def __init__(self):
        super().__init__()
        self.refs, self.objects, self.releases, self.blobs = {}, {}, [], {}
        self.prs, self.runs, self.jobs = {}, {}, {}
        self.writes = 0
        self.crash_at = None
        self.crash_after = False
        self.uploaded = []
        self.published_immutable = True
        self.requests = []

    def eligible(self, sha, number, bump=None):
        self.prs[number] = {"number": number, "merged": True, "merged_at": "2026-10-16T00:00:00Z",
                            "merge_commit_sha": sha, "base": {"ref": "main", "repo": {"full_name": r.REPO}},
                            "labels": [{"name": "bump:" + bump}] if bump else []}
        self.runs[number] = {"id": number, "head_sha": sha, "head_branch": "main", "event": "push",
                             "path": ".github/workflows/ci.yml", "status": "completed",
                             "conclusion": "success", "run_attempt": 1}
        self.jobs[number] = [{"id": number * 10 + i, "head_sha": sha, "name": name,
                              "status": "completed", "conclusion": "success"}
                             for i, name in enumerate(INVENTORY["required_ci"])]

    def request(self, path, method="GET", data=None, binary=False, upload=None,
                api_version=r.API_VERSION):
        self.requests.append((path, method, api_version))
        if method != "GET":
            self.writes += 1
            if self.crash_at == self.writes and not self.crash_after:
                raise OSError("simulated crash before write")
        result = self.handle(path, method, data, binary, upload)
        if method != "GET" and self.crash_at == self.writes and self.crash_after:
            raise OSError("simulated lost write acknowledgement")
        result = copy.deepcopy(result)
        # Model the actual API break, not a version-insensitive idealized fake.
        if api_version == "2026-03-10" and (
                path.startswith("commits/") or path.startswith("pulls/")):
            for pr in result if isinstance(result, list) else [result]:
                pr.pop("merge_commit_sha", None)
        return result

    def handle(self, path, method, data, binary, upload):
        url = urlsplit(path)
        parts = url.path.split("/")
        query = parse_qs(url.query)
        if method == "POST" and path == "git/tags":
            key = f"{len(self.objects) + 1:040x}"
            self.objects[key] = {"message": data["message"], "object": {"sha": data["object"], "type": "commit"}}
            return {"sha": key}
        if method == "POST" and path == "git/refs":
            r.require(data["ref"] not in self.refs, "ref collision")
            self.refs[data["ref"]] = {"ref": data["ref"], "object": {"sha": data["sha"], "type": "tag"}}
            return self.refs[data["ref"]]
        if parts[:2] == ["git", "tags"]:
            return self.objects[parts[2]]
        if parts[:2] == ["git", "matching-refs"]:
            return list(self.refs.values())
        if parts[0] == "commits":
            return [pr for pr in self.prs.values() if pr["merge_commit_sha"] == parts[1]]
        if parts[0] == "pulls":
            return self.prs[int(parts[1])]
        if parts[:2] == ["actions", "workflows"]:
            return {"workflow_runs": [run for run in self.runs.values() if run["head_sha"] == query["head_sha"][0]]}
        if parts[:2] == ["actions", "runs"]:
            return {"jobs": self.jobs[int(parts[2])]}
        if method == "POST" and path == "releases":
            r.require(not any(x["tag_name"] == data["tag_name"] for x in self.releases), "duplicate release")
            release = {**data, "id": len(self.releases) + 1, "assets": [], "immutable": False, "published_at": None}
            self.releases.append(release)
            return release
        if path.startswith("releases/assets/") and binary:
            return self.blobs[int(parts[2])]
        if len(parts) == 1 and parts[0] == "releases":
            return self.releases
        if parts[0] == "releases":
            release = self.releases[int(parts[1]) - 1]
            if method == "PATCH":
                r.require(release["draft"], "cannot mutate published release")
                release.update(data, immutable=self.published_immutable, published_at="2026-10-16T00:00:00Z")
                return release
            if upload is not None:
                name = query["name"][0]
                r.require(release["draft"] and not any(a["name"] == name for a in release["assets"]), "asset replacement")
                blob = upload.read_bytes()
                key = len(self.blobs) + 1
                self.blobs[key] = blob
                asset = {"id": key, "name": name, "state": "uploaded", "size": len(blob),
                         "digest": "sha256:" + r.digest(blob)}
                release["assets"].append(asset)
                self.uploaded.append((release["tag_name"], name))
                return asset
            return release if len(parts) == 2 else release["assets"]
        raise AssertionError(f"unexpected fake API request: {method} {path}")


class TokenGitHub(FakeGitHub):
    """Distinct read-only build and write-enabled publisher token capabilities."""
    def __init__(self, shared, *, draft_reads, list_drafts=False):
        super().__init__()
        for name in ("refs", "objects", "releases", "blobs", "prs", "runs", "jobs"):
            setattr(self, name, getattr(shared, name))
        self.draft_reads = draft_reads
        self.list_drafts = list_drafts

    def request(self, path, method="GET", *args, **kwargs):
        route = urlsplit(path).path
        if not self.draft_reads:
            if method != "GET":
                raise AssertionError("read-only build attempted a remote write")
            parts = route.split("/")
            private_release = False
            if len(parts) > 1 and parts[0] == "releases":
                if parts[1] == "assets":
                    private_release = any(release["draft"] and any(str(asset["id"]) == parts[2]
                                          for asset in release["assets"]) for release in self.releases)
                else:
                    private_release = any(str(release["id"]) == parts[1] and release["draft"]
                                          for release in self.releases)
            if private_release:
                self.requests.append((path, method, kwargs.get("api_version", r.API_VERSION)))
                raise ValueError("HTTP 403: draft inaccessible to read token")
        result = super().request(path, method, *args, **kwargs)
        if route == "releases" and method == "GET" and not self.draft_reads and not self.list_drafts:
            return [release for release in result if not release["draft"]]
        return result


class RecoveryGitHub(FakeGitHub):
    """GitHub wire-format fixtures, never accepted evidence outside the test."""
    def __init__(self):
        super().__init__()
        self.controller, self.approval = "c" * 40, "d" * 40
        self.eligible(recovery.SOURCE, 201)
        original = self.runs.pop(201)
        self.original = {**original, "id": recovery.ORIGINAL_RUN, "workflow_id": 381513212,
                         "conclusion": "failure", "repository": {"id": recovery.REPO_ID},
                         "head_repository": {"id": recovery.REPO_ID}}
        self.runs[recovery.ORIGINAL_RUN] = self.original
        self.jobs[recovery.ORIGINAL_RUN] = self.jobs.pop(201)
        for job in self.jobs[recovery.ORIGINAL_RUN]:
            job.update(run_attempt=1, conclusion="failure" if job["name"] == "scripts" else "success")
            job["steps"] = [{"name": "Test encrypted off-site backups against loopback moto", "conclusion": "failure"}] if job["name"] == "scripts" else []
        self.recovery_run = {"id": 900, "run_attempt": 2, "workflow_id": 700, "head_sha": self.controller,
                             "head_branch": "main", "path": recovery.WORKFLOW, "event": "workflow_dispatch",
                             "status": "completed", "conclusion": "success", "repository": {"id": recovery.REPO_ID},
                             "head_repository": {"id": recovery.REPO_ID}, "actor": {"id": recovery.DEVON},
                             "triggering_actor": {"id": recovery.DEVON}}
        self.latest = self.recovery_run
        self.record = {"source_sha": recovery.SOURCE, "repair": "dcc0b84-backup-group-v1",
                       "workflow_sha": self.controller, "workflow_id": 700, "run_id": 900, "attempt": 2,
                       "approval_pr": 300, "jobs": {}}
        self.approval_pr = {"merged": True, "merged_at": "2026-10-26T00:00:00Z", "merge_commit_sha": self.approval,
                            "merged_by": {"id": recovery.DEVON}, "base": {"ref": "main", "repo": {"id": recovery.REPO_ID}}}
        self.approval_files = [{"filename": recovery.POLICY_PATH, "status": "modified"}]
        self.recovery_jobs, self.artifacts, self.archives = [], [], {}
        self.remote_record = self.record
        self.approved_record = self.record
        self.controller_policy = {}
        self.controller_files = {p: (ROOT / p).read_bytes() for p in recovery.CONTROLLER_FILES}
        self.revoke_after_upload = False
        for index, name in enumerate(("rust", "kiosk", "scripts", "sandbox")):
            receipt = {"repository_id": recovery.REPO_ID, "source_sha": recovery.SOURCE, "source_tree": recovery.TREE,
                       "repair": "dcc0b84-backup-group-v1", "workflow_sha": self.controller,
                       "run_id": 900, "attempt": 2, "job": name, "uid": 1001, "gid": 1002,
                       "image": "ubuntu22" if name == "sandbox" else "ubuntu24", "image_version": "20261012.334.1",
                       "offsite": {"uid": 1001, "gid": 1002, "groups": [1002, 998], "backup_gid": 998} if name == "scripts" else None}
            item = {"job_id": 100 + index, "artifact_id": 200 + index, "receipt": receipt}
            self.record["jobs"][name] = item
            names = ("Validate source", *recovery.STEPS[name], "Record evidence", "Upload evidence")
            self.recovery_jobs.append({"name": name, "id": item["job_id"], "run_id": 900, "run_attempt": 2,
                                       "head_sha": self.controller, "status": "completed", "conclusion": "success",
                                       "started_at": "2026-10-25T23:00:00Z", "completed_at": "2026-10-25T23:30:00Z",
                                       "steps": [{"name": s, "number": n + 1, "status": "completed", "conclusion": "success"}
                                                 for n, s in enumerate(names)]})
            self.artifacts.append({"id": item["artifact_id"], "name": f"ci-recovery-900-2-{name}", "expired": False,
                                   "created_at": "2026-10-25T23:29:00Z", "updated_at": "2026-10-25T23:29:01Z",
                                   "expires_at": "2099-01-01T00:00:00Z", "workflow_run": {
                                       "id": 900, "head_sha": self.controller, "head_branch": "main",
                                       "repository_id": recovery.REPO_ID, "head_repository_id": recovery.REPO_ID}})
            self.replace_receipt(name)

    def replace_receipt(self, name, raw=None):
        item = self.record["jobs"][name]
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            archive.writestr("receipt.json", raw if raw is not None else r.canonical(item["receipt"]))
        raw = data.getvalue()
        item["artifact_sha256"] = r.digest(raw)
        artifact = next(a for a in self.artifacts if a["id"] == item["artifact_id"])
        artifact.update(size_in_bytes=len(raw), digest="sha256:" + r.digest(raw))
        self.archives[item["artifact_id"]] = raw

    def handle(self, path, method, data, binary, upload):
        url = urlsplit(path)
        if url.path.startswith("contents/"):
            name, ref = url.path[len("contents/"):], parse_qs(url.query)["ref"][0]
            if name == recovery.POLICY_PATH:
                value = self.remote_record if ref == "main" else self.approved_record
                if ref == self.controller:
                    value = self.controller_policy
                if ref == "main" and self.revoke_after_upload and self.uploaded:
                    value = {}
                raw = r.canonical(value)
            else:
                raw = self.controller_files[name]
            return {"type": "file", "encoding": "base64", "size": len(raw), "content": base64.b64encode(raw).decode()}
        if url.path == "git/ref/heads/main":
            return {"object": {"sha": self.approval}}
        if url.path == "pulls/300":
            return self.approval_pr
        if url.path == "pulls/300/files":
            return self.approval_files
        if url.path == f"actions/runs/{recovery.ORIGINAL_RUN}":
            return self.original
        if url.path == "actions/workflows/700/runs":
            return {"workflow_runs": [self.latest]}
        if url.path == "actions/runs/900/attempts/2":
            return self.recovery_run
        if url.path == "actions/runs/900/attempts/2/jobs":
            return {"jobs": self.recovery_jobs}
        if url.path == "actions/runs/900/artifacts":
            return {"artifacts": self.artifacts}
        if url.path.startswith("actions/artifacts/"):
            identifier = int(url.path.split("/")[2])
            return self.archives[identifier] if binary else next(a for a in self.artifacts if a["id"] == identifier)
        return super().handle(path, method, data, binary, upload)


class HistoricalRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.policy = self.root / "approval.json"
        self.enterContext(patch.object(recovery, "POLICY_FILE", self.policy))
        self.history = ["d" * 40, "c" * 40, recovery.SOURCE]
        self.merge_files = recovery.POLICY_PATH
        self.enterContext(patch.object(recovery, "git", side_effect=self.git_evidence))

    def git_evidence(self, root, *args):
        if args[:2] == ("rev-list", "--first-parent"):
            return "\n".join(self.history)
        if args[0] == "diff-tree":
            return self.merge_files
        raise AssertionError(args)

    def evidence(self, api):
        self.policy.write_bytes(r.canonical(api.record))
        return api.evidence(recovery.SOURCE, INVENTORY)

    def test_dormant_and_normal_ci_unchanged(self):
        self.policy.write_text('{}')
        api = RecoveryGitHub()
        with self.assertRaisesRegex(ValueError, "exact-SHA main CI incomplete"):
            api.evidence(recovery.SOURCE, INVENTORY)
        self.assertEqual(api.writes, 0)
        api.original["conclusion"] = "success"
        for job in api.jobs[recovery.ORIGINAL_RUN]:
            job["conclusion"] = "success"
        self.assertNotIn("ci_recovery", api.evidence(recovery.SOURCE, INVENTORY))
        # Even a malformed recovery policy cannot authorize or obstruct another SHA.
        self.policy.write_text('{bad')
        api.eligible(SHA, 2)
        self.assertEqual(api.evidence(SHA, INVENTORY)["ci_run"], 2)
        api.runs[2]["conclusion"] = "failure"
        with self.assertRaisesRegex(ValueError, "exact-SHA main CI incomplete"):
            api.evidence(SHA, INVENTORY)

    def test_exact_recovery_roundtrip_and_immutable_resume(self):
        api = RecoveryGitHub()
        evidence = self.evidence(api)
        self.assertEqual((evidence["ci_run"], evidence["ci_attempt"], evidence["pull_request"]), (900, 2, 201))
        self.assertEqual(evidence["ci_recovery"]["event"], "workflow_dispatch")
        reservation = {**plan(recovery.SOURCE), **evidence}
        self.assertEqual(r.publish_one(api, reservation, INVENTORY, self.root / "bundle", fixture_build), "complete")
        manifest = r.verify_bundle(self.root / "bundle", INVENTORY, recovery.SOURCE)
        self.assertEqual(manifest["evidence"], reservation)
        # Completed immutable releases no longer depend on retained CI artifacts.
        api.artifacts.clear()
        self.policy.write_text('{}')
        writes = api.writes
        self.assertEqual(r.publish_one(api, reservation, INVENTORY, self.root / "retry", fixture_build), "already complete")
        self.assertEqual(api.writes, writes)
        altered = copy.deepcopy(manifest)
        altered["evidence"]["ci_recovery"]["record"]["jobs"]["scripts"]["receipt"]["offsite"]["groups"] = [1002]
        with self.assertRaisesRegex(ValueError, "membership"):
            r.validate_manifest(altered, INVENTORY, recovery.SOURCE)

    def test_wrong_identity_approval_and_job_evidence(self):
        cases = [
            ("record.source_sha", "a" * 40), ("record.workflow_sha", "b" * 40), ("record.repair", "other"),
            ("recovery_run.event", "push"), ("recovery_run.path", ".github/workflows/ci.yml"),
            ("recovery_run.head_sha", recovery.SOURCE), ("recovery_run.head_branch", "feature"),
            ("recovery_run.repository.id", 77), ("recovery_run.head_repository.id", 77),
            ("recovery_run.actor.id", 77), ("recovery_run.triggering_actor.id", 77),
            ("recovery_run.conclusion", "failure"), ("recovery_run.run_attempt", 3),
            ("approval_pr.merged", False), ("approval_pr.merged_by.id", 77),
            ("approval_pr.base.ref", "feature"), ("approval_pr.base.repo.id", 77),
            ("approval_pr.merged_at", "2026-10-25T23:15:00Z"),
            ("original.run_attempt", 2), ("original.head_repository.id", 77),
        ]
        for path, value in cases:
            with self.subTest(path=path):
                api = RecoveryGitHub()
                head, *keys = path.split(".")
                target = getattr(api, head)
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = value
                with self.assertRaises(ValueError):
                    self.evidence(api)
                self.assertEqual(api.writes, 0)
        for field, value in (("head_sha", recovery.SOURCE), ("run_attempt", 1), ("run_id", 901),
                             ("conclusion", "skipped"), ("id", 999)):
            with self.subTest(job_field=field):
                api = RecoveryGitHub()
                api.recovery_jobs[0][field] = value
                with self.assertRaises(ValueError):
                    self.evidence(api)
        api = RecoveryGitHub()
        next(j for j in api.jobs[recovery.ORIGINAL_RUN] if j["name"] == "scripts")["steps"][0]["name"] = "Other failure"
        with self.assertRaisesRegex(ValueError, "differs from diagnosed fixture"):
            self.evidence(api)
        for condition in ("skipped", "failure", "missing", "duplicate"):
            api = RecoveryGitHub()
            steps = api.recovery_jobs[2]["steps"]
            step = next(s for s in steps if s["name"] == "Offsite tests")
            if condition == "missing":
                steps.remove(step)
            elif condition == "duplicate":
                steps.append(copy.deepcopy(step))
            else:
                step["conclusion"] = condition
            with self.subTest(step=condition), self.assertRaisesRegex(ValueError, "step"):
                self.evidence(api)

    def test_artifact_substitution_expiry_and_nonroot_membership(self):
        for field, value in (("expired", True), ("expires_at", "2020-01-01T00:00:00Z"),
                             ("id", 777), ("digest", "sha256:" + "0" * 64),
                             ("created_at", "2026-10-25T22:00:00Z"), ("updated_at", "2026-10-25T23:31:00Z"),
                             ("name", "ci-recovery-900-1-rust")):
            with self.subTest(artifact=field):
                api = RecoveryGitHub()
                api.artifacts[0][field] = value
                with self.assertRaises(ValueError):
                    self.evidence(api)
        for field, value in (("uid", 0), ("source_tree", "b" * 40), ("attempt", 1), ("repository_id", 99)):
            with self.subTest(receipt=field):
                api = RecoveryGitHub()
                api.record["jobs"]["scripts"]["receipt"][field] = value
                api.replace_receipt("scripts")
                with self.assertRaises(ValueError):
                    self.evidence(api)
        for field, value in (("uid", 0), ("gid", 55), ("groups", [1002]), ("backup_gid", 0)):
            with self.subTest(group=field):
                api = RecoveryGitHub()
                api.record["jobs"]["scripts"]["receipt"]["offsite"][field] = value
                api.replace_receipt("scripts")
                with self.assertRaises(ValueError):
                    self.evidence(api)
        api = RecoveryGitHub()
        api.replace_receipt("rust", r.canonical({**api.record["jobs"]["rust"]["receipt"], "attempt": 1}))
        with self.assertRaisesRegex(ValueError, "substitution"):
            self.evidence(api)
        api = RecoveryGitHub()
        api.artifacts[0]["workflow_run"]["id"] = 901
        with self.assertRaisesRegex(ValueError, "origin"):
            self.evidence(api)
        api = RecoveryGitHub()
        api.archives[200] = b"altered bytes"
        with self.assertRaisesRegex(ValueError, "bytes/digest"):
            self.evidence(api)

    def test_approval_controller_history_and_newer_runs_fail_closed(self):
        for change in ("remote", "approved", "controller", "controller-policy", "files", "merge-files", "history", "new-run"):
            api = RecoveryGitHub()
            with self.subTest(change=change):
                if change == "remote":
                    api.remote_record = {}
                elif change == "approved":
                    api.approved_record = {}
                elif change == "controller":
                    api.controller_files[recovery.WORKFLOW] += b"# changed\n"
                elif change == "controller-policy":
                    api.controller_policy = api.record
                elif change == "files":
                    api.approval_files.append({"filename": "other", "status": "modified"})
                elif change == "merge-files":
                    self.merge_files = recovery.POLICY_PATH + "\nother"
                elif change == "history":
                    self.history = [api.approval, recovery.SOURCE]
                else:
                    api.latest = {**api.recovery_run, "id": 901, "conclusion": "failure"}
                with self.assertRaises(ValueError):
                    self.evidence(api)
                self.history = [api.approval, api.controller, recovery.SOURCE]
                self.merge_files = recovery.POLICY_PATH
        api = RecoveryGitHub()
        api.latest = {**api.recovery_run, "id": 901, "status": "queued", "conclusion": None}
        self.assertIsNone(self.evidence(api))
        self.assertTrue(api.waiting_for_ci)

    def test_changed_approval_stops_before_reservation_and_before_publication(self):
        for boundary in ("reserve", "publish"):
            with self.subTest(boundary=boundary):
                api = RecoveryGitHub()
                reservation = {**plan(recovery.SOURCE), **self.evidence(api)}
                if boundary == "reserve":
                    api.remote_record = {}
                else:
                    api.revoke_after_upload = True
                with self.assertRaisesRegex(ValueError, "approval changed"):
                    r.publish_one(api, reservation, INVENTORY, self.root / boundary, fixture_build)
                if boundary == "reserve":
                    self.assertEqual(api.writes, 0)
                else:
                    self.assertTrue(api.releases[0]["draft"])
                    self.assertEqual(api.tags()["v0.2.1"]["reservation"], reservation)
                    api.revoke_after_upload = False
                    self.assertEqual(r.publish_one(api, reservation, INVENTORY, self.root / "resume", fixture_build), "complete")

    def test_missing_and_malformed_evidence_never_authorizes(self):
        for condition in ("no-job", "duplicate-job", "no-artifact", "duplicate-artifact", "wrong-order", "bad-zip", "bad-receipt"):
            api = RecoveryGitHub()
            if condition == "no-job":
                api.recovery_jobs.pop()
            elif condition == "duplicate-job":
                api.recovery_jobs[-1] = copy.deepcopy(api.recovery_jobs[0])
            elif condition == "no-artifact":
                api.artifacts.clear()
            elif condition == "duplicate-artifact":
                api.artifacts.append(copy.deepcopy(api.artifacts[0]))
            elif condition == "wrong-order":
                api.recovery_jobs[0]["steps"][1]["number"] = 999
            elif condition == "bad-zip":
                raw = b"not a zip"
                api.archives[200] = raw
                api.record["jobs"]["rust"]["artifact_sha256"] = r.digest(raw)
                api.artifacts[0].update(size_in_bytes=len(raw), digest="sha256:" + r.digest(raw))
            else:
                api.replace_receipt("rust", b"not json")
            with self.subTest(condition=condition), self.assertRaises((ValueError, zipfile.BadZipFile)):
                self.evidence(api)
            self.assertEqual(api.writes, 0)

    def test_first_parent_order_and_reserved_evidence_cannot_change(self):
        def history(root, *args):
            if args[0] == "rev-list":
                return "\n".join((INVENTORY["activation_baseline"], recovery.SOURCE, SHA))
            if args[0] == "ls-tree":
                return "deploy/components.json"
            if args[0] == "show":
                return "0.2.0" if args[1].endswith(":VERSION") else json.dumps(INVENTORY)
            raise AssertionError(args)

        api = RecoveryGitHub()
        api.eligible(SHA, 202)
        self.policy.write_text('{}')
        with patch.object(r, "git", side_effect=history):
            with self.assertRaisesRegex(ValueError, "exact-SHA main CI incomplete"):
                next(r.planned(api, self.root, INVENTORY))
            self.evidence(api)
            plans = list(r.planned(api, self.root, INVENTORY))
            self.assertEqual([(p["source_sha"], p["release_tag"]) for p in plans],
                             [(recovery.SOURCE, "v0.2.1"), (SHA, "v0.2.2")])
            reservation = plans[0]
            r.reserve(api, reservation)
            # A later independently valid approval is not the reserved identity.
            replacement = copy.deepcopy(reservation)
            replacement["ci_recovery"]["approval_merge"] = "e" * 40
            with patch.object(api, "evidence", return_value=replacement):
                with self.assertRaisesRegex(ValueError, "reserved recovery evidence changed"):
                    list(r.planned(api, self.root, INVENTORY))
            replacement = copy.deepcopy(reservation)
            replacement["ci_attempt"] = 3
            with patch.object(api, "evidence", return_value=replacement):
                with self.assertRaisesRegex(ValueError, "reserved recovery evidence changed"):
                    list(r.planned(api, self.root, INVENTORY))
            self.assertEqual(api.tags()["v0.2.1"]["reservation"], reservation)


class Releases(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def test_checked_in_inventory_classifies_tracked_units(self):
        r.inventory_check(INVENTORY)
        tracked = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "deploy", "scripts"], text=True).splitlines()
        units = {Path(p).name for p in tracked if p.startswith("deploy/") and p.endswith((".service", ".timer", ".path", ".service.in"))}
        self.assertLessEqual(units, {s for c in INVENTORY["components"] for s in c["services"]})
        self.assertLessEqual(set(INVENTORY["required_files"]), set(tracked))

    def test_allocation_and_intent(self):
        tags = ["v0.2.9", "v0.2.11", "other"]
        self.assertEqual(r.allocate(tags, "0.2.0", "patch"), "v0.2.12")
        self.assertEqual(r.allocate(tags, "0.2.0", "minor"), "v0.3.0")
        self.assertEqual(r.allocate(tags, "0.2.0", "major"), "v1.0.0")
        self.assertEqual(r.allocate(tags, "2.4.6", "patch"), "v2.4.7")
        self.assertEqual(r.bump_intent(["unrelated"]), "patch")
        for bad in ("0.02.0", "v1.2.3", "1.2.3-rc1", "1.2.3+build", "1.2", "1.2.3\n", "4294967296.0.0"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                r.version(bad)
        for labels in (["bump:major", "bump:minor"], ["bump:patch", "bump:minor"], ["bump:unknown"]):
            with self.assertRaisesRegex(ValueError, "contradictory"):
                r.bump_intent(labels)
        with self.assertRaises(ValueError):
            r.allocate(["v1.02.0"], "0.2.0", "patch")

    def test_crashes_at_every_write_boundary_and_noop(self):
        # Reservation object/ref, draft, seven uploads, then publication.
        for boundary in range(1, 12):
            for after in (False, True):
                with self.subTest(boundary=boundary, after=after):
                    api = FakeGitHub()
                    api.crash_at, api.crash_after = boundary, after
                    output = self.directory / f"{boundary}-{after}"
                    with self.assertRaises(OSError):
                        r.publish_one(api, plan(), INVENTORY, output, fixture_build)
                    api.crash_at = None
                    # Owner inspection confirms no release after a tag-only crash.
                    if api.refs and not api.releases:
                        api.create_reserved_releases.add("v0.2.1")
                    r.publish_one(api, plan(), INVENTORY, output, fixture_build)
                    writes = api.writes
                    self.assertEqual(r.publish_one(api, plan(), INVENTORY, output,
                                     lambda *_: self.fail("complete release rebuilt")), "already complete")
                    self.assertEqual(api.writes, writes)
                    self.assertEqual(len(api.refs), 1)
                    self.assertEqual(len(api.releases), 1)
                    self.assertEqual(len(api.uploaded), 7)
                    self.assertEqual(len(set(api.uploaded)), 7)

    def test_creation_response_survives_invisible_release_collection(self):
        api = FakeGitHub()
        original = api.handle

        def hidden(path, method, data, binary, upload):
            if method == "GET" and urlsplit(path).path == "releases":
                return []
            return original(path, method, data, binary, upload)

        with patch.object(api, "handle", side_effect=hidden):
            self.assertEqual(r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build), "complete")
            # Looking for another tag must not discard the directly acknowledged ID.
            self.assertIsNone(r.release_for(api, "v0.2.2"))
            self.assertEqual(r.release_for(api, "v0.2.1")["id"], 1)
        self.assertEqual(len(api.releases), 1)
        self.assertEqual(len(api.uploaded), 7)

    def test_invalid_creation_acknowledgement_never_uploads_or_publishes(self):
        for change in ({"id": None}, {"id": True}, {"id": 0}, {"id": "1"},
                       {"tag_name": "v0.2.2"}, {"draft": False}, {"draft": "true"}):
            with self.subTest(change=change):
                api = FakeGitHub()
                original = api.request

                def request(path, method="GET", *args, **kwargs):
                    result = original(path, method, *args, **kwargs)
                    return {**result, **change} if path == "releases" and method == "POST" else result

                with patch.object(api, "request", side_effect=request), self.assertRaises(ValueError):
                    r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
                self.assertEqual(len(api.releases), 1)
                self.assertEqual(api.uploaded, [])
                self.assertTrue(api.releases[0]["draft"])

    def test_direct_read_identity_or_access_failure_stops_without_more_writes(self):
        for change in ("denied", "id", "tag", "draft"):
            with self.subTest(change=change):
                api = FakeGitHub()
                original = api.request

                def request(path, method="GET", *args, **kwargs):
                    if path == "releases/1" and method == "GET":
                        if change == "denied":
                            raise ValueError("direct read denied")
                        result = original(path, method, *args, **kwargs)
                        result.update({"id": 2} if change == "id" else
                                      {"tag_name": "v0.2.2"} if change == "tag" else {"draft": False})
                        return result
                    return original(path, method, *args, **kwargs)

                with patch.object(api, "request", side_effect=request), self.assertRaises(ValueError):
                    r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
                self.assertEqual(api.uploaded, [])
                self.assertEqual(api.writes, 3)

    def test_recover_invisible_draft_by_id_and_retry_completed_release(self):
        api = FakeGitHub()
        r.reserve(api, plan())
        api.request("releases", "POST", {"tag_name": "v0.2.1", "draft": True, "body": "incomplete", "prerelease": False})
        original = api.handle

        def hidden(path, method, data, binary, upload):
            if method == "GET" and urlsplit(path).path == "releases":
                return []
            return original(path, method, data, binary, upload)

        with patch.object(api, "handle", side_effect=hidden):
            for completed in (False, True):
                api.release_ids = None  # A fresh process cannot rely on its old cache.
                writes = api.writes
                r.resume_release(api, "v0.2.1=1")
                self.assertEqual(api.writes, writes)
                result = r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
                self.assertEqual(result, "already complete" if completed else "complete")
                if completed:
                    self.assertEqual(api.writes, writes)
        self.assertEqual(len(api.releases), 1)
        self.assertEqual(sum(path == "releases" and method == "POST" for path, method, _ in api.requests), 1)
        self.assertFalse(any(method == "DELETE" for _, method, _ in api.requests))

    def test_recovered_draft_preserves_conflicting_assets_and_missing_tag(self):
        for change in ("bytes", "starter", "missing_tag", "wrong_plan"):
            with self.subTest(change=change):
                api = FakeGitHub()
                r.reserve(api, plan())
                api.request("releases", "POST", {"tag_name": "v0.2.1", "draft": True})
                fixture_build(plan(), self.directory)
                api.request("releases/1/assets?name=manifest.json", "POST",
                            upload=self.directory / "manifest.json")
                r.resume_release(api, "v0.2.1=1")
                if change == "bytes":
                    api.blobs[1] = b"conflict"
                elif change == "starter":
                    api.releases[0]["assets"][0]["state"] = "starter"
                elif change == "missing_tag":
                    api.refs.clear()
                else:
                    key = api.refs["refs/tags/v0.2.1"]["object"]["sha"]
                    api.objects["d" * 40] = copy.deepcopy(api.objects[key])
                    api.objects["d" * 40]["message"] = r.canonical({**plan(), "ci_attempt": 2}).decode()
                    api.refs["refs/tags/v0.2.1"]["object"]["sha"] = "d" * 40
                writes = api.writes
                with self.assertRaises(ValueError):
                    r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
                self.assertEqual(api.writes, writes)
                self.assertTrue(api.releases[0]["draft"])
                self.assertEqual(len(api.releases), 1)

    def test_reserved_hidden_draft_needs_explicit_recovery_before_any_writes(self):
        root, inventory, first, second = self.history()
        api = FakeGitHub()
        api.eligible(first, 1)
        api.eligible(second, 2)
        reservation = list(r.planned(api, root, inventory))[0]
        r.reserve(api, reservation)
        api.request("releases", "POST", {"tag_name": "v0.2.1", "draft": True})
        original = api.handle

        def hidden(path, method, data, binary, upload):
            if method == "GET" and urlsplit(path).path == "releases":
                return []
            return original(path, method, data, binary, upload)

        writes = api.writes
        with patch.object(api, "handle", side_effect=hidden):
            with self.assertRaisesRegex(ValueError, "explicit recovery"):
                list(r.planned(api, root, inventory))
            with self.assertRaisesRegex(ValueError, "explicit recovery"):
                r.publish_one(api, reservation, inventory, self.directory,
                              lambda *_: self.fail("built before recovery validation"))
        self.assertEqual(api.writes, writes)
        self.assertEqual(len(api.releases), 1)

    def test_explicit_create_is_per_tag_and_does_not_bypass_read_failure(self):
        root, inventory, first, second = self.history()
        api = FakeGitHub()
        api.eligible(first, 1)
        api.eligible(second, 2)
        reservations = list(r.planned(api, root, inventory))
        for reservation in reservations:
            r.reserve(api, reservation)
        api.create_reserved_releases.add("v0.2.1")
        writes = api.writes
        with self.assertRaisesRegex(ValueError, "v0.2.2: reserved tag"):
            list(r.planned(api, root, inventory))
        api.create_reserved_releases.add("v0.2.2")
        self.assertEqual(list(r.planned(api, root, inventory)), reservations)
        self.assertEqual(api.writes, writes)
        with patch.object(api, "pages", side_effect=ValueError("list access denied")), \
                self.assertRaisesRegex(ValueError, "list access denied"):
            r.publish_one(api, reservations[0], inventory, self.directory, fixture_build)
        self.assertEqual(api.writes, writes)

    def test_read_token_build_hint_then_authoritative_write_token_recovery(self):
        root, inventory, first, second = self.history()
        for control in ("valid", "listed_draft", "denied", "wrong_id", "wrong_tag", "tampered_bundle"):
            with self.subTest(control=control):
                shared = FakeGitHub()
                shared.eligible(first, 1)
                shared.eligible(second, 2)
                reservation = list(r.planned(shared, root, inventory))[0]
                r.reserve(shared, reservation)
                shared.request("releases", "POST", {"tag_name": "v0.2.1", "draft": True,
                                                     "prerelease": False, "body": "incomplete"})
                build_api = TokenGitHub(shared, draft_reads=False, list_drafts=control == "listed_draft")
                # Prove this fake really denies draft reads, then check the build
                # does not make that request rather than mocking it as readable.
                with self.assertRaisesRegex(ValueError, "HTTP 403"):
                    build_api.request("releases/1")
                build_api.requests.clear()
                handoff = self.directory / ("handoff-" + control)
                argv = ["release.py", "build", "--root", str(root), "--directory", str(handoff),
                        "--resume-release", "v0.2.1=1"]
                with patch.object(r, "GitHub", return_value=build_api), patch.object(sys, "argv", argv), \
                        patch.object(r, "build_exact", side_effect=lambda root, p, d: fixture_build(p, d, inventory)):
                    r.main()
                self.assertEqual(build_api.writes, 0)
                self.assertFalse(any(urlsplit(path).path.startswith("releases/")
                                     for path, _, _ in build_api.requests))
                self.assertEqual(build_api.resume_release_hints, {"v0.2.1": 1})
                self.assertNotIn("v0.2.1", build_api.release_ids or {})
                self.assertEqual(build_api.create_reserved_releases, set())
                self.assertEqual(len(json.loads((handoff / "plans.json").read_bytes())), 2)

                publish_api = TokenGitHub(shared, draft_reads=control != "denied")
                original = publish_api.request

                def request(path, method="GET", *args, **kwargs):
                    result = original(path, method, *args, **kwargs)
                    if path == "releases/1" and method == "GET":
                        if control == "wrong_id":
                            result["id"] = 2
                        elif control == "wrong_tag":
                            result["tag_name"] = "v0.2.2"
                    return result

                if control == "tampered_bundle":
                    (handoff / "bundles/v0.2.1/meter-linux-x86_64").write_bytes(b"tampered")
                argv[1] = "publish"
                with patch.object(r, "GitHub", return_value=publish_api), patch.object(sys, "argv", argv), \
                        patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REF": "refs/heads/main"}), \
                        patch.object(publish_api, "request", side_effect=request), \
                        patch.object(r, "build_exact", side_effect=AssertionError("publisher built code")):
                    if control in ("valid", "listed_draft"):
                        r.main()
                    else:
                        with self.assertRaises(ValueError):
                            r.main()
                if control in ("valid", "listed_draft"):
                    self.assertEqual(len(shared.releases), 2)
                    self.assertTrue(all(not release["draft"] and release["immutable"]
                                        for release in shared.releases))
                    # Only the second, new reservation creates a release.
                    self.assertEqual(sum(path == "releases" and method == "POST"
                                         for path, method, _ in publish_api.requests), 1)
                else:
                    self.assertEqual(publish_api.writes, 0)
                    self.assertEqual(len(shared.releases), 1)
                    self.assertTrue(shared.releases[0]["draft"])
                    self.assertEqual(shared.releases[0]["assets"], [])

    def test_read_token_completed_recovery_retry_is_idempotent(self):
        root, inventory, first, second = self.history()
        shared = FakeGitHub()
        shared.eligible(first, 1)
        shared.eligible(second, 2)
        first_plan = list(r.planned(shared, root, inventory))[0]
        r.publish_one(shared, first_plan, inventory, self.directory / "completed",
                      lambda p, d: fixture_build(p, d, inventory))
        first_release = copy.deepcopy(shared.releases[0])
        for run in ("pending-successor", "all-complete"):
            build_api = TokenGitHub(shared, draft_reads=False)
            r.resume_release(build_api, "v0.2.1=1", verify_release=False)
            handoff = self.directory / run
            with patch.object(r, "build_exact", side_effect=lambda root, p, d: fixture_build(p, d, inventory)):
                r.build_pending(build_api, root, inventory, handoff)
            self.assertEqual(build_api.writes, 0)
            plans = json.loads((handoff / "plans.json").read_bytes())
            self.assertEqual([p["release_tag"] for p in plans], ["v0.2.2"] if run == "pending-successor" else [])
            publish_api = TokenGitHub(shared, draft_reads=True)
            r.resume_release(publish_api, "v0.2.1=1")
            with patch.object(r, "build_exact", side_effect=AssertionError("publisher built code")):
                r.publish_downloaded(publish_api, root, inventory, handoff)
            self.assertEqual(shared.releases[0], first_release)
            if run == "all-complete":
                self.assertEqual(publish_api.writes, 0)
        self.assertEqual(len(shared.releases), 2)

    def test_untrusted_resume_hint_does_not_authorize_creation(self):
        api = FakeGitHub()
        r.reserve(api, plan())
        r.resume_release(api, "v0.2.1=123", verify_release=False)
        writes = api.writes
        with self.assertRaisesRegex(ValueError, "explicit recovery"):
            r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
        self.assertEqual(api.writes, writes)
        self.assertEqual(api.releases, [])

    def test_workflow_passes_same_recovery_hint_to_both_jobs(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertEqual(workflow.count("RESUME_RELEASE: ${{ inputs.resume_release }}"), 3)
        self.assertEqual(workflow.count('resume_args+=(--resume-release "$RESUME_RELEASE")'), 2)
        for command in ("build", "publish"):
            self.assertIn('release.py ' + command + ' --directory "$RUNNER_TEMP/release-build" "${resume_args[@]}"', workflow)
        self.assertIn('[[ -z "$REQUESTED_TAG" ]]', workflow)
        self.assertIn('--raw-field resume_release="$RESUME_RELEASE"', workflow)
        self.assertIn('--raw-field create_reserved_releases="$CREATE_RESERVED_RELEASES"', workflow)

    def test_recovery_rejects_bad_identity_reservation_and_conflicting_list(self):
        for identity in ("v0.2.1=0", "v0.2.1=-1", "v0.2.1=True", "v0.2.1=01",
                         "v0.2.1=1/evil", "v00.2.1=1", "v0.2.1=1\n", "v0.2.2=1"):
            with self.subTest(identity=identity):
                api = FakeGitHub()
                r.reserve(api, plan())
                api.request("releases", "POST", {"tag_name": "v0.2.1", "draft": True})
                writes = api.writes
                with self.assertRaises(ValueError):
                    r.resume_release(api, identity)
                self.assertEqual(api.writes, writes)
        api = FakeGitHub()
        api.request("releases", "POST", {"tag_name": "v0.2.1", "draft": True})
        with self.assertRaisesRegex(ValueError, "recovery tag reservation conflict"):
            r.resume_release(api, "v0.2.1=1")
        r.reserve(api, plan())
        r.resume_release(api, "v0.2.1=1")
        api.releases[0]["id"] = 2
        with self.assertRaisesRegex(ValueError, "conflicting release identity"):
            r.release_for(api, "v0.2.2")

    def test_existing_reservation_release_requests_omit_commit_target(self):
        api = FakeGitHub()
        reservation = plan()
        r.reserve(api, reservation)
        api.create_reserved_releases.add("v0.2.1")
        refs = copy.deepcopy(api.refs)
        objects = copy.deepcopy(api.objects)
        api.requests.clear()
        with patch.object(api, "request", wraps=api.request) as request:
            self.assertEqual(r.publish_one(api, reservation, INVENTORY, self.directory, fixture_build), "complete")
        mutations = [call for call in request.call_args_list
                     if len(call.args) > 1 and call.args[1] in ("POST", "PATCH")]
        draft = [call.args[2] for call in mutations if call.args[:2] == ("releases", "POST")]
        self.assertEqual(draft, [{"tag_name": "v0.2.1", "name": "v0.2.1", "body": "incomplete",
                                 "draft": True, "prerelease": False}])
        for call in mutations:
            if len(call.args) > 2:
                self.assertNotIn("target_commitish", call.args[2])
        self.assertFalse(any(path.startswith("git/") and method != "GET"
                             for path, method, _ in api.requests))
        self.assertEqual(api.refs, refs)
        self.assertEqual(api.objects, objects)

    def test_changed_reservation_fails_closed_at_release_boundaries(self):
        for boundary in ("draft", "publication"):
            for change in ("missing", "lightweight", "wrong_sha", "wrong_plan", "missing_reservation"):
                with self.subTest(boundary=boundary, change=change):
                    api = FakeGitHub()
                    reservation = plan()
                    r.reserve(api, reservation)
                    api.create_reserved_releases.add("v0.2.1")
                    writes_after_change = []

                    def change_tag():
                        ref = "refs/tags/" + reservation["release_tag"]
                        if change == "missing":
                            del api.refs[ref]
                        elif change == "lightweight":
                            api.refs[ref]["object"] = {"sha": SHA, "type": "commit"}
                        else:
                            # A replacement immutable object must bypass the tag-object cache.
                            obj = copy.deepcopy(api.objects[api.refs[ref]["object"]["sha"]])
                            if change == "wrong_sha":
                                obj["object"]["sha"] = "b" * 40
                            elif change == "wrong_plan":
                                obj["message"] = r.canonical({**reservation, "ci_attempt": 2}).decode()
                            else:
                                obj["message"] = "no reservation evidence"
                            api.objects["c" * 40] = obj
                            api.refs[ref]["object"]["sha"] = "c" * 40
                        writes_after_change.append(api.writes)

                    def builder(reservation, output):
                        fixture_build(reservation, output)
                        if boundary == "draft":
                            change_tag()

                    original = api.request

                    def request(path, method="GET", *args, **kwargs):
                        result = original(path, method, *args, **kwargs)
                        if boundary == "publication" and method == "POST" and len(api.uploaded) == 7:
                            change_tag()
                        return result

                    with patch.object(api, "request", side_effect=request):
                        with self.assertRaisesRegex(ValueError, boundary + " tag reservation conflict"):
                            r.publish_one(api, reservation, INVENTORY, self.directory, builder)
                    self.assertEqual(len(writes_after_change), 1)
                    self.assertEqual(api.writes, writes_after_change[0])
                    self.assertFalse(any(method == "PATCH" for _, method, _ in api.requests))
                    if boundary == "draft":
                        self.assertEqual(api.releases, [])
                    else:
                        self.assertTrue(api.releases[0]["draft"])

    def test_conflicting_assets_and_tags_stop(self):
        api = FakeGitHub()
        api.crash_at, api.crash_after = 4, True
        with self.assertRaises(OSError):
            r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
        api.crash_at = None
        api.blobs[1] = b"conflicting immutable content"
        with self.assertRaisesRegex(ValueError, "immutable asset conflict"):
            r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
        self.assertTrue(api.releases[0]["draft"])
        with self.assertRaisesRegex(ValueError, "reservation conflict"):
            r.reserve(api, plan("b" * 40))
        with self.assertRaisesRegex(ValueError, "already reserved"):
            r.reserve(api, plan(tag="v0.2.2"))
        api.refs["refs/tags/v0.2.2"] = {**api.refs["refs/tags/v0.2.1"], "ref": "refs/tags/v0.2.2"}
        with self.assertRaisesRegex(ValueError, "conflicting tags"):
            api.tags()

    def test_enforced_publication_without_policy_reads_and_nonpaginated_refs(self):
        api = FakeGitHub()  # Any policy endpoint is an unexpected request.
        self.assertEqual(r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build), "complete")
        self.assertTrue(api.releases[0]["immutable"])
        self.assertFalse(any(path == "immutable-releases" for path, _, _ in api.requests))
        for i in range(100):
            tag = f"v1.0.{i}"
            api.refs["refs/tags/" + tag] = {"ref": "refs/tags/" + tag,
                "object": {"sha": f"{i + 1000:040x}", "type": "commit"}}
        self.assertEqual(len(api.tags()), 101)

    def test_disabled_enforcement_fails_after_publication_without_repair(self):
        api = FakeGitHub()
        api.published_immutable = False
        with self.assertRaisesRegex(ValueError, "non-immutable publication"):
            r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
        self.assertFalse(api.releases[0]["draft"])  # Cannot prevent or undo publication.
        self.assertFalse(api.releases[0]["immutable"])
        writes = api.writes
        with self.assertRaisesRegex(ValueError, "non-immutable publication"):
            r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
        self.assertEqual(api.writes, writes)
        self.assertFalse(any(path == "immutable-releases" for path, _, _ in api.requests))

    def test_pr_api_contract_preserves_exact_merge_guard(self):
        api = FakeGitHub()
        api.eligible(SHA, 1)
        self.assertNotIn("merge_commit_sha", api.request("pulls/1"))
        api.requests.clear()
        self.assertEqual(api.evidence(SHA, INVENTORY)["pull_request"], 1)
        for path, method, api_version in api.requests:
            self.assertEqual(method, "GET")
            self.assertEqual(api_version, "2022-11-28" if path.startswith(("commits/", "pulls/"))
                             else "2026-03-10")
        # Association alone is not approval; the detail must independently match.
        original = api.request
        for field, value in (("merge_commit_sha", "b" * 40), ("merge_commit_sha", None),
                             ("merged", False), ("merged_at", None),
                             ("base", {"ref": "main", "repo": {"full_name": "other/repo"}})):
            def changed_detail(path, *args, **kwargs):
                result = original(path, *args, **kwargs)
                if path == "pulls/1":
                    result[field] = value
                return result
            with self.subTest(field=field, value=value), patch.object(api, "request", side_effect=changed_detail):
                with self.assertRaisesRegex(ValueError, "merged-PR"):
                    api.evidence(SHA, INVENTORY)
        api.eligible(SHA, 2)
        with self.assertRaisesRegex(ValueError, "merged-PR"):
            api.evidence(SHA, INVENTORY)
        self.assertEqual(api.writes, 0)

    def test_api_version_headers_and_pagination(self):
        api = r.GitHub()
        response = subprocess.CompletedProcess([], 0, stdout=b"[]", stderr=b"")
        with patch.object(subprocess, "run", return_value=response) as request:
            api.request("pulls/1", api_version=r.PR_API_VERSION)
            self.assertIn("X-GitHub-Api-Version: 2022-11-28", request.call_args.args[0])
            api.request("releases")
            self.assertIn("X-GitHub-Api-Version: 2026-03-10", request.call_args.args[0])
        with patch.object(api, "request", side_effect=[[{}] * 100, []]) as request:
            self.assertEqual(len(api.pages(f"commits/{SHA}/pulls", api_version=r.PR_API_VERSION)), 100)
            self.assertEqual(request.call_count, 2)
            for call in request.call_args_list:
                self.assertEqual(call.kwargs["api_version"], "2022-11-28")
        with patch.object(r.urllib.request, "urlopen") as request:
            request.return_value.__enter__.return_value.read.return_value = b"[]"
            r.GitHub(anonymous=True).request("releases")
            self.assertEqual(request.call_args.args[0].get_header("X-github-api-version"), "2026-03-10")

    def test_binary_download_media_types(self):
        raw = b"PK\x03\x04\xffartifact bytes"
        for path, accept in (("actions/artifacts/123/zip", "application/vnd.github+json"),
                             ("releases/assets/456", "application/octet-stream")):
            def download(args, **kwargs):
                valid = f"Accept: {accept}" in args
                return subprocess.CompletedProcess(args, 0 if valid else 1,
                                                   stdout=raw if valid else b"",
                                                   stderr=b"" if valid else b"Unsupported Accept header (HTTP 415)")

            with self.subTest(path=path), patch.object(subprocess, "run", side_effect=download):
                self.assertEqual(r.GitHub().request(path, binary=True), raw)
            with self.subTest(path=path, anonymous=True), patch.object(r.urllib.request, "urlopen") as request:
                request.return_value.__enter__.return_value.read.return_value = raw
                self.assertEqual(r.GitHub(anonymous=True).request(path, binary=True), raw)
                self.assertEqual(request.call_args.args[0].get_header("Accept"), accept)

    def test_only_authenticated_reads_retry_transient_server_errors(self):
        ok = subprocess.CompletedProcess([], 0, stdout=b'{"jobs": []}', stderr=b"")

        def failure(status):
            return subprocess.CompletedProcess([], 1, stdout=b"", stderr=f"gh: error (HTTP {status})".encode())

        upload = self.directory / "asset"
        upload.write_bytes(b"asset")
        path = "actions/runs/40067773473/attempts/1/jobs"
        for name, kwargs, responses, calls in (
                ("get-502-then-ok", {}, [failure(502), ok], 2),
                ("get-502-persistent", {}, [failure(502)] * 4, 3),
                ("get-503-then-500", {}, [failure(503), failure(500), failure(502), ok], 3),
                ("get-403", {}, [failure(403), ok], 1),
                ("get-404", {}, [failure(404), ok], 1),
                ("post-502", {"method": "POST", "data": {"tag": "v0.2.1"}}, [failure(502), ok], 1),
                ("upload-502", {"method": "POST", "upload": upload}, [failure(502), ok], 1)):
            with self.subTest(name), patch.object(subprocess, "run", side_effect=responses) as request, \
                    patch.object(r.time, "sleep") as sleep:
                if responses[calls - 1] is ok:
                    self.assertEqual(r.GitHub().request(path, **kwargs), {"jobs": []})
                else:
                    with self.assertRaisesRegex(ValueError, "inspect remote state before retry"):
                        r.GitHub().request(path, **kwargs)
                self.assertEqual(request.call_count, calls)
                self.assertEqual(sleep.call_count, calls - 1)

    def test_exact_merge_and_ci_evidence(self):
        api = FakeGitHub()
        api.eligible(SHA, 1, "minor")
        self.assertEqual(api.evidence(SHA, INVENTORY)["bump"], "minor")
        for field, value in (("head_sha", "b" * 40), ("status", "unknown"),
                             ("conclusion", "cancelled"), ("conclusion", "failure"),
                             ("event", "pull_request"), ("head_branch", "feature"), ("path", "other.yml")):
            saved = api.runs[1][field]
            api.runs[1][field] = value
            with self.assertRaisesRegex(ValueError, "CI"):
                api.evidence(SHA, INVENTORY)
            api.runs[1][field] = saved
        api.jobs[1][0]["conclusion"] = "skipped"
        with self.assertRaisesRegex(ValueError, "required CI job rust"):
            api.evidence(SHA, INVENTORY)
        api.prs[1]["base"]["ref"] = "feature"
        with self.assertRaisesRegex(ValueError, "merged-PR"):
            api.evidence(SHA, INVENTORY)

    def history(self):
        root = self.directory / "repo"
        root.mkdir()
        run(root, "git", "init", "-q")
        (root / "VERSION").write_text("0.2.0\n")
        commit(root, "baseline")
        baseline = r.git(root, "rev-parse", "HEAD")
        inventory = {**INVENTORY, "activation_baseline": baseline}
        (root / "deploy").mkdir()
        (root / "deploy/components.json").write_bytes(r.canonical(inventory))
        commit(root, "first merge")
        first = r.git(root, "rev-parse", "HEAD")
        (root / "another").write_text("second merge")
        commit(root, "second merge")
        second = r.git(root, "rev-parse", "HEAD")
        run(root, "git", "update-ref", "refs/remotes/origin/main", second)
        return root, inventory, first, second

    def test_moved_baseline_skips_unreleased_history_and_keeps_existing_tags(self):
        root, old, first, second = self.history()
        api = FakeGitHub()
        api.eligible(first, 1)
        api.eligible(second, 2)
        api.runs[2]["conclusion"] = "cancelled"
        # Under the old baseline, a cancelled exact-SHA CI run blocks everything after it.
        with self.assertRaisesRegex(ValueError, "inspect/rerun CI run 2"):
            list(r.planned(api, root, old))
        r.reserve(api, plan(first, "v0.2.3"))  # An existing release tag before the move.
        moved = {**old, "activation_baseline": second}
        (root / "deploy/components.json").write_bytes(r.canonical(moved))
        commit(root, "move baseline")
        third = r.git(root, "rev-parse", "HEAD")
        run(root, "git", "update-ref", "refs/remotes/origin/main", third)
        api.eligible(third, 3)
        writes, tags = api.writes, api.tags()
        plans = list(r.planned(api, root, moved))
        self.assertEqual([(p["source_sha"], p["release_tag"], p["pull_request"]) for p in plans],
                         [(third, "v0.2.4", 3)])
        self.assertEqual((api.writes, api.tags()), (writes, tags))
        # A later merge still carrying the old baseline fails closed rather than skipping.
        (root / "deploy/components.json").write_bytes(r.canonical(old))
        commit(root, "stale baseline")
        run(root, "git", "update-ref", "refs/remotes/origin/main", r.git(root, "rev-parse", "HEAD"))
        with self.assertRaisesRegex(ValueError, "activation baseline changed"):
            list(r.planned(api, root, moved))

    def test_pending_ci_is_a_clean_wait(self):
        root, inventory, first, second = self.history()
        for reserved in (False, True):
            api = FakeGitHub()
            api.eligible(first, 1)
            api.eligible(second, 2)
            if reserved:
                r.reserve(api, plan(first))
            writes = api.writes
            # A newer pending run must hide the older successful run.
            api.runs[3] = {**api.runs[1], "id": 3, "conclusion": None}
            for status in ("queued", "in_progress", "waiting", "requested", "pending"):
                with self.subTest(reserved=reserved, status=status):
                    api.runs[3]["status"] = status
                    output = self.directory / f"wait-{reserved}-{status}"
                    message = io.StringIO()
                    with patch.object(r, "GitHub", return_value=api), redirect_stderr(message), \
                            patch.object(r, "build_exact", side_effect=AssertionError("pending CI built")), \
                            patch.object(sys, "argv", ["release.py", "build", "--root", str(root), "--directory", str(output)]):
                        self.assertIsNone(r.main())  # Normal CLI return means exit 0.
                    self.assertEqual(message.getvalue().strip(), f"waiting for CI on {first} run 3")
                    self.assertEqual(json.loads((output / "plans.json").read_bytes()), [])
                    self.assertFalse((output / "bundles").exists())
                    self.assertEqual(api.writes, writes)
            for conclusion in ("cancelled", "failure"):
                api.runs[3].update(status="completed", conclusion=conclusion)
                with self.assertRaisesRegex(ValueError, "inspect/rerun CI run 3"):
                    list(r.planned(api, root, inventory))
            api.runs[3].update(status="queued", event="pull_request")
            with self.assertRaisesRegex(ValueError, "mismatched CI evidence"):
                list(r.planned(api, root, inventory))
            api.runs.clear()
            with self.assertRaisesRegex(ValueError, "CI not found"):
                list(r.planned(api, root, inventory))
            self.assertEqual(api.writes, writes)

    def test_publish_downloaded_never_builds_and_validates_before_writes(self):
        root, inventory, first, second = self.history()
        api = FakeGitHub()
        api.eligible(first, 1)
        api.eligible(second, 2, "minor")
        handoff = self.directory / "handoff"
        with patch.object(r, "build_exact", side_effect=lambda root, p, d: fixture_build(p, d, inventory)):
            r.build_pending(api, root, inventory, handoff)
        self.assertEqual(api.writes, 0)
        plans_path = handoff / "plans.json"
        plans = json.loads(plans_path.read_bytes())
        self.assertEqual([(p["source_sha"], p["release_tag"]) for p in plans], [(first, "v0.2.1"), (second, "v0.3.0")])
        argv = ["release.py", "publish", "--root", str(root), "--directory", str(handoff)]
        output = self.directory / "github-output"
        original_run = subprocess.run

        def only_git_reads(args, *positional, **kwargs):
            self.assertEqual(args[0], "git", "publisher attempted a subprocess build")
            return original_run(args, *positional, **kwargs)

        with patch.object(r, "GitHub", return_value=api), patch.object(sys, "argv", argv), \
                patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REF": "refs/heads/main",
                                        "GITHUB_OUTPUT": str(output)}), \
                patch.object(r, "build_exact", side_effect=AssertionError("publisher invoked build_exact")), \
                patch.object(subprocess, "run", side_effect=only_git_reads), redirect_stdout(io.StringIO()):
            changed = copy.deepcopy(plans)
            changed[1]["release_tag"] = "v9.0.0"
            plans_path.write_bytes(r.canonical(changed))
            with self.assertRaisesRegex(ValueError, "downloaded plans differ"):
                r.main()
            plans_path.write_bytes(r.canonical(plans))
            self.assertEqual(api.writes, 0)
            # Validate the entire batch before reserving even the first release.
            bundle = handoff / "bundles/v0.3.0"
            for name, error in (("manifest.json", "bundle plan mismatch"), ("meter-linux-x86_64", "checksum mismatch")):
                path = bundle / name
                original = path.read_bytes()
                if name == "manifest.json":
                    manifest = json.loads(original)
                    manifest["evidence"]["ci_run"] += 1
                    path.write_bytes(r.canonical(manifest))
                else:
                    path.write_bytes(original + b"tamper")
                with self.assertRaisesRegex(ValueError, error):
                    r.main()
                self.assertEqual(api.writes, 0)
                path.write_bytes(original)
            api.prs[2]["labels"] = [{"name": "bump:major"}]
            with self.assertRaisesRegex(ValueError, "downloaded plans differ"):
                r.main()
            api.prs[2]["labels"] = [{"name": "bump:minor"}]
            # A rerun starting during the build is a wait, not a stale publication.
            api.runs[1]["status"] = "queued"
            with redirect_stderr(io.StringIO()) as message:
                self.assertIsNone(r.main())
            self.assertIn(f"waiting for CI on {first} run 1", message.getvalue())
            self.assertEqual(api.writes, 0)
            self.assertFalse(output.exists(), "pending CI must not queue a continuation")
            api.runs[1]["status"] = "completed"
            api.crash_at, api.crash_after = 4, True
            with self.assertRaises(OSError):
                r.main()
            self.assertFalse(output.exists(), "failed publication must not queue a continuation")
            api.crash_at = None
            self.assertIsNone(r.main())
            self.assertEqual(output.read_text(), "published=true\n")
            self.assertEqual([release["tag_name"] for release in api.releases], ["v0.2.1", "v0.3.0"])
            self.assertEqual(len(api.uploaded), len(set(api.uploaded)))
            for p in plans:
                r.verify_bundle(handoff / "bundles" / p["release_tag"], inventory, p["source_sha"],
                                r.release_for(api, p["release_tag"]))

    def test_backlog_publishes_in_batches_without_skipping_a_failed_boundary(self):
        root, inventory, first, second = self.history()
        shas = [first, second]
        for number in range(3, 9):
            (root / "another").write_text(f"merge {number}")
            commit(root, f"merge {number}")
            shas.append(r.git(root, "rev-parse", "HEAD"))
        run(root, "git", "update-ref", "refs/remotes/origin/main", shas[-1])
        api = FakeGitHub()
        for number, sha in enumerate(shas, 1):
            api.eligible(sha, number)
        api.runs[6]["conclusion"] = "failure"
        first_batch = self.directory / "batch-1"
        with patch.object(r, "build_exact", side_effect=lambda root, p, d: fixture_build(p, d, inventory)):
            r.build_pending(api, root, inventory, first_batch)
        plans_path = first_batch / "plans.json"
        plans = json.loads(plans_path.read_bytes())
        self.assertEqual([(p["source_sha"], p["release_tag"]) for p in plans],
                         list(zip(shas[:5], ["v0.2.1", "v0.2.2", "v0.2.3", "v0.2.4", "v0.2.5"])))
        self.assertEqual(api.writes, 0)
        plans_path.write_bytes(r.canonical(plans + [plan(shas[5], "v0.2.6")]))
        with self.assertRaisesRegex(ValueError, "batch limit"):
            r.publish_downloaded(api, root, inventory, first_batch)
        self.assertEqual(api.writes, 0)
        plans_path.write_bytes(r.canonical(plans))
        with redirect_stdout(io.StringIO()):
            self.assertTrue(r.publish_downloaded(api, root, inventory, first_batch))
        self.assertEqual([release["tag_name"] for release in api.releases],
                         ["v0.2.1", "v0.2.2", "v0.2.3", "v0.2.4", "v0.2.5"])
        writes = api.writes
        with self.assertRaisesRegex(ValueError, "inspect/rerun CI run 6"):
            r.build_pending(api, root, inventory, self.directory / "blocked")
        self.assertEqual(api.writes, writes)
        api.runs[6]["conclusion"] = "success"
        second_batch = self.directory / "batch-2"
        with patch.object(r, "build_exact", side_effect=lambda root, p, d: fixture_build(p, d, inventory)):
            r.build_pending(api, root, inventory, second_batch)
        self.assertEqual([p["source_sha"] for p in json.loads((second_batch / "plans.json").read_bytes())], shas[5:])
        with redirect_stdout(io.StringIO()):
            self.assertTrue(r.publish_downloaded(api, root, inventory, second_batch))
        self.assertEqual([release["tag_name"] for release in api.releases],
                         ["v0.2.1", "v0.2.2", "v0.2.3", "v0.2.4", "v0.2.5", "v0.2.6", "v0.2.7", "v0.2.8"])
        self.assertTrue(all(not release["draft"] and release["immutable"] for release in api.releases))
        empty = self.directory / "drained"
        r.build_pending(api, root, inventory, empty)
        self.assertEqual(json.loads((empty / "plans.json").read_bytes()), [])
        self.assertFalse((empty / "bundles").exists())
        output = self.directory / "empty-output"
        argv = ["release.py", "publish", "--root", str(root), "--directory", str(empty)]
        with patch.object(r, "GitHub", return_value=api), patch.object(sys, "argv", argv), \
                patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REF": "refs/heads/main",
                                        "GITHUB_OUTPUT": str(output)}):
            r.main()
        self.assertFalse(output.exists(), "drained history must stop automatic continuation")

    def test_advancing_history_publishes_downloaded_prefix_then_next_run_reconciles(self):
        root, inventory, first, second = self.history()
        api = FakeGitHub()
        api.eligible(first, 1)
        api.eligible(second, 2)
        handoff = self.directory / "handoff"
        with patch.object(r, "build_exact", side_effect=lambda root, p, d: fixture_build(p, d, inventory)):
            r.build_pending(api, root, inventory, handoff)
        plans_path = handoff / "plans.json"
        plans = json.loads(plans_path.read_bytes())
        self.assertEqual([(p["source_sha"], p["release_tag"]) for p in plans], [(first, "v0.2.1"), (second, "v0.2.2")])
        # An eligible merge lands on main while the build runs.
        (root / "third").write_text("third merge")
        commit(root, "third merge")
        third = r.git(root, "rev-parse", "HEAD")
        run(root, "git", "update-ref", "refs/remotes/origin/main", third)
        api.eligible(third, 3)
        current = list(r.planned(api, root, inventory))
        self.assertEqual(current[:2], plans)
        self.assertEqual([(p["source_sha"], p["release_tag"]) for p in current[2:]], [(third, "v0.2.3")])

        def publish(github, directory=handoff):
            argv = ["release.py", "publish", "--root", str(root), "--directory", str(directory)]
            with patch.object(r, "GitHub", return_value=github), patch.object(sys, "argv", argv), \
                    patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REF": "refs/heads/main"}), \
                    patch.object(r, "build_exact", side_effect=AssertionError("publisher built code")), \
                    redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as message:
                r.main()
            return message.getvalue()

        # Negative controls: a changed plan inside the prefix or an extra plan never writes.
        for field, value in (("release_tag", "v0.2.9"), ("bump", "minor"), ("ci_run", 9)):
            changed = copy.deepcopy(plans)
            changed[1][field] = value
            plans_path.write_bytes(r.canonical(changed))
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "downloaded plans differ"):
                publish(api)
            self.assertEqual(api.writes, 0)
        plans_path.write_bytes(r.canonical(current + [plan("e" * 40, "v0.2.4")]))
        with self.assertRaisesRegex(ValueError, "downloaded plans differ"):
            publish(api)
        self.assertEqual(api.writes, 0)
        plans_path.write_bytes(r.canonical(plans))
        # Current reconciliation starting later because the first release completed.
        partial = copy.deepcopy(api)
        r.publish_one(partial, plans[0], inventory, self.directory / "partial",
                      lambda p, d: fixture_build(p, d, inventory))
        retry = TokenGitHub(partial, draft_reads=True)
        with self.assertRaisesRegex(ValueError, "downloaded plans differ"):
            publish(retry)
        self.assertEqual(retry.writes, 0)
        binary = handoff / "bundles/v0.2.2/meter-linux-x86_64"
        original = binary.read_bytes()
        binary.write_bytes(original + b"tamper")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            publish(api)
        self.assertEqual(api.writes, 0)
        binary.write_bytes(original)

        self.assertIn("1 newer plans remain for the next run", publish(api))
        self.assertEqual([(x["tag_name"], x["draft"]) for x in api.releases], [("v0.2.1", False), ("v0.2.2", False)])
        self.assertEqual({tag for tag, _ in api.uploaded}, {"v0.2.1", "v0.2.2"})
        self.assertEqual({tag: value["sha"] for tag, value in api.tags().items()},
                         {"v0.2.1": first, "v0.2.2": second})
        remaining = list(r.planned(api, root, inventory))
        self.assertEqual(remaining, current[2:])
        # The queued run builds and publishes only the newer SHA, matching exactly.
        successor = self.directory / "successor"
        with patch.object(r, "build_exact", side_effect=lambda root, p, d: fixture_build(p, d, inventory)):
            r.build_pending(api, root, inventory, successor)
        self.assertEqual(json.loads((successor / "plans.json").read_bytes()), remaining)
        self.assertNotIn("newer plans remain", publish(api, successor))
        self.assertEqual({tag: value["sha"] for tag, value in api.tags().items()},
                         {"v0.2.1": first, "v0.2.2": second, "v0.2.3": third})
        self.assertTrue(all(not release["draft"] and release["immutable"] for release in api.releases))
        self.assertEqual(list(r.planned(api, root, inventory)), [])

    def test_adjacent_merges_missed_trigger_and_failed_tail(self):
        root, inventory, first, second = self.history()
        api = FakeGitHub()
        api.eligible(first, 1)
        api.eligible(second, 2, "minor")
        api.runs[2]["conclusion"] = "failure"
        generator = r.planned(api, root, inventory)
        first_plan = next(generator)
        r.publish_one(api, first_plan, inventory, self.directory / "first",
                      lambda p, d: fixture_build(p, d, inventory))
        with self.assertRaisesRegex(ValueError, "check-failed"):
            next(generator)
        self.assertEqual(len(api.releases), 1)
        api.runs[2]["conclusion"] = "success"
        plans = list(r.planned(api, root, inventory))
        self.assertEqual([(p["source_sha"], p["release_tag"]) for p in plans], [(second, "v0.3.0")])
        for p in plans:
            r.publish_one(api, p, inventory, self.directory / p["release_tag"],
                          lambda p, d: fixture_build(p, d, inventory))
        self.assertEqual([x["tag_name"] for x in api.releases], ["v0.2.1", "v0.3.0"])
        # Completed release verification does not depend on expired CI history.
        api.runs.clear()
        self.assertEqual(list(r.planned(api, root, inventory)), [])

    def test_consumer_roundtrip_and_rejections(self):
        api = FakeGitHub()
        r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
        publication = r.release_for(api, "v0.2.1")
        manifest = r.verify_bundle(self.directory, INVENTORY, SHA, publication)
        with self.assertRaisesRegex(ValueError, "wrong source SHA"):
            r.verify_bundle(self.directory, INVENTORY, "b" * 40, publication)
        for changes in ({"draft": True}, {"immutable": False}, {"assets": publication["assets"][:-1]}):
            with self.assertRaises(ValueError):
                r.verify_bundle(self.directory, INVENTORY, SHA, {**publication, **changes})
        binary = self.directory / "meter-linux-x86_64"
        original = binary.read_bytes()
        binary.write_bytes(original + b"tampering")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            r.verify_bundle(self.directory, INVENTORY, SHA, publication)
        binary.unlink()
        with self.assertRaisesRegex(ValueError, "missing artifact"):
            r.verify_bundle(self.directory, INVENTORY, SHA, publication)
        binary.write_bytes(original)
        truncated = copy.deepcopy(manifest)
        truncated["inventory"]["components"].pop()
        with self.assertRaisesRegex(ValueError, "inventory"):
            r.validate_manifest(truncated, INVENTORY, SHA)
        truncated["inventory"] = INVENTORY
        truncated["artifacts"][0]["name"] = "../escape"
        with self.assertRaises(ValueError):
            r.validate_manifest(truncated, INVENTORY, SHA)
        invalid = copy.deepcopy(manifest)
        invalid["source_version"] = "0.0.0"
        with self.assertRaisesRegex(ValueError, "evidence"):
            r.validate_manifest(invalid, INVENTORY, SHA)
        scripts = r.archive_entries((self.directory / "deployment.tar.gz").read_bytes())
        del scripts["deploy/rollback-kiosk.sh"]
        r.make_archive(self.directory / "deployment.tar.gz", {name: (data, False) for name, data in scripts.items()})
        invalid = copy.deepcopy(manifest)
        for artifact in invalid["artifacts"]:
            if artifact["name"] == "deployment.tar.gz":
                data = (self.directory / artifact["name"]).read_bytes()
                artifact.update(size=len(data), sha256=r.digest(data))
        (self.directory / "manifest.json").write_bytes(r.canonical(invalid))
        with self.assertRaisesRegex(ValueError, "truncated deployment"):
            r.verify_bundle(self.directory, INVENTORY, SHA)
        for name, kind in (("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                           ("ok", tarfile.SYMTYPE), ("ok", tarfile.LNKTYPE), ("ok", tarfile.CHRTYPE)):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode="w:gz") as archive:
                member = tarfile.TarInfo(name)
                member.type = kind
                archive.addfile(member, io.BytesIO(b""))
            with self.assertRaises(ValueError):
                r.archive_entries(data.getvalue())
        ups = next(c for c in manifest["inventory"]["components"] if c["id"] == "ups-control")
        self.assertEqual(ups["eligibility"], "ineligible")
        self.assertEqual(manifest["inventory"]["enabled_auto_deploy"], [])


def run(root, *args, env=None, check=True):
    return subprocess.run(args, cwd=root, env=env, check=check, text=True, capture_output=True)


def commit(root, message):
    run(root, "git", "add", ".")
    run(root, "git", "-c", "user.name=Release fixture", "-c", "user.email=fixture@example.invalid",
        "commit", "-qm", message)


class ReproducibleManifest(unittest.TestCase):
    """Real package() over a stub source tree; only meter/API health is faked."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = root = Path(self.temp.name) / "source"
        for name in INVENTORY["required_files"]:
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text("fixture; never execute\n")
        (root / "deploy/components.json").write_bytes(r.canonical(INVENTORY))
        (root / "scripts/build-fingerprint.sh").write_text("printf '123456abcdef\\n'\n")
        (root / "kiosk/scripts").mkdir(parents=True)
        (root / "kiosk/scripts/build-info.ts").write_text(
            'import { execFileSync } from "node:child_process";\n'
            'export function buildInfo() {\n'
            '  const git_sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();\n'
            '  return { version: "0.2.1", git_sha, git_dirty: false, built_at_ms: 1792000000000,\n'
            '           inputs_fingerprint: "123456abcdef" };\n}\n')
        (root / "VERSION").write_text("0.2.0\n")
        (root / ".gitignore").write_text(".sandbox/\nkiosk/dist/\ntarget/\n")
        run(root, "git", "init", "-q")
        commit(root, "fixture release source")
        self.sha = r.git(root, "rev-parse", "HEAD")
        (root / ".sandbox").mkdir()
        (root / ".sandbox/ports.json").write_text('{"meter": 1, "factory-api": 2}')
        (root / "kiosk/dist/assets").mkdir(parents=True)
        (root / "kiosk/dist/index.html").write_text("fixture kiosk")
        (root / "kiosk/dist/version.json").write_text('{"build":"fixture"}')
        (root / "kiosk/dist/assets/index.js").write_text(
            f'const b={{version:"0.2.1",git_sha:"{self.sha}",inputs_fingerprint:"123456abcdef",git_dirty:!1}};')
        (root / "target/release").mkdir(parents=True)
        for binary in ("meter", "factory-api", "pricing", "factory-ups-control"):
            (root / "target/release" / binary).write_bytes(b"fixture binary " + binary.encode())

    def health(self, clock, meter_openapi="0123456789ab"):
        """Health as served: stable build fields plus live readings that move with `clock`."""
        build = {"status": "ok", "version": "0.2.1", "git_sha": self.sha, "git_dirty": False,
                 "built_at_ms": 1792000000000, "inputs_fingerprint": "123456abcdef"}
        return {
            "meter": {**build, "openapi_sha256": meter_openapi, "queue_depth": clock % 7,
                      "maintenance": {"status": "ok", "checked_at_ms": 1793000000000 + clock}},
            "factory-api": {**build, "openapi_sha256": "abcdef012345", "meter_openapi_expected": meter_openapi,
                            "meter_openapi_sha256": meter_openapi, "uptime_ms": clock,
                            "maintenance": {"checked_at_ms": 1793000000000 + clock},
                            "retention": {"status": "ok", "checked_at_ms": 1793000000000 + clock,
                                          "cutoff_ms": 1761000000000 + clock,
                                          "pruned_at_ms": 1793000000000 + clock, "pruned_rows": 0}}}

    def package(self, reservation, output, health):
        def urlopen(url, timeout):
            return io.BytesIO(json.dumps(health["meter" if "/meter/" in url else "factory-api"]).encode())
        output.mkdir(parents=True, exist_ok=True)
        with patch.object(r.urllib.request, "urlopen", side_effect=urlopen):
            r.package(self.root, output, reservation)
        return (output / "manifest.json").read_bytes()

    def test_same_inputs_with_different_clocks_and_uptimes_build_byte_identical_manifest(self):
        out = Path(self.temp.name)
        first = self.package(plan(self.sha), out / "first", self.health(601))
        second = self.package(plan(self.sha), out / "second", self.health(617))
        self.assertEqual(first, second)
        identity = json.loads(first)["build_identity"]
        self.assertEqual(identity["factory-api"]["openapi_sha256"], "abcdef012345")
        for component in ("meter", "factory-api"):
            self.assertLessEqual(set(identity[component]), r.IDENTITY_FIELDS)
        # Control: a stable field (served contract hash) still changes the manifest.
        changed = self.package(plan(self.sha), out / "changed", self.health(601, "ba9876543210"))
        self.assertNotEqual(first, changed)

    def test_resume_partial_draft_with_manifest_and_some_binaries_uploads_only_missing(self):
        out = Path(self.temp.name)
        for case in ("rebuild", "changed_manifest"):
            with self.subTest(case=case):
                reservation = plan(self.sha)
                api = FakeGitHub()
                r.reserve(api, reservation)
                api.request("releases", "POST", {"tag_name": "v0.2.1", "draft": True, "prerelease": False})
                interrupted = out / case / "interrupted"
                self.package(reservation, interrupted, self.health(601))
                partial = ["manifest.json", "factory-api-linux-x86_64", "kiosk.tar.gz", "meter-linux-x86_64"]
                for name in partial:
                    api.request(f"releases/1/assets?name={name}", "POST", upload=interrupted / name)
                r.resume_release(api, "v0.2.1=1")
                api.uploaded.clear()
                rebuilt = self.health(617) if case == "rebuild" else self.health(617, "ba9876543210")
                builder = lambda p, d: self.package(p, d, rebuilt)
                if case == "rebuild":
                    self.assertEqual(r.publish_one(api, reservation, INVENTORY, out / case / "resume", builder),
                                     "complete")
                    self.assertEqual(sorted(n for _, n in api.uploaded), sorted(r.ASSETS - set(partial)))
                    self.assertFalse(api.releases[0]["draft"])
                    self.assertEqual(api.releases[0]["body"],
                                     "factory-release-v1:" + r.digest((interrupted / "manifest.json").read_bytes()))
                else:
                    writes = api.writes
                    with self.assertRaisesRegex(ValueError, "immutable asset conflict: v0.2.1/manifest.json"):
                        r.publish_one(api, reservation, INVENTORY, out / case / "resume", builder)
                    self.assertEqual((api.writes, api.uploaded), (writes, []))
                    self.assertTrue(api.releases[0]["draft"])


class RunnerProvisioning(unittest.TestCase):
    def test_historical_sandbox_gets_system_bubblewrap_before_build(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        build, publish = workflow.split("\n  publish:\n", 1)
        publish, continuation = publish.split("\n  continue:\n", 1)
        install = "sudo apt-get install --no-install-recommends -y bubblewrap"
        probe = "env -i PATH=/usr/bin:/bin bwrap --unshare-net --ro-bind / / true"
        self.assertIn("runs-on: ubuntu-22.04", build)
        self.assertIn("sudo apt-get update", build)
        self.assertIn(install, build)
        self.assertIn(probe, build)
        self.assertLess(build.index("sudo apt-get update"), build.index(install))
        self.assertLess(build.index(install), build.index(probe))
        self.assertLess(build.index(probe), build.index("release-target-v2-"))
        self.assertLess(build.index("release-target-v2-"), build.index("python3 scripts/release/release.py build"))
        self.assertIn(".amp/in/cargo-target", build)
        self.assertNotIn("actions/cache@", publish)
        self.assertNotIn("apt-get download bubblewrap", build)
        self.assertNotIn("dpkg-deb", build)
        self.assertIn("contents: read", build)
        self.assertNotIn("contents: write", build)
        self.assertIn("GH_TOKEN: ${{ github.token }}", build)
        self.assertNotIn("FACTORY_RELEASE_TOKEN", build)
        self.assertIn("GH_TOKEN: ${{ secrets.FACTORY_RELEASE_TOKEN }}", publish)
        self.assertNotIn("GH_TOKEN: ${{ github.token }}", publish)
        self.assertIn("contents: read", publish)
        self.assertNotIn("contents: write", publish)
        self.assertNotIn("sudo", publish)
        self.assertNotIn("apt-get", publish)
        self.assertNotIn("bwrap", publish)
        self.assertNotIn("actions: write", build + publish)
        self.assertIn("actions: write", continuation)
        self.assertNotIn("FACTORY_RELEASE_TOKEN", continuation)
        self.assertNotIn("checkout@", continuation)
        self.assertIn("GH_TOKEN: ${{ github.token }}", continuation)
        self.assertIn("if: needs.publish.outputs.published == 'true'", continuation)
        self.assertIn("gh workflow run release.yml --repo Metacomet-Technologies/factory --ref main", continuation)

    def test_release_cache_falls_back_across_locks_but_never_across_toolchains(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        step = workflow.split("- name: Restore release build cache\n", 1)[1].split("\n      - name:", 1)[0]
        key = re.search(r"^ +key: (.+)$", step, re.M).group(1)
        prefixes = re.search(r"^ +restore-keys: \|\n((?: {12}\S.*(?:\n|$))+)", step, re.M).group(1).strip().splitlines()
        prefixes = [prefix.strip() for prefix in prefixes]

        def evaluate(template, files):
            def value(match):
                if match.group(1) in ("runner.os", "runner.arch"):
                    return {"runner.os": "Linux", "runner.arch": "X64"}[match.group(1)]
                names = re.findall(r"'([^']+)'", re.fullmatch(r"hashFiles\((.+)\)", match.group(1)).group(1))
                return hashlib.sha256(b"".join(hashlib.sha256(files[n]).digest() for n in names)).hexdigest()
            return re.sub(r"\$\{\{ (.+?) \}\}", value, template)

        def restored(saved, files):
            # actions/cache: the exact key, else the newest entry under each restore-key prefix.
            if evaluate(key, files) in saved:
                return evaluate(key, files)
            for prefix in prefixes:
                matches = [entry for entry in saved if entry.startswith(evaluate(prefix, files))]
                if matches:
                    return matches[-1]
            return None

        base = {"rust-toolchain.toml": b'channel = "1.99.0"\n', "Cargo.lock": b"lock one\n"}
        saved = [evaluate(key, base)]
        self.assertEqual(restored(saved, base), saved[0])
        self.assertEqual(restored(saved, {**base, "Cargo.lock": b"lock two\n"}), saved[0])
        self.assertIsNone(restored(saved, {**base, "rust-toolchain.toml": b'channel = "1.100.0"\n'}))
        self.assertIsNone(restored(saved, {"rust-toolchain.toml": b'channel = "1.100.0"\n', "Cargo.lock": b"lock two\n"}))
        # Entries written under the broken v1 key never restore.
        self.assertTrue(saved[0].startswith("release-target-v2-Linux-X64-"))

    def test_cache_proof_refuses_any_difference_and_reads_per_plan_timing(self):
        builds = {scenario: {name: {"sha256": "a" * 64, "size": 1, "identity": None} for name in prove_cache.BINARIES}
                  for scenario in ("warm", "cold", "seeded")}
        prove_cache.compare(builds)
        builds["seeded"]["pricing"] = {**builds["seeded"]["pricing"], "sha256": "b" * 64}
        with self.assertRaisesRegex(ValueError, "pricing"):
            prove_cache.compare(builds)
        environment = prove_cache.release_environment((ROOT / "scripts/release/build.sh").read_text())
        self.assertIn("RUSTUP_TOOLCHAIN=1.99.0", environment[0])
        self.assertTrue(environment[2].startswith("cargo build --release --locked -p meter"))
        log = "\n".join([
            "build\tUNKNOWN STEP\t2026-10-26T02:07:51.36Z Cloning into '/w/f/.amp/in/release'...",
            "build\tUNKNOWN STEP\t2026-10-26T02:07:51.55Z HEAD is now at 627cfe5 First",
            "build\tUNKNOWN STEP\t2026-10-26T02:10:07.18Z     Finished `release` profile [optimized] target(s) in 1m 58s",
            "build\tUNKNOWN STEP\t2026-10-26T02:11:54.34Z Cloning into '/w/f/.amp/in/release'...",
            "build\tUNKNOWN STEP\t2026-10-26T02:11:54.45Z HEAD is now at dcc0b84 Second",
            "build\tUNKNOWN STEP\t2026-10-26T02:12:30.00Z     Finished `release` profile [optimized] target(s) in 30s",
            "build\tUNKNOWN STEP\t2026-10-26T02:13:00.00Z ##[group]Run actions/upload-artifact@cf43",
            "build\tUNKNOWN STEP\t2026-10-26T02:14:00.00Z Cleaning up orphan processes"])
        plans = prove_cache.parse_build_log(log)
        self.assertEqual([(p["short_sha"], p["seconds"]) for p in plans], [("627cfe5", 243.0), ("dcc0b84", 66.0)])
        self.assertEqual(plans[1]["cargo"], ["`release` profile [optimized] target(s) in 30s"])

    def test_release_build_reuses_cargo_target_without_a_second_smoke(self):
        script = (ROOT / "scripts/release/build.sh").read_text()
        self.assertIn("-p sandbox", script)
        self.assertIn("cargo-target", script)
        self.assertNotIn("sandbox-shims/smoke.py", script)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            checkout = root / "release"
            cache = root / "cargo-target"
            cache.mkdir()
            marker = cache / "marker"
            marker.write_text("keep")
            checkout.mkdir()
            (checkout / "source").write_text("gone")
            (checkout / "target").symlink_to(cache, target_is_directory=True)
            r.discard_checkout(checkout)
            self.assertFalse(checkout.exists())
            self.assertEqual(marker.read_text(), "keep")

    def test_sanitized_runtime_ignores_user_space_bubblewrap(self):
        # Reproduce why an outer PATH/GITHUB_PATH entry cannot fix old checkouts.
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "bwrap"
            candidate.write_text("#!/bin/sh\nexit 0\n")
            candidate.chmod(0o755)
            outer = {**os.environ, "PATH": f"{tmp}:/usr/bin:/bin"}
            self.assertEqual(shutil.which("bwrap", path=outer["PATH"]), str(candidate))
            result = subprocess.run(
                ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/usr/bin/python3", "-c",
                 "import os, shutil; print(os.environ['PATH']); print(shutil.which('bwrap'))"],
                env=outer, check=True, capture_output=True, text=True)
            runtime_path, resolved = result.stdout.strip().splitlines()
            self.assertEqual(runtime_path, "/usr/bin:/bin")
            self.assertNotEqual(resolved, str(candidate))


class CacheProofIdentity(unittest.TestCase):
    """prove_cache.inspect against a disposable checkout of fake binaries printing chosen --build-info."""
    VERSION = "0.2.66"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.checkout = Path(self.tmp.name) / "release"
        (self.checkout / "scripts").mkdir(parents=True)
        (self.checkout / "target/release").mkdir(parents=True)
        (self.checkout / "scripts/build-fingerprint.sh").write_text('printf "fp-%s\\n" "$1"\n')
        (self.checkout / ".gitignore").write_text("target/\n")
        run(self.checkout, "git", "init", "-q")
        commit(self.checkout, "identity fixture")
        self.sha = r.git(self.checkout, "rev-parse", "HEAD")
        self.ms = int(r.git(self.checkout, "show", "-s", "--format=%ct", "HEAD")) * 1000
        for name in prove_cache.BINARIES:
            self.emit(name, self.valid(name))

    def tearDown(self):
        self.tmp.cleanup()

    def valid(self, name, **change):
        fingerprint = f"fp-{name}" if name in ("meter", "factory-api") else ""
        identity = {"version": self.VERSION, "git_sha": self.sha, "git_dirty": False, "built_at_ms": self.ms,
                    "inputs_fingerprint": fingerprint, **change}
        return json.dumps({k: v for k, v in identity.items() if v is not ...}) + "\n"

    def emit(self, name, stdout, code=0, body=b"fixture binary "):
        binary = self.checkout / "target/release" / name
        (self.checkout / f"{name}.out").write_text(stdout)
        binary.write_bytes(b"#!/bin/sh\n# " + body + b"\n" + f'cat "{self.checkout}/{name}.out"\nexit {code}\n'.encode())
        binary.chmod(0o755)

    def inspect(self, version=None, foreign=()):
        return prove_cache.inspect(self.checkout, dict(os.environ), self.sha, version or self.VERSION, set(foreign))

    def refuse(self, name, stdout, code=0, pattern=None):
        self.emit(name, stdout, code)
        with self.assertRaisesRegex(ValueError, pattern or re.escape(name)):
            self.inspect()
        self.emit(name, self.valid(name))

    def test_all_four_identities_required_and_reported(self):
        result = self.inspect()
        self.assertEqual(set(result), set(prove_cache.BINARIES))
        for name, row in result.items():
            self.assertEqual(row["identity"], json.loads(self.valid(name)))
            self.assertEqual(len(row["sha256"]), 64)
        self.assertEqual(result["pricing"]["identity"]["inputs_fingerprint"], "")
        self.assertEqual(result["factory-ups-control"]["identity"]["inputs_fingerprint"], "")
        self.assertEqual(result["meter"]["identity"]["inputs_fingerprint"], "fp-meter")
        self.assertEqual(self.inspect(), result)  # repeated valid runs agree

    def test_each_binary_independently_rejects_absent_malformed_or_failed_identity(self):
        for name in prove_cache.BINARIES:
            good = self.valid(name)
            for label, stdout, code in (("absent", "", 0), ("blank", "\n", 0), ("null", "null\n", 0),
                                        ("array", "[]\n", 0), ("malformed", "{version: 1}\n", 0),
                                        ("truncated", good[:len(good) // 2] + "\n", 0),
                                        ("no newline", good[:-1], 0), ("two lines", good + good, 0),
                                        ("nonzero exit", good, 1), ("unknown flag", "", 2),
                                        ("duplicate key", good[:-2] + ', "git_dirty": false}\n', 0)):
                with self.subTest(name=name, case=label):
                    self.refuse(name, stdout, code)
        self.inspect()

    def test_missing_extra_and_wrongly_typed_fields(self):
        for name in prove_cache.BINARIES:
            for label, change in (("missing version", {"version": ...}), ("missing fingerprint", {"inputs_fingerprint": ...}),
                                  ("missing time", {"built_at_ms": ...}), ("extra status", {"status": "ok"}),
                                  ("dirty as zero", {"git_dirty": 0}), ("dirty as string", {"git_dirty": "false"}),
                                  ("time as string", {"built_at_ms": str(self.ms)}),
                                  ("time as float", {"built_at_ms": float(self.ms)}),
                                  ("fingerprint null", {"inputs_fingerprint": None})):
                with self.subTest(name=name, case=label):
                    self.refuse(name, self.valid(name, **change))

    def test_wrong_release_values_and_asymmetric_controls(self):
        for name in prove_cache.BINARIES:
            for label, change in (("short sha", {"git_sha": self.sha[:7]}), ("other sha", {"git_sha": "b" * 40}),
                                  ("dirty", {"git_dirty": True}), ("seconds", {"built_at_ms": self.ms // 1000}),
                                  ("wall clock", {"built_at_ms": self.ms + 1}), ("source version", {"version": "0.2.0"}),
                                  ("other fingerprint", {"inputs_fingerprint": "fp-other"})):
                with self.subTest(name=name, case=label):
                    self.refuse(name, self.valid(name, **change))
        # Controls: the full SHA, milliseconds and false pass; versions match only the fixed override.
        self.inspect()
        for name in prove_cache.BINARIES:
            self.emit(name, self.valid(name, version="0.2.0"))
        self.assertEqual(self.inspect(version="0.2.0")["pricing"]["identity"]["version"], "0.2.0")
        with self.assertRaisesRegex(ValueError, "meter"):
            self.inspect()

    def test_fingerprint_semantics(self):
        # pricing/UPS must not fabricate one; meter/API keep their computed contract.
        self.refuse("pricing", self.valid("pricing", inputs_fingerprint="fp-pricing"))
        self.refuse("factory-ups-control", self.valid("factory-ups-control", inputs_fingerprint="fp-meter"))
        self.refuse("factory-api", self.valid("factory-api", inputs_fingerprint=""))
        (self.checkout / "scripts/build-fingerprint.sh").write_text("printf '\\n'\n")
        with self.assertRaisesRegex(ValueError, "meter build fingerprint is empty"):
            self.inspect()

    def test_reordered_keys_pass_and_retry_after_failure_is_fresh(self):
        for name in prove_cache.BINARIES:
            reordered = dict(reversed(list(json.loads(self.valid(name)).items())))
            self.emit(name, json.dumps(reordered, indent=None, separators=(",", ":")) + "\n")
        first = self.inspect()
        self.emit("factory-ups-control", "")
        with self.assertRaisesRegex(ValueError, "factory-ups-control"):
            self.inspect()
        self.emit("factory-ups-control", self.valid("factory-ups-control"))
        self.assertEqual(self.inspect()["factory-ups-control"]["identity"], first["factory-ups-control"]["identity"])

    def test_foreign_sha_scan_and_scenario_comparison(self):
        foreign = "c" * 40
        self.emit("pricing", self.valid("pricing"), body=foreign.encode())
        with self.assertRaisesRegex(ValueError, f"pricing embeds foreign SHA {foreign}"):
            self.inspect(foreign=[foreign])
        self.emit("pricing", self.valid("pricing"))
        builds = {scenario: self.inspect(foreign=[foreign]) for scenario in ("warm", "cold", "seeded")}
        prove_cache.compare(builds)
        # One binary's identity alone differs: refused even with identical bytes.
        one = copy.deepcopy(builds)
        one["seeded"]["factory-ups-control"]["identity"]["built_at_ms"] += 1
        with self.assertRaisesRegex(ValueError, "factory-ups-control") as raised:
            prove_cache.compare(one)
        self.assertNotIn("pricing", str(raised.exception))
        # Combined bad identity and byte mismatch: inspect refuses, and both differences are reported.
        self.emit("meter", self.valid("meter", git_dirty=True), body=b"different bytes")
        with self.assertRaisesRegex(ValueError, "meter embedded identity"):
            self.inspect()
        both = copy.deepcopy(builds)
        both["cold"]["meter"]["sha256"] = "f" * 64
        both["cold"]["pricing"]["identity"] = None
        with self.assertRaises(ValueError) as raised:
            prove_cache.compare(both)
        self.assertIn("meter:", str(raised.exception))
        self.assertIn("pricing:", str(raised.exception))


class ReleaseRunEvidence(unittest.TestCase):
    """--release-run-evidence over fake authenticated reads; synthetic runs, never natural evidence."""
    CHANGE, FIRST, SECOND = "c" * 40, "627cfe5" + "1" * 33, "dcc0b84" + "2" * 33

    def setUp(self):
        workflow = {"old" + "0" * 37: "key: release-target-v1-", self.CHANGE: "key: release-target-v2-",
                    "d" * 40: "key: release-target-v2-"}
        self.files = {f".github/workflows/release.yml?ref={sha}": text for sha, text in workflow.items()}
        self.files[f"deploy/components.json?ref={self.FIRST}"] = "{}"
        # Newest first, as GitHub lists commits.
        self.commits = [{"sha": sha, "commit": {"committer": {"date": "2026-10-26T14:13:55Z"}}}
                        for sha in reversed(workflow)]
        self.runs, self.jobs, self.logs, self.failing, self.verified = [], {}, {}, set(), []
        self.verify_code = 0

    def add_run(self, number, event="push", plans=2, build="success", conclusion="success"):
        self.runs.append({"id": number, "run_attempt": 1, "event": event, "head_branch": "main",
                          "head_sha": self.SECOND, "status": "completed", "conclusion": conclusion,
                          "html_url": f"https://github.com/{r.REPO}/actions/runs/{number}"})
        self.jobs[number] = [{"id": number * 10, "name": "build", "conclusion": build},
                             {"id": number * 10 + 1, "name": "publish", "conclusion": conclusion}]
        heads = [("02:07:51", "627cfe5", "02:10:07", "1m 58s"), ("02:11:54", "dcc0b84", "02:12:30", "30s")][:plans]
        log = []
        for start, head, end, took in heads:
            log += [f"build\tS\t2026-10-26T{start}.36Z Cloning into '/w/f/.amp/in/release'...",
                    f"build\tS\t2026-10-26T{start}.55Z HEAD is now at {head} Plan",
                    f"build\tS\t2026-10-26T{end}.18Z     Finished `release` profile [optimized] target(s) in {took}"]
        log.append("build\tS\t2026-10-26T02:13:00.00Z ##[group]Run actions/upload-artifact@cf43")
        self.logs[number * 10] = "\n".join(log)
        self.logs[number * 10 + 1] = (f"publish\tS\t2026-10-26T02:20:00Z v0.2.1 {self.FIRST} complete\n"
                                      f"publish\tS\t2026-10-26T02:21:00Z v0.2.2 {self.SECOND} complete")

    def evidence(self):
        test = self

        class Api(r.GitHub):
            def request(self, path, method="GET", **_):
                test.assertEqual(method, "GET")
                url = urlsplit(path)
                r.require(url.path.split("/")[0] not in test.failing, f"GitHub GET {path} failed")
                if url.path == "commits":
                    return test.commits
                if url.path.startswith("contents/"):
                    text = test.files[url.path.removeprefix("contents/") + "?ref=" + parse_qs(url.query)["ref"][0]]
                    return {"content": base64.b64encode(text.encode()).decode()}
                if url.path == "actions/workflows/release.yml/runs":
                    return {"workflow_runs": test.runs}
                if url.path.startswith("compare/"):
                    return {"status": "ahead"}
                if url.path.startswith("actions/runs/"):
                    return {"jobs": test.jobs[int(url.path.split("/")[2])]}
                raise AssertionError(path)

        def verify(argv, **_):
            test.assertIn("verify", argv)
            test.verified.append(argv[argv.index("--tag") + 1:argv.index("--tag") + 4:2])
            return subprocess.CompletedProcess(argv, test.verify_code, "bundle ok" if not test.verify_code else "",
                                               "" if not test.verify_code else "asset digest mismatch")

        out = io.StringIO()
        with patch.object(r, "GitHub", Api), patch.object(prove_cache, "job_log", lambda job: self.logs[job]), \
                patch.object(prove_cache.subprocess, "run", verify), redirect_stdout(out):
            try:
                prove_cache.release_run_evidence()
            except ValueError as error:
                return out.getvalue(), str(error)
        return out.getvalue(), None

    def test_no_eligible_natural_run_is_pending(self):
        self.add_run(1, event="workflow_dispatch")  # two plans, but an operator run
        self.add_run(2, plans=1)
        self.add_run(3, build="failure")
        out, error = self.evidence()
        self.assertIn(f"change on main: {self.CHANGE}", out)
        self.assertTrue(error.startswith("evidence pending: no completed naturally triggered"), error)
        self.assertEqual(self.verified, [])

    def test_eligible_multi_plan_run_is_read_back_and_verified(self):
        self.add_run(1, event="workflow_dispatch")
        self.add_run(2, plans=1)
        self.add_run(3)
        out, error = self.evidence()
        self.assertIsNone(error)
        self.assertIn(f"runs/3 id 3 attempt 1 event push head {self.SECOND}", out)
        self.assertIn(f"plan v0.2.1 {self.FIRST} 243s cargo: `release` profile [optimized] target(s) in 1m 58s", out)
        self.assertIn(f"plan v0.2.2 {self.SECOND} 66s cargo: `release` profile [optimized] target(s) in 30s", out)
        self.assertIn(f"verified v0.2.1 {self.FIRST}: bundle ok", out)
        self.assertEqual(self.verified, [["v0.2.1", self.FIRST]])

    def test_verification_and_read_errors_are_failures_not_pending(self):
        self.add_run(3)
        self.verify_code = 1
        _, error = self.evidence()
        self.assertEqual(error, "release.py verify v0.2.1 failed: asset digest mismatch")
        self.setUp()
        self.add_run(3, conclusion="failure")
        _, error = self.evidence()
        self.assertEqual(error, "first multi-plan run 3 did not publish successfully")
        for endpoint in ("commits", "actions", "compare"):
            self.setUp()
            self.add_run(3)
            self.failing = {endpoint}
            _, error = self.evidence()
            self.assertRegex(error, rf"^GitHub GET {endpoint}\S* failed$")
            self.assertEqual(self.verified, [])


class BuildMetadata(unittest.TestCase):
    def test_normal_invalid_changed_unset_and_source_consistency(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "shared/src").mkdir(parents=True)
            (root / "kiosk/scripts").mkdir(parents=True)
            (root / "scripts").mkdir()
            (root / "VERSION").write_text("0.2.0\n")
            (root / "Cargo.toml").write_text('[workspace]\nmembers=["shared"]\nresolver="2"\n')
            (root / "shared/Cargo.toml").write_text('[package]\nname="metadata-fixture"\nversion="0.2.0"\nedition="2024"\n')
            shutil.copyfile(ROOT / "shared/build.rs", root / "shared/build.rs")
            (root / "shared/src/main.rs").write_text('fn main() { println!("{}|{}|{}|{}", env!("FACTORY_VERSION"), env!("FACTORY_GIT_SHA"), env!("FACTORY_GIT_DIRTY"), env!("FACTORY_BUILT_AT_MS")); }\n')
            shutil.copyfile(ROOT / "kiosk/scripts/build-info.ts", root / "kiosk/scripts/build-info.ts")
            (root / "kiosk/package.json").write_text('{"type":"module","version":"0.2.0"}')
            (root / "scripts/build-fingerprint.sh").write_text("printf '123456abcdef\\n'\n")
            (root / ".gitignore").write_text("target/\n")
            # Outside the repository, cargo needs the repository pin, not a user-global default.
            shutil.copyfile(ROOT / "rust-toolchain.toml", root / "rust-toolchain.toml")
            run(root, "cargo", "generate-lockfile")
            run(root, "git", "init", "-q")
            commit(root, "fixture metadata source")
            sha = r.git(root, "rev-parse", "HEAD")
            base = {k: v for k, v in os.environ.items() if k not in ("FACTORY_RELEASE_VERSION", "RUSTFLAGS", "CARGO_TARGET_DIR")}
            node = ["node", "--input-type=module", "-e", 'import {buildInfo} from "./kiosk/scripts/build-info.ts"; console.log(JSON.stringify(buildInfo()))']
            for override in (None, "0.2.1", "1.0.0", None):
                env = dict(base)
                if override is not None:
                    env["FACTORY_RELEASE_VERSION"] = override
                rust = run(root, "cargo", "run", "--quiet", "--locked", env=env).stdout.strip().split("|")
                kiosk = json.loads(run(root, *node, env=env).stdout)
                self.assertEqual(rust[0], override or "0.2.0")
                self.assertEqual(kiosk["version"], override or "0.2.0")
                self.assertEqual(rust[1], sha if override else sha[:7])
                self.assertEqual(kiosk["git_sha"], rust[1])
                self.assertEqual(rust[2], "false")
                self.assertFalse(kiosk["git_dirty"])
                if override:
                    self.assertEqual(int(rust[3]), kiosk["built_at_ms"])
            dev = dict(base)
            first_dev = run(root, "cargo", "build", "--locked", env=dev)
            second_dev = run(root, "cargo", "build", "--locked", env=dev)
            self.assertNotIn("Compiling", first_dev.stderr)
            self.assertNotIn("Compiling", second_dev.stderr)
            (root / "branch.txt").write_text("b\n")
            commit(root, "move branch HEAD")
            branched = run(root, "cargo", "build", "--locked", env=dev)
            self.assertIn("Compiling", branched.stderr)
            # Release checkouts are detached, so .git/HEAD itself holds the SHA.
            run(root, "git", "checkout", "-q", "--detach")
            rel = {**base, "FACTORY_RELEASE_VERSION": "0.2.1"}
            first_rel = run(root, "cargo", "build", "--release", "--locked", env=rel)
            second_rel = run(root, "cargo", "build", "--release", "--locked", env=rel)
            self.assertIn("Compiling", first_rel.stderr)
            self.assertNotIn("Compiling", second_rel.stderr)
            (root / "note.txt").write_text("n\n")
            commit(root, "move HEAD")
            moved = run(root, "cargo", "build", "--release", "--locked", env=rel)
            self.assertIn("Compiling", moved.stderr)
            stamped = run(root, "cargo", "run", "--quiet", "--release", "--locked", env=rel).stdout.strip().split("|")
            self.assertEqual(stamped[0], "0.2.1")
            self.assertEqual(stamped[1], r.git(root, "rev-parse", "HEAD"))
            for invalid in ("", "0.1.99", "0.02.1", "1.2.3-rc1", "1.2.3+meta", "1.2.3\n", "4294967296.0.0"):
                env = {**base, "FACTORY_RELEASE_VERSION": invalid}
                self.assertNotEqual(run(root, "cargo", "run", "--quiet", env=env, check=False).returncode, 0, invalid)
                self.assertNotEqual(run(root, *node, env=env, check=False).returncode, 0, invalid)
            (root / "VERSION").write_text("0.3.0\n")
            env = {**base, "FACTORY_RELEASE_VERSION": "1.0.0"}
            self.assertIn("workspace version must match VERSION", run(root, "cargo", "run", env=env, check=False).stderr)
            self.assertIn("kiosk version must match VERSION", run(root, *node, env=env, check=False).stderr)


def build_fixture(output):
    """Optional real build, fake publication, and consumer negative controls."""
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    reservation = plan(r.git(ROOT, "rev-parse", "HEAD"))
    reservation["source_version"] = (ROOT / "VERSION").read_text().strip()
    reservation["release_tag"] = r.allocate([], reservation["source_version"], "patch")
    api = FakeGitHub()
    # Synthetic approval evidence only; build the real current commit, then cross
    # the same prebuilt-artifact boundary as the two workflow jobs.
    with patch.object(r, "planned", side_effect=lambda *_: iter([reservation])):
        r.build_pending(api, ROOT, INVENTORY, output / "handoff")
        assert api.writes == 0
        with patch.object(r, "build_exact", side_effect=AssertionError("publisher attempted a build")):
            r.publish_downloaded(api, ROOT, INVENTORY, output / "handoff")
    shutil.copytree(output / "handoff/bundles" / reservation["release_tag"], output / "assets")
    publication = r.release_for(api, reservation["release_tag"])
    (output / "publication.json").write_bytes(r.canonical(publication))
    manifest = r.verify_bundle(output / "assets", INVENTORY, reservation["source_sha"], publication)
    binary = output / "assets/meter-linux-x86_64"
    original = binary.read_bytes()
    binary.write_bytes(original + b"tampered")
    try:
        r.verify_bundle(output / "assets", INVENTORY, reservation["source_sha"], publication)
        raise AssertionError("tampered release accepted")
    except ValueError as error:
        print("TAMPER REJECTED:", error)
    finally:
        binary.write_bytes(original)
    try:
        r.verify_bundle(output / "assets", INVENTORY, reservation["source_sha"], {**publication, "draft": True})
        raise AssertionError("draft accepted")
    except ValueError as error:
        print("INCOMPLETE REJECTED:", error)
    print("COMPLETE FIXTURE:", manifest["source_sha"], manifest["release_tag"], "six artifacts; fake API only")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--build-fixture":
        build_fixture(Path(sys.argv[2]))
    else:
        unittest.main(verbosity=2)
