#!/usr/bin/env python3
"""Prove that a reused release cargo target builds the same bytes as a cold one.

Default mode builds disposable local clones at one checkout path with build.sh's
cargo environment and never publishes, dispatches or deploys. --release-run-evidence
uses authenticated gh reads and `release.py verify` only; it never dispatches a run."""
import argparse
import base64
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

import release as r

ROOT = Path(__file__).resolve().parents[2]
BINARIES = ("meter", "factory-api", "pricing", "factory-ups-control")
# Only these link shared's build script; pricing and ups-control embed no release identity.
IDENTIFIED = ("meter", "factory-api")
MARKER = "release-target-v2-"  # the first release.yml revision with the repaired cache key
CLONE = re.compile(r"Cloning into '.*/\.amp/in/release'")
STAMP = re.compile(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?Z ")


def git(*args, root=ROOT):
    return r.git(root, *args)


def release_environment(build_script):
    """The cargo lines of build.sh, verbatim, so this proof cannot drift from them."""
    lines = []
    for pattern in (r"export RUSTUP_TOOLCHAIN=.*", r"export RUSTFLAGS=.*", r"cargo build --release --locked .*"):
        found = re.findall(rf"^{pattern}$", build_script, re.M)
        r.require(len(found) == 1, f"build.sh must contain exactly one line matching {pattern!r}")
        lines.append(found[0])
    return lines


def build(work, sha, environment, version):
    """Build SHA at work/release with work/cargo-target as target/, exactly as build.sh lays it out."""
    checkout = work / "release"
    if checkout.exists():
        r.discard_checkout(checkout)
    subprocess.run(["git", "clone", "--quiet", "--no-hardlinks", "--no-checkout", str(ROOT), str(checkout)], check=True)
    subprocess.run(["git", "-C", str(checkout), "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", sha],
                   check=True)
    (work / "cargo-target").mkdir(exist_ok=True)
    # As build.sh: the committed target/ ignore matches a directory, not this symlink.
    with (checkout / ".git/info/exclude").open("a") as exclude:
        exclude.write("/target\n")
    (checkout / "target").symlink_to(work / "cargo-target", target_is_directory=True)
    r.require(not git("status", "--porcelain", root=checkout), f"disposable checkout of {sha} is not clean")
    script = "\n".join(["set -euo pipefail", "root=" + shlex.quote(str(checkout)), *environment[:2],
                        'cd "$root"', environment[2]])
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "RUSTUP_HOME", "CARGO_HOME")}
    env["FACTORY_RELEASE_VERSION"] = version
    start = time.monotonic()
    result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)
    elapsed = time.monotonic() - start
    r.require(result.returncode == 0, f"cargo build of {sha} failed:\n{result.stderr[-4000:]}")
    finished = [line.strip() for line in result.stderr.splitlines() if line.strip().startswith("Finished")]
    print(f"  built {sha} in {elapsed:.1f}s ({'; '.join(finished)})", flush=True)
    return checkout, env, elapsed


def inspect(checkout, env, sha, version, foreign):
    """Hash the shipped binaries and check their embedded identity against the exact SHA."""
    built_at = int(git("show", "-s", "--format=%ct", sha)) * 1000
    result = {}
    for name in BINARIES:
        data = (checkout / "target/release" / name).read_bytes()
        for other in foreign:
            r.require(other.encode() not in data, f"{name} embeds foreign SHA {other}")
        identity = None
        if name in IDENTIFIED:
            identity = json.loads(subprocess.check_output([str(checkout / "target/release" / name), "--build-info"]))
            fingerprint = subprocess.check_output(["bash", "scripts/build-fingerprint.sh", name], cwd=checkout,
                                                  env=env, text=True).strip()
            expected = {"version": version, "git_sha": sha, "git_dirty": False, "built_at_ms": built_at,
                        "inputs_fingerprint": fingerprint}
            r.require(identity == expected, f"{name} embedded identity {identity} != {expected}")
        result[name] = {"sha256": r.digest(data), "size": len(data), "identity": identity}
    return result


def compare(builds):
    """Every scenario must produce identical bytes and identity; there is no threshold."""
    names = list(builds)
    mismatches = [f"{binary}: {names[0]}={builds[names[0]][binary]} {name}={builds[name][binary]}"
                  for name in names[1:] for binary in BINARIES if builds[name][binary] != builds[names[0]][binary]]
    r.require(not mismatches, "byte or identity mismatch:\n" + "\n".join(mismatches))


