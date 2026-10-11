#!/usr/bin/env bash
set -euo pipefail
root=$(dirname "$(dirname "$(realpath "$0")")")

as_root() {
    if [[ $EUID -eq 0 ]]; then "$@"; else sudo -- "$@"; fi
}

# Build as the invoking user, before changing any services.
cargo build --manifest-path "$root/Cargo.toml" --release --locked -p meter
as_root true
if ! id meter >/dev/null 2>&1; then
    as_root useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin meter
fi
as_root install -d -o meter -g meter -m 0750 /srv/factory/meter
as_root install -m 0755 "$root/target/release/meter" /usr/local/bin/meter.new
as_root mv -f /usr/local/bin/meter.new /usr/local/bin/meter
as_root install -m 0644 "$root/deploy/meter.service" /etc/systemd/system/meter.service
as_root install -d -m 0755 /etc/systemd/system/ollama.service.d
as_root python3 "$root/deploy/set_ollama_host.py" /etc/systemd/system/ollama.service.d/override.conf 127.0.0.1:11435
as_root systemctl daemon-reload
as_root systemctl stop meter.service
as_root systemctl restart ollama.service
curl -fsS --max-time 2 --retry 30 --retry-connrefused --retry-delay 1 --retry-max-time 45 http://127.0.0.1:11435/api/version
as_root systemctl enable meter.service
as_root systemctl restart meter.service
curl -fsS --max-time 2 --retry 30 --retry-connrefused --retry-delay 1 --retry-max-time 45 http://127.0.0.1:11434/api/version
curl -fsS --max-time 2 --retry 30 --retry-connrefused --retry-delay 1 --retry-max-time 45 http://127.0.0.1:11434/meter/health
printf '\nMeter installed. If verification failed, run deploy/rollback-meter.sh.\n'
