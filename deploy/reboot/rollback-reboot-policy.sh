#!/usr/bin/env bash
set -Eeuo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Run as root: sudo bash deploy/reboot/rollback-reboot-policy.sh'
[[ $# -eq 0 ]] || fail 'No arguments expected.'
unset REBOOT_ROOT REBOOT_CONFIG REBOOT_NOW_MS REBOOT_POSTBOOT_WAIT_S PYTHONPATH PYTHONHOME
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
trap 'printf "ERROR: rollback failed at line %s; resolve and rerun.\n" "$LINENO" >&2' ERR
for tool in systemctl rm rmdir dirname; do command -v "$tool" >/dev/null || fail "Missing tool: $tool"; done
for unit in factory-reboot.timer factory-reboot.service factory-postboot.service; do
    if [[ $(systemctl show "$unit" --property=LoadState --value) != not-found ]]; then
        systemctl stop "$unit"
        if [[ $unit != factory-reboot.service ]]; then systemctl disable "$unit"; fi
    fi
done
rm -f /etc/systemd/system/factory-reboot.timer /etc/systemd/system/factory-reboot.service \
    /etc/systemd/system/factory-postboot.service
rm -rf /usr/local/lib/factory-reboot /etc/factory-reboot
systemctl daemon-reload
published=/var/lib/factory-reboot-status
if [[ -f $published/.created-by-install ]]; then
    parent=$published
    while [[ $parent != / ]]; do
        [[ ! -L $parent ]] || fail "Unsafe published status parent: $parent"
        parent=$(dirname "$parent")
    done
    [[ ! -L $published/status.json ]] || fail 'Unsafe published status'
    rm -f -- "$published/status.json" "$published/.created-by-install"
    if [[ -d $published ]] && ! rmdir -- "$published"; then
        printf 'WARNING: left %s in place because it is not empty\n' "$published" >&2
    fi
    echo 'Reboot policy removed. Published reboot status removed. Private status.json, journal logs and installation snapshots retained.'
else
    echo 'Reboot policy removed. status.json, journal logs and installation snapshots retained.'
fi
