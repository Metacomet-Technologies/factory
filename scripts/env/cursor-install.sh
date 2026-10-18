#!/usr/bin/env bash
# Cloud Agent install for factory: converge to the repo's toolchain contract
# (docs/environments.md, scripts/env/setup.sh). Idempotent.
set -euo pipefail
cd /workspace

# Retire the pre-MET-225 hand-rolled toolchain so it can't shadow the Vite+ pins.
sudo rm -f /etc/profile.d/factory-dev.sh
sudo rm -rf /usr/local/lib/factory-bin /home/agent/.config/vite-plus

# Layout: the checkout at /home/agent/work/factory, owned by this user.
sudo install -d -o "$(id -un)" -g "$(id -gn)" /home/agent /home/agent/work /home/agent/.config
ln -sfn /workspace /home/agent/work/factory

# Toolchains, Playwright, kiosk deps, release sandbox binaries and kiosk build.
bash scripts/env/setup.sh --prebuild
