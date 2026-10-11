#!/usr/bin/env bash
set -euo pipefail
root=$(dirname "$(dirname "$(realpath "$0")")")

as_root() {
    if [[ $EUID -eq 0 ]]; then "$@"; else sudo -- "$@"; fi
}

if as_root systemctl cat meter.service >/dev/null 2>&1; then
    as_root systemctl disable --now meter.service
fi
as_root install -d -m 0755 /etc/systemd/system/ollama.service.d
as_root python3 "$root/deploy/set_ollama_host.py" /etc/systemd/system/ollama.service.d/override.conf 0.0.0.0:11434
as_root systemctl daemon-reload
as_root systemctl restart ollama.service
curl -fsS --max-time 2 --retry 30 --retry-connrefused --retry-delay 1 --retry-max-time 45 http://127.0.0.1:11434/api/version
printf '\nOllama restored on 0.0.0.0:11434. Meter data and binary retained.\n'