def seed_for(sha):
    """Default seed: the commit before the last Cargo.lock change, so its lock differs but its toolchain matches."""
    changed = git("log", "-1", "--format=%H", sha, "--", "Cargo.lock")
    return git("rev-parse", changed + "^")


def prove(sha, parent, seed, version):
    sha, parent = git("rev-parse", "--verify", sha + "^{commit}"), git("rev-parse", "--verify", parent + "^{commit}")
    seed = git("rev-parse", "--verify", (seed or seed_for(sha)) + "^{commit}")
    r.require(len({sha, parent, seed}) == 3, "target, parent and seed must be three different commits")
    r.require(git("rev-parse", f"{seed}:Cargo.lock") != git("rev-parse", f"{sha}:Cargo.lock"),
              "seed must have a different Cargo.lock")
    r.require(git("rev-parse", f"{seed}:rust-toolchain.toml") == git("rev-parse", f"{sha}:rust-toolchain.toml"),
              "seed must share the toolchain segment of the cache key")
    environment = release_environment(git("show", f"{sha}:scripts/release/build.sh"))
    version = version or git("show", f"{sha}:VERSION")
    r.version(version)
    toolchain = re.search(r"RUSTUP_TOOLCHAIN=(\S+)", environment[0]).group(1)
    rustc = subprocess.run(["rustc", "-vV"], env={**os.environ, "RUSTUP_TOOLCHAIN": toolchain},
                           capture_output=True, text=True)
    r.require(rustc.returncode == 0 and f"release: {toolchain}\n" in rustc.stdout
              and "host: x86_64-unknown-linux-gnu\n" in rustc.stdout,
              f"Release requires Rust {toolchain} on x86_64-unknown-linux-gnu: {rustc.stdout}{rustc.stderr}")
    r.require(shutil.which("ld.lld"), "build.sh links with -fuse-ld=lld; ld.lld is not on PATH")
    print("target:", sha)
    print("parent:", parent)
    print("seed:", seed, "(different Cargo.lock, same rust-toolchain.toml)")
    print("FACTORY_RELEASE_VERSION:", version, "; built_at_ms: target commit time from shared/build.rs")
    print("environment (build.sh):", *environment, sep="\n  ")
    print("rustc:", rustc.stdout.splitlines()[0], "; linker:",
          subprocess.check_output(["ld.lld", "--version"], text=True).splitlines()[0])
    work = Path(tempfile.mkdtemp(prefix="prove-cache-"))
    builds, timings = {}, {}
    try:
        for scenario, steps in (("warm", [parent, sha]), ("cold", [sha]), ("seeded", [seed, sha])):
            print(f"{scenario}: {' then '.join(steps)} in one cargo target", flush=True)
            shutil.rmtree(work / "cargo-target", ignore_errors=True)
            for step in steps:
                checkout, env, elapsed = build(work, step, environment, version)
                timings[f"{scenario} {step}"] = elapsed
            builds[scenario] = inspect(checkout, env, sha, version, {parent, seed})
    finally:
        if (work / "release").exists():
            r.discard_checkout(work / "release")
        shutil.rmtree(work)
    for binary in BINARIES:
        print(binary)
        for scenario, result in builds.items():
            print(f"  {scenario:6} sha256={result[binary]['sha256']} size={result[binary]['size']}")
        print("  identity:", json.dumps(builds["cold"][binary]["identity"]) if binary in IDENTIFIED
              else "none embedded (no shared build script); byte identity and no parent/seed SHA only")
    print("elapsed seconds:", json.dumps({k: round(v, 1) for k, v in timings.items()}))
    compare(builds)
    print("identical: warm, cold and seeded builds of", sha)


def parse_build_log(text):
    """Split a release build job log into plans: clone line to the next clone or the artifact upload."""
    lines = text.splitlines()
    stamps = []
    for line in lines:
        match = STAMP.search(line)
        stamps.append(datetime.fromisoformat(match.group(1)) if match else None)
    starts = [i for i, line in enumerate(lines) if CLONE.search(line)]
    upload = next((i for i, line in enumerate(lines) if "##[group]Run actions/upload-artifact" in line
                   and starts and i > starts[-1]), len(lines) - 1)
    plans = []
    for start, end in zip(starts, starts[1:] + [upload]):
        head = next((re.search(r"HEAD is now at ([0-9a-f]{7,40})", line).group(1) for line in lines[start:end]
                     if "HEAD is now at " in line), None)
        r.require(head and stamps[start] and stamps[end], "unparseable release build log")
        finished = [line.split("Finished", 1)[1].strip() for line in lines[start:end] if "Finished `release`" in line]
        plans.append({"short_sha": head, "seconds": (stamps[end] - stamps[start]).total_seconds(), "cargo": finished})
    return plans


