#!/usr/bin/env python3
"""Exact-SHA releases. Only `publish` writes GitHub; fixtures inject a fake API."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

REPO = "Metacomet-Technologies/factory"
SCHEMA = 1
API_VERSION = "2026-03-10"
# PR merge_commit_sha was removed in 2026-03-10; keep exact-merge evidence.
PR_API_VERSION = "2022-11-28"
SEMVER = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", re.ASCII)
SHA = re.compile(r"[0-9a-f]{40}")
ASSETS = {"meter-linux-x86_64", "factory-api-linux-x86_64", "pricing-linux-x86_64",
          "factory-ups-control-linux-x86_64", "kiosk.tar.gz", "deployment.tar.gz"}
COMPONENTS = {"meter", "factory-api", "kiosk", "pricing", "ups-control", "dispatcher",
              "usage", "alerts", "backup", "reboot", "nut", "migration-and-host-tools",
              "external-host-services"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def version(text):
    require(isinstance(text, str) and SEMVER.fullmatch(text), f"invalid stable SemVer: {text!r}")
    result = tuple(map(int, text.split(".")))
    require(max(result) <= 4294967295, "version component exceeds u32")
    return result


def allocate(tags, floor, bump):
    require(bump in ("patch", "minor", "major"), "unknown bump intent")
    current = version(floor)
    for tag in tags:
        if tag.startswith("v"):
            current = max(current, version(tag[1:]))
    major, minor, patch = current
    result = {"major": (major + 1, 0, 0), "minor": (major, minor + 1, 0),
              "patch": (major, minor, patch + 1)}[bump]
    text = ".".join(map(str, result))
    version(text)
    return "v" + text


def bump_intent(labels):
    intents = {label[5:] for label in labels if label.startswith("bump:")}
    require(intents <= {"patch", "minor", "major"} and len(intents) <= 1,
            "contradictory or unknown merged-PR bump intent")
    return next(iter(intents), "patch")


def safe_path(name):
    require(isinstance(name, str) and name and "\\" not in name and "\x00" not in name,
            "unsafe path")
    parts = name.split("/")
    require(not PurePosixPath(name).is_absolute() and all(p not in ("", ".", "..") for p in parts),
            f"unsafe path: {name}")
    return name


def inventory_check(inventory):
    require(inventory["schema_version"] == SCHEMA and inventory["repository"] == REPO,
            "unsupported inventory schema/repository")
    require(SHA.fullmatch(inventory["activation_baseline"]), "invalid activation baseline")
    require(inventory["enabled_auto_deploy"] == [], "v1 does not authorize auto-deployment")
    require(inventory["target"] == "x86_64-unknown-linux-gnu", "unsupported target")
    require(inventory["required_files"] and len(set(inventory["required_files"])) == len(inventory["required_files"]),
            "missing/duplicate required deployment files")
    for name in inventory["required_files"]:
        safe_path(name)
    components = inventory["components"]
    require({c["id"] for c in components} == COMPONENTS and len(components) == len(COMPONENTS),
            "truncated or unknown component inventory")
    require({c["artifact"] for c in components if c["artifact"]} == ASSETS, "artifact inventory mismatch")
    for component in components:
        require(component["eligibility"] in ("human-only", "ineligible"), "invalid eligibility")
        require(component["nodes"] and component["health"] and component["rollback"]
                and component["constraints"], "missing deployment contract")
        for path in component["sources"]:
            safe_path(path)
        if component["installer"]:
            safe_path(component["installer"])
        if component["id"] == "ups-control":
            require(component["eligibility"] == "ineligible" and not component["reversible_candidate"],
                    "UPS-control must remain human-only/ineligible")
    require(inventory["required_ci"] == ["rust", "kiosk", "scripts", "sandbox"], "CI policy mismatch")


def archive_entries(data):
    """Never extract untrusted archives. Reject links, devices, duplicates and bombs."""
    entries = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            safe_path(member.name)
            require(member.isfile() and not member.mode & 0o7000 and member.name not in entries,
                    f"unsafe archive entry: {member.name}")
            total += member.size
            require(len(entries) < 20000 and 0 <= member.size <= 128 * 1024 * 1024
                    and total <= 512 * 1024 * 1024, "archive exceeds bounds")
            entries[member.name] = archive.extractfile(member).read()
    require(entries, "empty archive")
    return entries


def validate_manifest(manifest, inventory, expected_sha):
    inventory_check(inventory)
    require(SHA.fullmatch(expected_sha), "expected SHA must be full lowercase SHA")
    require(manifest["schema_version"] == SCHEMA and manifest["state"] == "complete", "incomplete manifest")
    require(manifest["repository"] == REPO and manifest["source_sha"] == expected_sha, "wrong source SHA/repository")
    require(manifest["inventory"] == inventory, "truncated or altered inventory")
    require(manifest["release_tag"] == "v" + manifest["release_version"], "tag/version mismatch")
    require(version(manifest["release_version"]) >= version(manifest["source_version"]), "version below source floor")
    require(manifest["bump"] in ("patch", "minor", "major"), "invalid bump")
    evidence = manifest["evidence"]
    require(all(evidence[key] == manifest[key] for key in
                ("schema_version", "repository", "source_sha", "source_version", "release_tag", "bump")),
            "reservation evidence mismatch")
    require(all(type(evidence[key]) is int and evidence[key] > 0
                for key in ("pull_request", "ci_run", "ci_attempt")), "invalid merge/CI evidence")
    artifacts = manifest["artifacts"]
    require(len(artifacts) == len(ASSETS) and {a["name"] for a in artifacts} == ASSETS, "missing/unknown artifact")
    for artifact in artifacts:
        safe_path(artifact["name"])
        require(type(artifact["size"]) is int and 0 < artifact["size"] <= 512 * 1024 * 1024,
                "invalid artifact size")
        require(re.fullmatch(r"[a-f0-9]{64}", artifact["sha256"]), "invalid artifact digest")
    require(set(manifest["fingerprints"]) == COMPONENTS, "missing component fingerprints")
    for value in manifest["fingerprints"].values():
        require(re.fullmatch(r"[a-f0-9]{64}", value), "invalid component fingerprint")
    require(set(manifest["build_identity"]) == {"meter", "factory-api", "kiosk"}, "missing embedded identity")
    for identity in manifest["build_identity"].values():
        require(identity["version"] == manifest["release_version"] and identity["git_sha"] == expected_sha
                and identity["git_dirty"] is False, "wrong embedded release identity")
        require(type(identity["built_at_ms"]) is int and identity["built_at_ms"] > 0
                and re.fullmatch(r"[a-f0-9]{12}", identity["inputs_fingerprint"]), "invalid build metadata")


def verify_receipt(raw, inventory, expected_sha, publication):
    manifest = json.loads(raw)
    validate_manifest(manifest, inventory, expected_sha)
    require(publication.get("draft") is False and publication.get("immutable") is True
            and publication.get("published_at") and publication.get("prerelease") is False,
            "incomplete draft or non-immutable publication")
    require(publication["tag_name"] == manifest["release_tag"]
            and publication["body"] == "factory-release-v1:" + digest(raw), "completion receipt mismatch")
    assets = publication["assets"]
    require(len(assets) == len(ASSETS) + 1 and {a["name"] for a in assets} == ASSETS | {"manifest.json"}, "partial publication")
    expected = {a["name"]: (a["size"], "sha256:" + a["sha256"]) for a in manifest["artifacts"]}
    expected["manifest.json"] = (len(raw), "sha256:" + digest(raw))
    for asset in assets:
        require(asset["state"] == "uploaded" and (asset["size"], asset.get("digest")) == expected[asset["name"]],
                "GitHub asset digest/size mismatch")
    return manifest


def verify_bundle(directory, inventory, expected_sha, publication=None):
    directory = Path(directory)
    manifest_path = directory / "manifest.json"
    require(not manifest_path.is_symlink(), "symlinked manifest")
    raw = manifest_path.read_bytes()
    manifest = json.loads(raw)
    validate_manifest(manifest, inventory, expected_sha)
    if publication is not None:
        verify_receipt(raw, inventory, expected_sha, publication)
    archives = {}
    for artifact in manifest["artifacts"]:
        path = directory / artifact["name"]
        require(path.is_file() and not path.is_symlink(), "missing artifact")
        data = path.read_bytes()
        require(len(data) == artifact["size"] and digest(data) == artifact["sha256"], "artifact checksum mismatch")
        if path.name.endswith(".tar.gz"):
            archives[path.name] = archive_entries(data)
    scripts = archives["deployment.tar.gz"]
    require(json.loads(scripts["deploy/components.json"]) == inventory, "archived inventory mismatch")
    require(scripts["release-source.json"] == canonical({"source_sha": expected_sha}), "wrong script source SHA")
    require(set(inventory["required_files"]) <= scripts.keys(), "truncated deployment archive")
    require(manifest["archive_files"] == {name: {p: digest(data) for p, data in entries.items()}
                                        for name, entries in archives.items()}, "archive file inventory mismatch")
    for component in inventory["components"]:
        if component["installer"]:
            require(component["installer"] in scripts, "missing installer")
    require("index.html" in archives["kiosk.tar.gz"] and "version.json" in archives["kiosk.tar.gz"], "missing kiosk entry")
    require(json.loads(archives["kiosk.tar.gz"]["release-build.json"]) == manifest["build_identity"]["kiosk"],
            "kiosk embedded identity mismatch")
    return manifest


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


class GitHub:
    """Fixed repository/hosts; no alternate credential transport or automatic write retry."""
    def __init__(self, anonymous=False):
        self.tag_objects = {}
        self.release_ids = None
        self.create_reserved_releases = set()
        self.anonymous = anonymous
        self.waiting_for_ci = False

    def request(self, path, method="GET", data=None, binary=False, upload=None,
                api_version=API_VERSION):
        endpoint = f"repos/{REPO}/{path}"
        if self.anonymous:
            require(method == "GET" and data is None and upload is None, "anonymous mode is read-only")
            request = urllib.request.Request("https://api.github.com/" + endpoint, headers={
                "Accept": "application/octet-stream" if binary else "application/vnd.github+json",
                "User-Agent": "factory-release-verifier", "X-GitHub-Api-Version": api_version})
            with urllib.request.urlopen(request, timeout=120) as response:
                result = response.read(512 * 1024 * 1024 + 1)
            require(len(result) <= 512 * 1024 * 1024, "response exceeds bounds")
            return result if binary else json.loads(result)
        if upload is not None:
            endpoint = "https://uploads.github.com/" + endpoint
        args = ["gh", "api", endpoint, "--method", method,
                "-H", f"X-GitHub-Api-Version: {api_version}"]
        if binary:
            args += ["-H", "Accept: application/octet-stream"]
        payload = None
        if upload is not None:
            args += ["-H", "Content-Type: application/octet-stream", "--input", str(upload)]
        elif data is not None:
            args += ["--input", "-"]
            payload = canonical(data)
        result = subprocess.run(args, input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
        require(result.returncode == 0, f"GitHub {method} {path} failed; inspect remote state before retry: "
                + result.stderr.decode(errors="replace")[-1200:])
        return result.stdout if binary else json.loads(result.stdout or b"null")

    def pages(self, path, key=None, api_version=API_VERSION):
        result = []
        for page in range(1, 1001):
            value = self.request(path + ("&" if "?" in path else "?") + f"per_page=100&page={page}",
                                 api_version=api_version)
            rows = value[key] if key else value
            require(isinstance(rows, list), "invalid paginated GitHub response")
            result.extend(rows)
            if len(rows) < 100:
                return result
        raise ValueError("GitHub pagination exceeds safety bound")

    def tags(self):
        result = {}
        # Matching refs is NOT a paginated endpoint. Annotated objects are immutable
        # by object ID, so cache them, but always refresh refs at write boundaries.
        for ref in self.request("git/matching-refs/tags/"):
            tag = ref["ref"].removeprefix("refs/tags/")
            if not tag.startswith("v"):
                continue
            version(tag[1:])
            obj = ref["object"]
            reservation = None
            if obj["type"] == "tag":
                if obj["sha"] not in self.tag_objects:
                    self.tag_objects[obj["sha"]] = self.request("git/tags/" + obj["sha"])
                annotated = self.tag_objects[obj["sha"]]
                obj = annotated["object"]
                try:
                    reservation = json.loads(annotated["message"])
                except json.JSONDecodeError:
                    pass  # Historical release tags need not have reservations.
            require(obj["type"] == "commit" and SHA.fullmatch(obj["sha"]), "tag does not point directly to a commit")
            result[tag] = {"sha": obj["sha"], "reservation": reservation}
        require(len({r["sha"] for r in result.values()}) == len(result), "conflicting tags for one SHA")
        return result

    def evidence(self, sha, inventory):
        pulls = self.pages(f"commits/{sha}/pulls", api_version=PR_API_VERSION)
        merged = []
        for pr in pulls:
            if pr.get("merge_commit_sha") == sha:
                detail = self.request(f"pulls/{pr['number']}", api_version=PR_API_VERSION)
                if (detail["merged"] and detail["merged_at"] and detail["merge_commit_sha"] == sha
                        and detail["base"]["ref"] == "main"
                        and detail["base"]["repo"]["full_name"].lower() == REPO.lower()):
                    merged.append(detail)
        require(len(merged) == 1, f"{sha}: unverifiable merged-PR evidence; require one exact merge SHA on main")
        pr = merged[0]
        bump = bump_intent([label["name"] for label in pr["labels"]])
        runs = self.pages(f"actions/workflows/ci.yml/runs?head_sha={sha}&event=push&branch=main", "workflow_runs")
        require(runs, f"{sha}: exact-SHA main CI not found; reconcile after CI completes")
        run = max(runs, key=lambda row: row["id"])
        require(run["head_sha"] == sha and run["event"] == "push" and run["head_branch"] == "main"
                and run["path"] == ".github/workflows/ci.yml", f"{sha}: mismatched CI evidence for run {run['id']}")
        if run["status"] in ("queued", "in_progress", "waiting", "requested", "pending"):
            self.waiting_for_ci = True
            print(f"waiting for CI on {sha} run {run['id']}", file=sys.stderr)
            return None
        require(run["status"] == "completed" and run["conclusion"] == "success",
                f"{sha}: exact-SHA main CI incomplete or check-failed; "
                f"Devon must inspect/rerun CI run {run['id']}, then reconcile (never skip this SHA)")
        jobs = self.pages(f"actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs", "jobs")
        for name in inventory["required_ci"]:
            matching = [j for j in jobs if j["name"] == name]
            require(len(matching) == 1 and matching[0]["head_sha"] == sha
                    and matching[0]["status"] == "completed" and matching[0]["conclusion"] == "success",
                    f"{sha}: required CI job {name} not successful")
        return {"bump": bump, "pull_request": pr["number"], "ci_run": run["id"], "ci_attempt": run["run_attempt"]}


def planned(api, root, inventory):
    api.waiting_for_ci = False
    inventory_check(inventory)
    history = git(root, "rev-list", "--first-parent", "--reverse", "origin/main").splitlines()
    baseline = inventory["activation_baseline"]
    require(baseline in history, "activation baseline is not on first-parent main")
    history = history[history.index(baseline) + 1:]
    tags = api.tags()
    by_sha = {value["sha"]: tag for tag, value in tags.items()}
    last = None
    activated = False
    for index, sha in enumerate(history):
        declared = git(root, "ls-tree", "--name-only", sha, "deploy/components.json")
        if not declared:
            require(not activated, "release inventory removed after activation")
            continue  # Merges before the approved publisher exists are not eligible.
        activated = True
        source_inventory = json.loads(git(root, "show", f"{sha}:deploy/components.json"))
        inventory_check(source_inventory)
        require(source_inventory["activation_baseline"] == baseline, "activation baseline changed")
        floor = git(root, "show", f"{sha}:VERSION")
        completed = False
        if sha in by_sha:
            tag = by_sha[sha]
            reservation = tags[tag]["reservation"]
            require(isinstance(reservation, dict) and reservation.get("schema_version") == SCHEMA
                    and reservation.get("source_sha") == sha and reservation.get("release_tag") == tag
                    and reservation.get("repository") == REPO
                    and reservation.get("source_version") == floor,
                    f"{tag}: conflicting/unverifiable reservation; human investigation required")
            release = release_for(api, tag)
            if not release or release["draft"]:
                evidence = api.evidence(sha, source_inventory)
                if evidence is None:
                    return
                require(reservation["bump"] == evidence["bump"]
                        and reservation["pull_request"] == evidence["pull_request"], "reservation intent changed")
                if release is None:
                    require(tag in api.create_reserved_releases,
                            f"{tag}: reserved tag has no visible release; inspect existing drafts and use explicit recovery")
            else:
                assets = [a for a in release["assets"] if a["name"] == "manifest.json"]
                require(len(assets) == 1, "published manifest missing or duplicated")
                raw = api.request(f"releases/assets/{assets[0]['id']}", binary=True)
                manifest = verify_receipt(raw, source_inventory, sha, release)
                require(manifest["evidence"] == reservation, "published reservation mismatch")
                completed = True
            # Reconciliation trusts GitHub's immutable asset digests for completed
            # history, avoiding repeated binary downloads. Consumers still download
            # and inspect every artifact and archive before accepting a release.
        else:
            evidence = api.evidence(sha, source_inventory)
            if evidence is None:
                return
            require(not any(later in by_sha for later in history[index + 1:]), "out-of-order reservation after missing SHA")
            tag = allocate(tags, floor, evidence["bump"])
            reservation = {"schema_version": SCHEMA, "repository": REPO, "source_sha": sha,
                           "source_version": floor, "release_tag": tag, **evidence}
        require(version(tag[1:]) >= version(floor) and (last is None or version(tag[1:]) > last),
                "release order/floor violation")
        last = version(tag[1:])
        tags[tag] = {"sha": sha, "reservation": reservation}
        if not completed:
            yield reservation


def reserve(api, plan):
    tag = plan["release_tag"]
    tags = api.tags()
    if tag in tags:
        require(tags[tag] == {"sha": plan["source_sha"], "reservation": plan}, "immutable tag reservation conflict")
        return
    require(not any(t["sha"] == plan["source_sha"] for t in tags.values()), "SHA already reserved under another tag")
    obj = api.request("git/tags", "POST", {"tag": tag, "message": canonical(plan).decode(),
                                          "object": plan["source_sha"], "type": "commit"})
    # A lost acknowledgement stops here. The next run inspects refs; never force a tag.
    api.request("git/refs", "POST", {"ref": "refs/tags/" + tag, "sha": obj["sha"]})


def remember_release(api, release, tag, release_id=None):
    """Bind an acknowledgement to one positive numeric ID; never trust list visibility."""
    require(isinstance(release, dict) and type(release.get("id")) is int
            and release["id"] > 0, "invalid release acknowledgement ID; inspect before retry")
    require(release.get("tag_name") == tag, "release tag changed")
    require(type(release.get("draft")) is bool, "invalid release draft state")
    require(release_id is None or release["id"] == release_id, "release ID changed")
    if api.release_ids is None:
        api.release_ids = {}
    require(tag not in api.release_ids or api.release_ids[tag] == release["id"],
            "conflicting release identity; inspect before retry")
    api.release_ids[tag] = release["id"]


def resume_release(api, identity):
    """Read-only operator recovery hint; still require the API and annotated reservation."""
    match = re.fullmatch(r"(v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))=([1-9][0-9]*)", identity)
    require(match is not None, "resume release must be vMAJOR.MINOR.PATCH=NUMERIC_ID")
    tag, release_id = match[1], int(match[2])
    version(tag[1:])
    release = api.request(f"releases/{release_id}")
    remember_release(api, release, tag, release_id)
    reservation = api.tags().get(tag)
    require(reservation is not None and isinstance(reservation.get("reservation"), dict)
            and reservation["reservation"].get("release_tag") == tag
            and reservation["reservation"].get("source_sha") == reservation["sha"]
            and reservation["reservation"].get("repository") == REPO,
            "recovery tag reservation conflict")
    # Planning and publication subsequently validate the complete plan, CI,
    # asset bytes and immutable receipt, including an already-completed retry.


def release_for(api, tag):
    if api.release_ids is None or tag not in api.release_ids:
        releases = api.pages("releases")
        require(len({r["tag_name"] for r in releases}) == len(releases), "duplicate release identity")
        for release in releases:
            remember_release(api, release, release["tag_name"])
    if api.release_ids is None or tag not in api.release_ids:
        return None
    release_id = api.release_ids[tag]
    release = api.request(f"releases/{release_id}")
    remember_release(api, release, tag, release_id)
    release["assets"] = api.pages(f"releases/{release_id}/assets")
    return release


def fetch_bundle(api, release, directory):
    names = set()
    for asset in release["assets"]:
        name = safe_path(asset["name"])
        require(name in ASSETS | {"manifest.json"} and name not in names and asset["state"] == "uploaded",
                "unexpected, duplicate or incomplete remote asset; never delete/replace automatically")
        require(0 < asset["size"] <= 512 * 1024 * 1024, "remote asset exceeds bounds")
        names.add(name)
        data = api.request(f"releases/assets/{asset['id']}", binary=True)
        require(len(data) == asset["size"], "truncated asset download")
        (Path(directory) / name).write_bytes(data)


def publish_one(api, plan, inventory, directory, builder):
    """Resume at every boundary by inspecting remote state, never replacing content."""
    tag, sha = plan["release_tag"], plan["source_sha"]
    release = release_for(api, tag)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if release and not release["draft"]:
        require(api.tags().get(tag) == {"sha": sha, "reservation": plan}, "published tag conflict")
        fetch_bundle(api, release, directory)
        manifest = verify_bundle(directory, inventory, sha, release)
        require(manifest["evidence"] == plan, "published identity conflict")
        return "already complete"
    if release is None and tag in api.tags():
        require(tag in api.create_reserved_releases,
                f"{tag}: reserved tag has no visible release; inspect existing drafts and use explicit recovery")
    # Rely on owner-enforced organization/repository immutability settings.
    # The standard token cannot read that policy; verify the published receipt
    # below. This cannot prevent publication if enforcement was disabled.
    if release is not None:
        require(api.tags().get(tag) == {"sha": sha, "reservation": plan}, "draft tag reservation conflict")
    reserve(api, plan)
    builder(plan, directory)
    manifest = verify_bundle(directory, inventory, sha)
    require(manifest["evidence"] == plan, "build identity conflict")
    if release is None:
        # Require the exact annotated reservation before requesting its draft.
        # GitHub documents target_commitish as unused for an existing tag.
        require(api.tags().get(tag) == {"sha": sha, "reservation": plan}, "draft tag reservation conflict")
        created = api.request("releases", "POST", {"tag_name": tag,
                                         "name": tag, "body": "incomplete", "draft": True, "prerelease": False})
        remember_release(api, created, tag)
        require(created["draft"] is True, "creation acknowledgement is not a draft; inspect before retry")
        print(f"draft acknowledged: {tag} release ID {created['id']}", flush=True)
        # Pin the response ID before any refresh. Drafts may be absent from the
        # collection even when a direct read by this ID is permitted.
        release = release_for(api, tag)
    for name in ["manifest.json", *sorted(ASSETS)]:
        # Refresh BEFORE each attempt, including recovery after a lost response.
        release = release_for(api, tag)
        require(release is not None and release["draft"], "release changed during publication")
        existing = [a for a in release["assets"] if a["name"] == name]
        require(len(existing) <= 1, "duplicate asset name")
        if existing:
            asset = existing[0]
            require(asset["state"] == "uploaded" and asset["size"] == (directory / name).stat().st_size
                    and api.request(f"releases/assets/{asset['id']}", binary=True) == (directory / name).read_bytes(),
                    f"immutable asset conflict: {tag}/{name}; preserve draft and investigate, never overwrite")
        else:
            api.request(f"releases/{release['id']}/assets?name={name}", "POST", upload=directory / name)
    release = release_for(api, tag)
    with tempfile.TemporaryDirectory(dir=directory.parent) as downloaded:
        fetch_bundle(api, release, downloaded)
        require({a["name"] for a in release["assets"]} == ASSETS | {"manifest.json"}, "partial publication")
        verify_bundle(downloaded, inventory, sha)
        require((Path(downloaded) / "manifest.json").read_bytes() == (directory / "manifest.json").read_bytes(),
                "remote manifest changed")
    # Inspect tag again immediately before the one-way publication boundary.
    require(api.tags().get(tag) == {"sha": sha, "reservation": plan}, "publication tag reservation conflict")
    api.request(f"releases/{release['id']}", "PATCH", {
        "draft": False, "make_latest": "false",
        "body": "factory-release-v1:" + digest((directory / "manifest.json").read_bytes())})
    release = release_for(api, tag)
    verify_bundle(directory, inventory, sha, release)
    return "complete"


def make_archive(path, entries):
    with path.open("wb") as output, gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, (data, executable) in sorted(entries.items()):
                safe_path(name)
                member = tarfile.TarInfo(name)
                member.size, member.mode = len(data), 0o755 if executable else 0o644
                archive.addfile(member, io.BytesIO(data))


def package(root, output, plan):
    """Called only by build.sh after real isolated health checks are available."""
    root, output = Path(root), Path(output)
    sha = plan["source_sha"]
    require(git(root, "rev-parse", "HEAD") == sha and not git(root, "status", "--porcelain"), "source is not clean/exact SHA")
    inventory = json.loads((root / "deploy/components.json").read_bytes())
    inventory_check(inventory)
    tracked = git(root, "ls-files").splitlines()
    files = {}
    for name in tracked:
        safe_path(name)
        path = root / name
        require(path.is_file() and not path.is_symlink(), "tracked symlink/submodule not supported")
        files[name] = path.read_bytes()
    service_names = {Path(p).name for p in tracked if p.startswith("deploy/")
                     and p.endswith((".service", ".timer", ".path", ".service.in"))}
    require(service_names <= {s for c in inventory["components"] for s in c["services"]}, "unclassified deployment service")
    fingerprints = {}
    for component in inventory["components"]:
        selected = {name: digest(data) for name, data in files.items()
                    if name in ("VERSION", "Cargo.toml", "Cargo.lock", "deploy/components.json")
                    or any(name == p or name.startswith(p + "/") for p in component["sources"])}
        fingerprints[component["id"]] = digest(canonical(selected))
    ports = json.loads((root / ".sandbox/ports.json").read_bytes())
    identities = {}
    for component, endpoint in (("meter", "/meter/health"), ("factory-api", "/v1/health")):
        with urllib.request.urlopen(f"http://127.0.0.1:{ports[component]}{endpoint}", timeout=10) as response:
            identities[component] = json.load(response)
        expected = subprocess.check_output(["bash", "scripts/build-fingerprint.sh", component], cwd=root, text=True).strip()
        require(identities[component]["inputs_fingerprint"] == expected, "binary inputs fingerprint mismatch")
    identities["kiosk"] = json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e",
         'import {buildInfo} from "./kiosk/scripts/build-info.ts"; console.log(JSON.stringify(buildInfo()))'], cwd=root))
    # Inspect emitted JS, not just the metadata generator, before attaching its receipt.
    kiosk = identities["kiosk"]
    js = "\n".join(p.read_text() for p in (root / "kiosk/dist/assets").glob("*.js"))
    for key in ("version", "git_sha", "inputs_fingerprint"):
        require(re.search(rf"{key}:([`'\"]){re.escape(kiosk[key])}\1", js),
                f"emitted kiosk identity missing: {key}")
    require(re.search(r"git_dirty:(?:!1|false)", js), "emitted kiosk identity is not clean")
    for binary in ("meter", "factory-api", "pricing", "factory-ups-control"):
        (output / (binary + "-linux-x86_64")).write_bytes((root / "target/release" / binary).read_bytes())
    kiosk_files = {p.relative_to(root / "kiosk/dist").as_posix(): (p.read_bytes(), False)
                   for p in (root / "kiosk/dist").rglob("*") if p.is_file() and not p.is_symlink()}
    kiosk_files["release-build.json"] = (canonical(kiosk), False)
    make_archive(output / "kiosk.tar.gz", kiosk_files)
    deployment = {name: (data, bool((root / name).stat().st_mode & 0o111)) for name, data in files.items()
                  if name.startswith(("deploy/", "scripts/"))}
    deployment["release-source.json"] = (canonical({"source_sha": sha}), False)
    make_archive(output / "deployment.tar.gz", deployment)
    manifest = {"schema_version": SCHEMA, "state": "complete", "repository": REPO,
                "source_sha": sha, "source_version": plan["source_version"], "release_tag": plan["release_tag"],
                "release_version": plan["release_tag"][1:], "bump": plan["bump"], "inventory": inventory,
                "fingerprints": fingerprints, "build_identity": identities,
                "archive_files": {name: {p: digest(data) for p, (data, _) in entries.items()}
                                  for name, entries in (("deployment.tar.gz", deployment), ("kiosk.tar.gz", kiosk_files))},
                "evidence": plan, "artifacts": [{"name": name, "size": (output / name).stat().st_size,
                "sha256": digest((output / name).read_bytes())} for name in sorted(ASSETS)]}
    (output / "manifest.json").write_bytes(canonical(manifest))
    verify_bundle(output, inventory, sha)


def build_exact(root, plan, output):
    # Clone only committed source into disposable state, never switch the caller's branch.
    exclude = Path(git(root, "rev-parse", "--git-path", "info/exclude"))
    if not exclude.is_absolute():
        exclude = root / exclude
    if "/.amp/in/" not in exclude.read_text().splitlines():
        with exclude.open("a") as stream:
            stream.write("\n/.amp/in/\n")
    scratch = root / ".amp/in"
    scratch.mkdir(parents=True, exist_ok=True)
    # Keep the sandbox's Unix socket paths below Linux's 108-byte limit.
    checkout = scratch / "release"
    checkout.mkdir()  # Refuse a concurrent build or abandoned checkout; never erase it.
    try:
        require(len(str(checkout / ".sandbox/factory-api.sock").encode()) < 108, "checkout path too long for sandbox sockets")
        subprocess.run(["git", "clone", "--no-hardlinks", "--no-checkout", str(root), str(checkout)], check=True)
        subprocess.run(["git", "-C", str(checkout), "checkout", "--detach", plan["source_sha"]], check=True)
        plan_path = output.parent / "plan.json"
        plan_path.write_bytes(canonical(plan))
        # The workflow's separate read-only job is the credential boundary.
        # Environment filtering alone cannot isolate a write-enabled job's token.
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "RUSTUP_HOME", "CARGO_HOME")}
        subprocess.run(["bash", str(checkout / "scripts/release/build.sh"), plan["source_sha"],
                        str(plan_path), str(output.resolve())], cwd=checkout, env=env, check=True)
        plan_path.unlink()
    finally:
        shutil.rmtree(checkout)


def build_pending(api, root, inventory, directory):
    """Read-only job: transfer plans and verified bundles, never reserve a tag."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    plans = list(planned(api, root, inventory))
    (directory / "plans.json").write_bytes(canonical(plans))
    for plan in plans:
        output = directory / "bundles" / plan["release_tag"]
        output.mkdir(parents=True)
        build_exact(root, plan, output)
        source_inventory = json.loads(git(root, "show", f"{plan['source_sha']}:deploy/components.json"))
        manifest = verify_bundle(output, source_inventory, plan["source_sha"])
        require(manifest["evidence"] == plan, "build identity conflict")


