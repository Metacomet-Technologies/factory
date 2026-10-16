#!/usr/bin/env python3
"""Offline release contracts; all publication requests go to FakeGitHub."""
import copy
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
        self.policy = {"enabled": True}
        self.policy_checks = 0
        self.disable_final = False

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

    def request(self, path, method="GET", data=None, binary=False, upload=None):
        if method != "GET":
            self.writes += 1
            if self.crash_at == self.writes and not self.crash_after:
                raise OSError("simulated crash before write")
        result = self.handle(path, method, data, binary, upload)
        if method != "GET" and self.crash_at == self.writes and self.crash_after:
            raise OSError("simulated lost write acknowledgement")
        return copy.deepcopy(result)

    def handle(self, path, method, data, binary, upload):
        url = urlsplit(path)
        parts = url.path.split("/")
        query = parse_qs(url.query)
        if path == "immutable-releases":
            self.policy_checks += 1
            if self.policy is None:
                raise ValueError("policy permission denied")
            return {"enabled": False} if self.disable_final and self.policy_checks > 1 else self.policy
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
                release.update(data, immutable=True, published_at="2026-10-16T00:00:00Z")
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


class Releases(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

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
                    r.publish_one(api, plan(), INVENTORY, output, fixture_build)
                    writes = api.writes
                    self.assertEqual(r.publish_one(api, plan(), INVENTORY, output,
                                     lambda *_: self.fail("complete release rebuilt")), "already complete")
                    self.assertEqual(api.writes, writes)
                    self.assertEqual(len(api.refs), 1)
                    self.assertEqual(len(api.releases), 1)
                    self.assertEqual(len(api.uploaded), 7)
                    self.assertEqual(len(set(api.uploaded)), 7)

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

    def test_policy_gate_and_nonpaginated_refs(self):
        for policy in (None, {}, {"enabled": False}):
            api = FakeGitHub()
            api.policy = policy
            with self.assertRaises(ValueError):
                r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
            self.assertEqual(api.writes, 0)
        api = FakeGitHub()
        api.disable_final = True
        with self.assertRaisesRegex(ValueError, "preserve draft"):
            r.publish_one(api, plan(), INVENTORY, self.directory, fixture_build)
        self.assertTrue(api.releases[0]["draft"])
        for i in range(100):
            tag = f"v1.0.{i}"
            api.refs["refs/tags/" + tag] = {"ref": "refs/tags/" + tag,
                "object": {"sha": f"{i + 1000:040x}", "type": "commit"}}
        self.assertEqual(len(api.tags()), 101)

    def test_exact_merge_and_ci_evidence(self):
        api = FakeGitHub()
        api.eligible(SHA, 1, "minor")
        self.assertEqual(api.evidence(SHA, INVENTORY)["bump"], "minor")
        for field, value in (("head_sha", "b" * 40), ("status", "in_progress"),
                             ("conclusion", "cancelled"), ("event", "pull_request"), ("head_branch", "feature")):
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

    def test_adjacent_merges_missed_trigger_and_failed_tail(self):
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
    r.publish_one(api, reservation, INVENTORY, output / "assets", lambda p, d: r.build_exact(ROOT, p, d))
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
