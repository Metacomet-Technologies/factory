#!/usr/bin/env python3
"""Offline release contracts; all publication requests go to FakeGitHub."""
import copy
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import release as r

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
        self.assertEqual(workflow.count("RESUME_RELEASE: ${{ inputs.resume_release }}"), 2)
        self.assertEqual(workflow.count('resume_args+=(--resume-release "$RESUME_RELEASE")'), 2)
        for command in ("build", "publish"):
            self.assertIn('release.py ' + command + ' --directory "$RUNNER_TEMP/release-build" "${resume_args[@]}"', workflow)
        self.assertIn('[[ -z "$REQUESTED_TAG" ]]', workflow)

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
        original_run = subprocess.run

        def only_git_reads(args, *positional, **kwargs):
            self.assertEqual(args[0], "git", "publisher attempted a subprocess build")
            return original_run(args, *positional, **kwargs)

        with patch.object(r, "GitHub", return_value=api), patch.object(sys, "argv", argv), \
                patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REF": "refs/heads/main"}), \
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
            api.runs[1]["status"] = "completed"
            api.crash_at, api.crash_after = 4, True
            with self.assertRaises(OSError):
                r.main()
            api.crash_at = None
            self.assertIsNone(r.main())
            self.assertEqual([release["tag_name"] for release in api.releases], ["v0.2.1", "v0.3.0"])
            self.assertEqual(len(api.uploaded), len(set(api.uploaded)))
            for p in plans:
                r.verify_bundle(handoff / "bundles" / p["release_tag"], inventory, p["source_sha"],
                                r.release_for(api, p["release_tag"]))

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


class RunnerProvisioning(unittest.TestCase):
    def test_historical_sandbox_gets_system_bubblewrap_before_build(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        build, publish = workflow.split("\n  publish:\n", 1)
        install = "sudo apt-get install --no-install-recommends -y bubblewrap"
        probe = "env -i PATH=/usr/bin:/bin bwrap --unshare-net --ro-bind / / true"
        self.assertIn("runs-on: ubuntu-22.04", build)
        self.assertIn("sudo apt-get update", build)
        self.assertIn(install, build)
        self.assertIn(probe, build)
        self.assertLess(build.index("sudo apt-get update"), build.index(install))
        self.assertLess(build.index(install), build.index(probe))
        self.assertLess(build.index(probe), build.index("python3 scripts/release/release.py build"))
        self.assertNotIn("apt-get download bubblewrap", build)
        self.assertNotIn("dpkg-deb", build)
        self.assertIn("contents: read", build)
        self.assertNotIn("contents: write", build)
        self.assertIn("contents: write", publish)
        self.assertNotIn("sudo", publish)
        self.assertNotIn("apt-get", publish)
        self.assertNotIn("bwrap", publish)

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