def publish_downloaded(api, root, inventory, directory):
    """Write-enabled job: validate the entire handoff before any remote write."""
    directory = Path(directory)
    plans = json.loads((directory / "plans.json").read_bytes())
    current = list(planned(api, root, inventory))
    if api.waiting_for_ci and plans != current:
        return  # CI restarted during the build; wait without reserving anything.
    require(plans == current,
            "downloaded plans differ from current reconciliation; rebuild before publishing")
    inventories = []
    for plan in plans:
        source_inventory = json.loads(git(root, "show", f"{plan['source_sha']}:deploy/components.json"))
        manifest = verify_bundle(directory / "bundles" / plan["release_tag"], source_inventory, plan["source_sha"])
        require(manifest["evidence"] == plan, "downloaded bundle plan mismatch")
        inventories.append(source_inventory)

    def copy_verified(plan, output):
        for name in ASSETS | {"manifest.json"}:
            shutil.copyfile(directory / "bundles" / plan["release_tag"] / name, output / name)

    for plan, source_inventory in zip(plans, inventories):
        with tempfile.TemporaryDirectory() as output:
            result = publish_one(api, plan, source_inventory, output, copy_verified)
        print(plan["release_tag"], plan["source_sha"], result, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "build", "publish", "verify", "package"))
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--publication", type=Path, help="trusted GitHub release response; local fixtures only")
    parser.add_argument("--sha")
    parser.add_argument("--tag")
    parser.add_argument("--create-reserved-release", action="append", default=[],
                        help="operator-confirmed release-less reserved tag; repeat for each inspected tag")
    parser.add_argument("--resume-release", help="operator-verified existing release: vMAJOR.MINOR.PATCH=NUMERIC_ID")
    parser.add_argument("--plan-file", type=Path)
    parser.add_argument("--anonymous", action="store_true", help="verify using public HTTPS without credentials")
    args = parser.parse_args()
    inventory = json.loads((args.inventory or args.root / "deploy/components.json").read_bytes())
    require(not args.anonymous or args.command == "verify", "anonymous mode requires verify")
    api = GitHub(anonymous=args.anonymous)
    if args.create_reserved_release:
        require(args.command in ("plan", "build", "publish"), "reserved release creation requires plan, build or publish")
        for tag in args.create_reserved_release:
            require(tag.startswith("v"), "reserved release creation requires a version tag")
            version(tag[1:])
            require(tag in api.tags(), "explicit create requires an existing reserved tag")
            api.create_reserved_releases.add(tag)
    if args.resume_release:
        require(args.command in ("plan", "build", "publish"), "resume release requires plan, build or publish")
        resume_release(api, args.resume_release)
    if args.command == "package":
        require(args.plan_file and args.directory, "package requires --plan-file and --directory")
        package(args.root, args.directory, json.loads(args.plan_file.read_bytes()))
    elif args.command == "verify":
        require(args.sha and args.directory, "verify requires --sha and --directory")
        if args.publication:
            publication = json.loads(args.publication.read_bytes())
        else:
            require(args.tag, "remote verification requires --tag")
            tags = api.tags()
            require(args.tag in tags, "tag not found")
            require(tags[args.tag]["sha"] == args.sha, "wrong tag source SHA")
            publication = release_for(api, args.tag)
            require(publication is not None, "incomplete publication")
            args.directory.mkdir(parents=True, exist_ok=True)
            require(not any(args.directory.iterdir()), "download directory must be empty")
            fetch_bundle(api, publication, args.directory)
        manifest = verify_bundle(args.directory, inventory, args.sha, publication)
        if not args.publication:
            require(manifest["evidence"] == tags[args.tag]["reservation"], "reservation evidence mismatch")
        print("complete: exact SHA, inventory and every digest verified")
    elif args.command == "plan":
        print(json.dumps(list(planned(api, args.root, inventory)), indent=2))
    elif args.command == "build":
        require(args.directory, "build requires a new output directory")
        build_pending(api, args.root, inventory, args.directory)
    else:
        require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_REF") == "refs/heads/main",
                "live publish is restricted to the approved main workflow; use the fake API for fixtures")
        require(args.directory, "publish requires a downloaded build directory")
        publish_downloaded(api, args.root, inventory, args.directory)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, tarfile.TarError) as error:
        sys.exit(f"release: {error}")
