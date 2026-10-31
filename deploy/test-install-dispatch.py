#!/usr/bin/env python3
"""Run the real dispatcher installer against a temp root, fake systemctl/sudo/amp and real node."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DROPIN = "etc/systemd/system/factory-dispatch.service.d"
VALID = "# Runner caps (MET-215)\n\n[Service]\n  # tuned without reinstalling\nEnvironment=DISPATCH_RUNNER_CAPS=gpu=4,console=2\n"

FAKES = {
    "hostname": 'echo factory-gpu',
    "getent": 'exit 0',
    # Strip privilege/ownership flags; the temp root belongs to the test user.
    "sudo": 'while [[ $1 == -* ]]; do case $1 in -u|-iu) shift 2 ;; *) shift ;; esac; done; exec "$@"',
    "install": 'args=(); while (($#)); do case $1 in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; exec /usr/bin/install "${args[@]}"',
    "stat": '''out=$(/usr/bin/stat "$@") || exit
me=$(id -un) group=$(id -gn)
out=${out/#$me:$group /root:agent }
printf '%s\\n' "${out/#$me /${FAKE_OWNER:-root} }"''',
    "systemctl": '''echo "systemctl $*" >> "$FIXTURE/calls"
case "$1 $*" in
show*DropInPaths*) case $2 in *.service) echo "${SERVICE_DROPINS:-}" ;; *) echo "${TIMER_DROPINS:-}" ;; esac ;;
show*LoadState*) echo loaded ;;
is-enabled*|is-active*) [[ $2 == --quiet ]] || echo enabled ;;
esac''',
    "amp": '''case "$*" in
--version) echo 'amp fake' ;;
'runner list --json') printf '{"runners":[{"runnerId":"factory-gpu","workingDirectory":"%s","serveCwd":true}]}\\n' "$WORK" ;;
*) exit 9 ;;
esac''',
}


def run(dropin=None, *, service_dropins=None, timer_dropins="", mode=0o644, owner="root",
        symlink=False, extra=()):
    temp = Path(tempfile.mkdtemp(prefix="install-dispatch-"))
    work = temp / "home/agent/work"
    checkout = work / "factory"
    for relative in (".node-version", "deploy/factory-dispatch.service", "deploy/factory-dispatch.timer",
                     "scripts/dispatch/dispatch.lock", "scripts/dispatch/.node-version"):
        (checkout / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / relative, checkout / relative)
    (checkout / "scripts/dispatch/dispatch.ts").write_text("console.log('dry-run stub');\n")
    text = (HERE / "install-dispatch.sh").read_text().replace("[[ $EUID -eq 0 ]]", "[[ $EUID -ne 0 ]]")
    for prefix in ("/etc/", "/var/backups", "/home/agent/work"):
        text = text.replace(prefix, str(temp) + prefix)
    (checkout / "deploy/install-dispatch.sh").write_text(text)
    key = temp / "etc/factory-dispatch/linear-api-key"
    key.parent.mkdir(parents=True)
    key.write_text("synthetic test key\n")
    key.chmod(0o640)
    (temp / "var/backups").mkdir(parents=True)
    caps = temp / DROPIN / "cap.conf"
    caps.parent.mkdir(parents=True)
    if dropin is not None:
        target = temp / "cap-target.conf" if symlink else caps
        target.write_text(dropin)
        target.chmod(mode)
        if symlink:
            caps.symlink_to(target)
    for name in extra:
        (caps.parent / name).write_text("[Service]\nNice=5\n")
    if service_dropins is None:
        service_dropins = str(caps) if dropin is not None else ""
    bin_dir = temp / "bin"
    bin_dir.mkdir()
    for name, body in FAKES.items():
        # env -i in the installer drops variables, so the fake amp gets the path baked in.
        (bin_dir / name).write_text("#!/usr/bin/env bash\n" + body.replace("$WORK", str(work)) + "\n")
        (bin_dir / name).chmod(0o755)
    node = Path(shutil.which("node")).parent
    env = dict(os.environ, FIXTURE=str(temp), FAKE_OWNER=owner,
               SERVICE_DROPINS=service_dropins.replace("@", str(temp) + "/"),
               TIMER_DROPINS=timer_dropins.replace("@", str(temp) + "/"),
               PATH=f"{bin_dir}:{node}:/usr/bin:/bin")
    console = json.dumps({"runners": [{"runnerId": "factory-console", "workingDirectory": str(work),
                                       "serveCwd": True}]})
    result = subprocess.run(["bash", str(checkout / "deploy/install-dispatch.sh")], input=console,
                            env=env, capture_output=True, text=True, timeout=60)
    return temp, caps, result, result.stdout + result.stderr


def passes(dropin, expected):
    temp, caps, result, output = run(dropin)
    before = caps.read_bytes() if dropin is not None else None
    assert result.returncode == 0, output
    assert f"Runner caps drop-in: {expected}\n" in result.stdout, output
    assert "dry-run stub" in output and "Dispatcher timer enabled." in output, output
    assert "systemctl enable --now factory-dispatch.timer" in (temp / "calls").read_text()
    [snapshot] = (temp / "var/backups/factory-dispatch").iterdir()
    if dropin is None:
        assert (snapshot / "cap.conf.missing").is_file() and not caps.exists()
    else:
        assert (snapshot / "cap.conf").read_bytes() == before == caps.read_bytes() == dropin.encode()
    assert "never changed by install or rollback" in output, output
    shutil.rmtree(temp)


def fails(message, dropin=VALID, **kwargs):
    temp, caps, result, output = run(dropin, **kwargs)
    assert result.returncode != 0 and message in output, output
    assert "Runner caps drop-in:" not in output, output
    assert not (temp / "var/backups/factory-dispatch").exists(), output
    calls = (temp / "calls").read_text()
    assert "stop" not in calls and "enable" not in calls, calls
    shutil.rmtree(temp)
    return output


def main():
    installs = [(None, "absent"), (VALID, "gpu=4,console=2")] + [
        (f"[Service]\nEnvironment=DISPATCH_RUNNER_CAPS={caps}\n", caps)
        for caps in ("console=1", "gpu=007,console=2", "gpu=9007199254740991")]
    for dropin, expected in installs:
        passes(dropin, expected)
    print(f"PASS: {len(installs)} installs (no drop-in, valid cap.conf with comments, grammar edges) print caps and snapshot without changing cap.conf")

    service_d = "@" + DROPIN
    cases = [
        ("service.d/caps.conf", dict(service_dropins=f"{service_d}/caps.conf")),  # wrong path
        ("override.conf", dict(service_dropins=f"{service_d}/cap.conf {service_d}/override.conf",
                               extra=["override.conf"])),  # second drop-in
        ("Unexpected", dict(dropin=VALID + "Environment=LINEAR_API_KEY=secret-value\n")),
        ("Unexpected", dict(dropin=VALID.replace("[Service]", "[Service]\nNice=5"))),
        ("Unexpected", dict(dropin=VALID.replace("[Service]", "[Unit]"))),
        ("Unexpected", dict(dropin="# continued \\\n" + VALID)),
        ("Missing", dict(dropin="[Service]\n# no caps\n")),
        ("Unexpected", dict(dropin="Environment=DISPATCH_RUNNER_CAPS=gpu=4\n[Service]\n")),
        ("regular file, not a symlink", dict(symlink=True)),
        ("group/world write (mode 664)", dict(mode=0o664)),
        ("group/world write (mode 646)", dict(mode=0o646)),
        ("root ownership", dict(owner="agent")),
        ("factory-dispatch.timer drop-ins", dict(dropin=None, timer_dropins="@etc/systemd/system/factory-dispatch.timer.d/x.conf")),
        ("factory-dispatch.timer drop-ins", dict(timer_dropins="@etc/systemd/system/factory-dispatch.timer.d/cap.conf")),
    ]
    for value in ("gpu=0", "gpu=4,", ",gpu=4", "gpu=4 ", "gpu=-1", "gpu=x", "", "GPU=4", "orb=1", "cursor=1",
                  "gpu=9007199254740992", "gpu=4;console=2", "gpu=4,console=2,gpu=1", "console=1,console=1"):
        cases.append(("Invalid DISPATCH_RUNNER_CAPS at ", dict(dropin=VALID.replace("gpu=4,console=2", value))))
    for message, kwargs in cases:
        output = fails(message, **kwargs)
        assert "secret-value" not in output, output
    print(f"PASS: {len(cases)} refusals (wrong path, second drop-in, extra directives, bad/duplicate caps, symlink, group/world-writable, owner, timer drop-ins) stop before the snapshot")
    print(f"PASS: {len(installs) + len(cases)} installer cases")


if __name__ == "__main__":
    main()
