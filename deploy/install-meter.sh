#!/usr/bin/env bash
set -Eeuo pipefail
root=$(dirname "$(dirname "$(realpath "$0")")")
binary=${1:-/home/agent/work/factory/target/release/meter}
drop_in=/etc/systemd/system/ollama.service.d/override.conf

if [[ ! -f "$binary" || ! -x "$binary" ]]; then
    printf 'ERROR: meter binary missing or not executable: %s\nBuild as agent first: cargo build --release --locked -p meter\n' "$binary" >&2
    exit 1
fi
if [[ $EUID -ne 0 ]]; then
    printf 'ERROR: run this installer with sudo bash deploy/install-meter.sh [binary-path].\n' >&2
    exit 1
fi
if [[ ! -f "$drop_in" ]]; then
    printf 'ERROR: existing Ollama drop-in not found: %s\n' "$drop_in" >&2
    exit 1
fi
if ! command -v sudo >/dev/null; then
    printf 'ERROR: sudo is required for service-user verification.\n' >&2
    exit 1
fi
trap 'printf "ERROR: meter install failed at line %s. Inspect the error above; use deploy/rollback-meter.sh if services were changed.\n" "$LINENO" >&2' ERR

if ! id meter >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin meter
fi
install -d -o meter -g meter -m 0750 /srv/factory/meter
install -m 0755 "$binary" /usr/local/bin/meter.new
mv -f /usr/local/bin/meter.new /usr/local/bin/meter
install -m 0644 "$root/deploy/meter.service" /etc/systemd/system/meter.service
backup="$drop_in.bak.$(date -u +%Y%m%dT%H%M%S.%NZ)"
cp -p -- "$drop_in" "$backup"
printf 'Ollama drop-in backup: %s\n' "$backup"
python3 "$root/deploy/set_ollama_host.py" "$drop_in" 127.0.0.1:11435
systemctl daemon-reload
systemctl stop meter.service
systemctl restart ollama.service
curl -fsS --max-time 2 --retry 30 --retry-connrefused --retry-delay 1 --retry-max-time 45 http://127.0.0.1:11435/api/version
systemctl enable meter.service
systemctl restart meter.service
curl -fsS --max-time 2 --retry 30 --retry-connrefused --retry-delay 1 --retry-max-time 45 http://127.0.0.1:11434/api/version
curl -fsS --max-time 2 --retry 30 --retry-connrefused --retry-delay 1 --retry-max-time 45 http://127.0.0.1:11434/meter/health
sudo -u meter nvidia-smi -L
# Capture first, then show one byte: piping directly to head can cause SIGPIPE.
tailscale_status=$(sudo -u meter tailscale status --json)
if [[ -z "$tailscale_status" ]]; then
    printf 'ERROR: tailscale status returned empty output for service user meter.\n' >&2
    exit 1
fi
head -c 1 <<< "$tailscale_status"
printf '\n'
curl -fsS --max-time 10 http://127.0.0.1:11434/meter/gpu | python3 -c '
import json, sys
data = json.load(sys.stdin)
fields = ("memory_used_mib", "memory_total_mib", "utilization_percent", "temperature_c", "power_w")
if not data.get("gpus") or any(gpu.get(field) is None for gpu in data["gpus"] for field in fields):
    sys.exit("ERROR: /meter/gpu contains missing or null GPU fields")
print(json.dumps(data, indent=2))
'
printf '\nMeter installed. Service-user NVIDIA/Tailscale and live GPU checks passed.\n'
