#!/usr/bin/env bash
set -Eeuo pipefail
root=$(dirname "$(dirname "$(realpath "$0")")")
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# MET-375: from the staged root-owned tree, read only its verified assets (deploy/sudoers/README.md).
if [[ $0 == /usr/local/lib/factory-deploy/* || $root == /usr/local/lib/factory-deploy ]]; then
    # shellcheck source=SCRIPTDIR/sudoers/trusted-assets.sh
    source /usr/local/lib/factory-deploy/deploy/sudoers/trusted-assets.sh
    trusted_assets deploy/sudoers/trusted-assets.sh deploy/rollback-meter.sh deploy/set_ollama_host.py
fi
[[ $EUID -eq 0 ]] || fail 'Run as root: sudo bash deploy/rollback-meter.sh.'
trap 'printf "ERROR: rollback failed at line %s. Pre-install snapshots for manual recovery: /etc/systemd/system/ollama.service.d/override.conf.bak.<timestamp>\n" "$LINENO" >&2' ERR

if systemctl cat meter.service >/dev/null 2>&1; then
    systemctl disable --now meter.service
fi
install -d -m 0755 /etc/systemd/system/ollama.service.d
python3 "$root/deploy/set_ollama_host.py" /etc/systemd/system/ollama.service.d/override.conf 0.0.0.0:11434
systemctl daemon-reload
systemctl restart ollama.service
curl -fsS --max-time 2 --retry 30 --retry-connrefused --retry-delay 1 --retry-max-time 45 http://127.0.0.1:11434/api/version
printf '\nOllama restored on 0.0.0.0:11434. Meter data and binary retained.\n'
printf 'Pre-install snapshots for manual recovery: /etc/systemd/system/ollama.service.d/override.conf.bak.<timestamp>\n'