def job_log(job):
    result = subprocess.run(["gh", "run", "view", "--repo", r.REPO, "--job", str(job), "--log"],
                            capture_output=True, text=True, timeout=300)
    r.require(result.returncode == 0, f"gh run view --job {job} --log failed: {result.stderr[-1200:]}")
    return result.stdout


def release_run_evidence():
    api = r.GitHub()
    change = None
    for commit in api.pages("commits?sha=main&path=.github/workflows/release.yml"):  # newest first
        content = api.request(f"contents/.github/workflows/release.yml?ref={commit['sha']}")["content"]
        if MARKER not in base64.b64decode(content).decode():
            break
        change = commit
    r.require(change, "evidence pending: the repaired release cache key is not on main yet")
    print("change on main:", change["sha"], change["commit"]["committer"]["date"])
    runs = api.pages(f"actions/workflows/release.yml/runs?branch=main&created=>={change['commit']['committer']['date']}",
                     "workflow_runs")
    for run in sorted(runs, key=lambda row: row["id"]):
        # Natural triggers only: continuation batches and operator runs are workflow_dispatch.
        if run["event"] not in ("push", "workflow_run") or run["head_branch"] != "main":
            continue
        if api.request(f"compare/{change['sha']}...{run['head_sha']}")["status"] not in ("ahead", "identical"):
            continue
        r.require(run["status"] == "completed", f"evidence pending: run {run['html_url']} is {run['status']}")
        jobs = {job["name"]: job for job in api.pages(f"actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs", "jobs")}
        if jobs.get("build", {}).get("conclusion") != "success":
            continue  # No bundle was built, so this run reused nothing.
        plans = parse_build_log(job_log(jobs["build"]["id"]))
        if len(plans) < 2:
            continue
        print("run:", run["html_url"], "id", run["id"], "attempt", run["run_attempt"], "event", run["event"],
              "head", run["head_sha"], "conclusion", run["conclusion"])
        r.require(run["conclusion"] == "success" and jobs["publish"]["conclusion"] == "success",
                  f"first multi-plan run {run['id']} did not publish successfully")
        published = dict(re.findall(r"(v\d+\.\d+\.\d+) ([0-9a-f]{40}) (?:complete|already complete)$",
                                    job_log(jobs["publish"]["id"]), re.M))
        for plan in plans:
            tags = [(tag, sha) for tag, sha in published.items() if sha.startswith(plan["short_sha"])]
            r.require(len(tags) == 1, f"plan {plan['short_sha']} has no published tag in run {run['id']}")
            plan["tag"], plan["sha"] = tags[0]
            print(f"  plan {plan['tag']} {plan['sha']} {plan['seconds']:.0f}s cargo: {'; '.join(plan['cargo'])}")
        tag, sha = plans[0]["tag"], plans[0]["sha"]
        inventory = base64.b64decode(api.request(f"contents/deploy/components.json?ref={sha}")["content"])
        with tempfile.TemporaryDirectory() as scratch:
            (Path(scratch) / "inventory.json").write_bytes(inventory)
            verified = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("release.py")), "verify",
                                       "--tag", tag, "--sha", sha, "--inventory", str(Path(scratch) / "inventory.json"),
                                       "--directory", str(Path(scratch) / "bundle")], capture_output=True, text=True)
        r.require(verified.returncode == 0, f"release.py verify {tag} failed: {verified.stderr}{verified.stdout}")
        print(f"verified {tag} {sha}:", verified.stdout.strip())
        return
    raise ValueError("evidence pending: no completed naturally triggered main release run "
                     f"with at least two plans since {change['sha']}; never dispatch one")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", help="target commit")
    parser.add_argument("--parent", help="commit built first into the warm target")
    parser.add_argument("--seed", help="commit with a different Cargo.lock that seeds the third target")
    parser.add_argument("--version", help="fixed FACTORY_RELEASE_VERSION; default: the target's VERSION")
    parser.add_argument("--release-run-evidence", action="store_true")
    args = parser.parse_args()
    if args.release_run_evidence:
        release_run_evidence()
    else:
        r.require(args.sha and args.parent, "--sha and --parent are required")
        prove(args.sha, args.parent, args.seed, args.version)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        sys.exit(f"prove-cache: {error}")
