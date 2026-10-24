#!/usr/bin/env bash
# Converge this host to the toolchain contract in docs/environments.md, then
# prove it with scripts/env/check. Reruns are safe: it acts only on the items
# the checker reports as failing, so a converged host changes nothing.
#
# Every version comes from the repository: Rust from rust-toolchain.toml,
# Node and Bun from kiosk/package.json devEngines and .node-version (installed
# by Vite+), Vite+ from kiosk/package.json catalog (the checker's expected
# value), Playwright Chromium from the kiosk's locked @playwright/test, and the
# system packages from the checker's contract list.
set -euo pipefail

usage() {
    echo 'Usage: scripts/env/setup.sh [--env <name>] [--ci] [--prebuild] [--check-only]' >&2
    echo 'Without --env: ci with --ci, otherwise factory-gpu (the full contract, nothing exempt).' >&2
    exit 2
}

root=$(realpath "$(dirname "${BASH_SOURCE[0]}")/../..")
args=("$@")
# Tests substitute a fake checker; everything else uses the real one.
check=${ENV_CHECK:-$root/scripts/env/check}
env_name='' ci=0 prebuild=0 check_only=0
while (($#)); do
    case "$1" in
        --env) (($# >= 2)) || usage; env_name=$2; shift 2 ;;
        --ci) ci=1; shift ;;
        --prebuild) prebuild=1; shift ;;
        --check-only) check_only=1; shift ;;
        *) usage ;;
    esac
done
# The default never under-provisions: factory-gpu exempts nothing, so a bare run
# meets every environment's requirements.
if [[ -z "$env_name" ]]; then
    if ((ci)); then env_name=ci; else env_name=factory-gpu; fi
fi
export DEBIAN_FRONTEND=noninteractive
initial_path=$PATH
changes=0

log() { echo "[setup ${SECONDS}s] $*" >&2; }
die() { log "error: $*"; exit 1; }
# Announce a change. Returns 1 under --check-only so the caller skips it.
would() {
    changes=$((changes + 1))
    if ((check_only)); then log "would $*"; return 1; fi
    log "$*"
}

# Where the Vite+ installer puts its env file: VP_HOME, an existing
# ~/.vite-plus, else the XDG split layout.
vp_env_target() {
    if [[ -n "${VP_HOME:-}" ]]; then echo "$VP_HOME/env"
    elif [[ -d "$HOME/.vite-plus" ]]; then echo "$HOME/.vite-plus/env"
    else echo "${XDG_CONFIG_HOME:-$HOME/.config}/vite-plus/env"
    fi
}

vp_env=''
load_tools() {
    # shellcheck source=/dev/null
    if [[ -f "$HOME/.cargo/env" ]]; then . "$HOME/.cargo/env"; fi
    local file
    file=$(vp_env_target)
    if [[ -f "$file" ]]; then
        vp_env=$file
        set +u
        # shellcheck source=/dev/null
        . "$file"
        set -u
    fi
}

failing=()
read_failing() {
    local out status=0
    out=$("$check" --env "$env_name" --failing) || status=$?
    ((status < 2)) || exit "$status"
    failing=()
    if [[ -n "$out" ]]; then mapfile -t failing <<<"$out"; fi
}

# The file bash reads for login shells, which Amp and supervised services use.
login_file() {
    local file
    for file in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
        if [[ -f "$file" ]]; then echo "$file"; return; fi
    done
    # None yet: rustup and the Vite+ installer create ~/.profile.
    echo "$HOME/.profile"
}

persist() {
    local line=". \"$1\"" file
    file=$(login_file)
    if grep -Fqx "$line" "$file" 2>/dev/null; then return 0; fi
    if would "add $line to $file"; then printf '\n%s\n' "$line" >>"$file"; fi
}

if ! command -v python3 >/dev/null; then
    # The checker needs Python before it can name anything else.
    failing=($'python3\tpython3 on PATH\tNone')
else
    load_tools
    read_failing
fi

packages=() rust=0 vite_plus='' js=0 managed=() playwright=0 vp_env_layout='' unmet=()
for line in "${failing[@]}"; do
    IFS=$'\t' read -r name expected actual <<<"$line"
    case "$name" in
        os|layout:checkout) unmet+=("$name: expected $expected, found $actual") ;;
        rust|rust:*) rust=1 ;;
        vite-plus) vite_plus=$expected ;;
        node|node:*|bun)
            js=1
            [[ " ${managed[*]} " == *" ${name%%:*} "* ]] || managed+=("${name%%:*}") ;;
        playwright) ((ci)) || playwright=1 ;;
        layout:vite-plus-env) ((ci)) || vp_env_layout=$expected ;;
        layout:*) unmet+=("$name: expected $expected, found $actual") ;;
        # Every other contract item is a Debian package of that name.
        *) [[ " ${packages[*]} " == *" ${name%%:*} "* ]] || packages+=("${name%%:*}") ;;
    esac
done
for item in "${unmet[@]}"; do log "cannot install $item (see docs/environments.md)"; done

# Convenience tools are orb-only, not part of the build/production contract.
if [[ "$env_name" == orb ]]; then
    for pair in ripgrep:rg fd-find:fdfind jq:jq gh:gh shellcheck:shellcheck entr:entr hyperfine:hyperfine direnv:direnv unzip:unzip; do
        package=${pair%:*} command=${pair#*:}
        # An existing upstream fd also satisfies fd-find.
        if [[ "$package" == fd-find ]] && command -v fd >/dev/null; then continue; fi
        if ! command -v "$command" >/dev/null && [[ " ${packages[*]} " != *" $package "* ]]; then
            packages+=("$package")
        fi
    done
fi

if ((${#packages[@]})) && would "install apt packages: ${packages[*]}"; then
    as_root=()
    if ((EUID)); then
        sudo -n true 2>/dev/null || die "apt needs root. As an administrator run: sudo apt-get install --no-install-recommends -y ${packages[*]}"
        as_root=(sudo -n env DEBIAN_FRONTEND=noninteractive)
    fi
    "${as_root[@]}" apt-get update
    "${as_root[@]}" apt-get install --no-install-recommends -y "${packages[@]}"
    if [[ " ${packages[*]} " == *" python3 "* ]]; then exec "$0" "${args[@]}"; fi
fi

# Install only the requested binary, never companion commands such as ast-grep's
# `sg` (which would shadow the standard Unix command). Verify pinned release bytes.
release_tool() {
    local name=$1 repo=$2 tag=$3 asset=$4 digest=$5 member=${6:-} tmp
    command -v "$name" >/dev/null && return 0
    would "install $name from $repo $tag" || return 0
    (
        tmp=$(mktemp -d)
        trap 'rm -rf "$tmp"' EXIT
        curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/$repo/releases/download/$tag/$asset" -o "$tmp/asset"
        printf '%s  %s\n' "$digest" "$tmp/asset" | sha256sum --check --status
        case "$asset" in
            *.zip) unzip -p "$tmp/asset" "$member" >"$tmp/binary" ;;
            *.tar.*) tar -xOf "$tmp/asset" "$member" >"$tmp/binary" ;;
            *) mv "$tmp/asset" "$tmp/binary" ;;
        esac
        install -m 755 "$tmp/binary" "$HOME/.local/bin/$name"
    )
}

if [[ "$env_name" == orb ]]; then
    export PATH="$PATH:$HOME/.local/bin"
    if [[ ! -d "$HOME/.local/bin" ]] && would 'create ~/.local/bin'; then mkdir -p "$HOME/.local/bin"; fi
    file=$(login_file)
    line="export PATH=\"\$PATH:\$HOME/.local/bin\""
    if ! grep -Fqx "$line" "$file" 2>/dev/null && would "add $line to $file"; then
        printf '\n%s\n' "$line" >>"$file"
    fi
    if ! command -v fd >/dev/null && would 'link fd to Debian fdfind'; then
        ln -s "$(command -v fdfind)" "$HOME/.local/bin/fd"
    fi
    release_tool yq mikefarah/yq v4.54.1 yq_linux_amd64 \
        8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f
    release_tool ast-grep ast-grep/ast-grep 0.51.0 app-x86_64-unknown-linux-gnu.zip \
        a7eead5552d3a8daad70f5d50d935da44bd0c138e946b5b0a96b1d38169fa639 ast-grep
    release_tool just casey/just 1.59.0 just-1.59.0-x86_64-unknown-linux-musl.tar.gz \
        409044617b6f06517c1035e55ca38c8c856ff8b650e41bc2aa1ef82d5903a23e just
    release_tool watchexec watchexec/watchexec v2.8.0 watchexec-2.8.0-x86_64-unknown-linux-musl.tar.xz \
        35ea667cbe4bc96c23ba2a1f46c94c46bc385b67165e3bf621c0e7e4959aa99b \
        watchexec-2.8.0-x86_64-unknown-linux-musl/watchexec
    release_tool scc boyter/scc v4.1.0 scc_Linux_x86_64.tar.gz \
        c7328436d3027f4357d3d7853f7dc3ac2bbcb4ca08f1adad91a27c593884079b scc
    for tool in uv uvx; do
        release_tool "$tool" astral-sh/uv 0.13.5 uv-x86_64-unknown-linux-gnu.tar.gz \
            f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f "uv-x86_64-unknown-linux-gnu/$tool"
    done
fi

cargo_env=0
if [[ -f "$HOME/.cargo/env" ]]; then cargo_env=1; fi
if ((rust)); then
    if ! command -v rustup >/dev/null; then
        cargo_env=1 # rustup-init creates ~/.cargo/env
        if would 'install rustup'; then
            curl -fsSL --proto '=https' --tlsv1.2 https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
            load_tools
        fi
    fi
    # With no argument rustup installs the active toolchain: rust-toolchain.toml's channel and components.
    if would 'install the rust-toolchain.toml toolchain'; then (cd "$root" && rustup toolchain install); fi
fi

if [[ -n "$vite_plus" ]]; then
    js=1
    if would "install Vite+ $vite_plus"; then
        # The installer verifies the package integrity from the npm registry.
        curl -fsSL --proto '=https' --tlsv1.2 https://vite.plus | VP_VERSION=$vite_plus VP_NODE_MANAGER=yes bash
        load_tools
    else
        vp_env=$(vp_env_target) # where the install would put it, for the plan
    fi
fi

# The Vite+ installer leaves a tool system-first when it finds one already on
# PATH (orbs ship /usr/local/bin/bun), so the pin would stay shadowed.
if ((${#managed[@]})) && would "let Vite+ manage ${managed[*]} (vp env on)"; then
    for scope in "${managed[@]}"; do vp env on "$scope"; done
fi
if ((js)) && would 'install the pinned Node and Bun through Vite+ (kiosk devEngines, .node-version)'; then
    (cd "$root/kiosk" && vp env install)
    (cd "$root" && vp env install)
fi

if ((!ci)); then
    if ((cargo_env)); then persist "\$HOME/.cargo/env"; fi
    if [[ -n "$vp_env" ]]; then persist "$vp_env"; fi
    if [[ ! -d "$root/kiosk/node_modules" ]] && would 'install locked kiosk dependencies'; then
        (cd "$root/kiosk" && vp install --frozen-lockfile)
    fi
fi

if ((playwright)) && would "install Playwright Chromium (${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright})"; then
    (cd "$root/kiosk" && vp exec playwright install chromium)
fi

if [[ -n "$vp_env_layout" && ! -e "$vp_env_layout" ]] && would "write $vp_env_layout"; then
    [[ -n "$vp_env" ]] || die 'no Vite+ env file to point the layout at'
    mkdir -p "$(dirname "$vp_env_layout")"
    printf '. "%s"\n' "$vp_env" >"$vp_env_layout"
fi

if ((prebuild)) && would 'build the release sandbox binaries and the kiosk'; then
    # The same build as `scripts/sandbox up --kiosk`, so a snapshot boots warm.
    cargo build --manifest-path "$root/Cargo.toml" --target-dir "$root/target" --release --locked \
        -p sandbox -p meter -p factory-api -p factory-ups-control
    (cd "$root/kiosk" && vp install --frozen-lockfile && VITE_API_BASE='' vp build)
fi

if ((check_only)); then
    log "check only: $changes change(s) planned, nothing changed"
    ((${#unmet[@]} == 0)) || exit 1
    exit 0
fi

if ((ci)) && [[ -n "${GITHUB_PATH:-}" ]]; then
    # Later steps get PATH from GITHUB_PATH, which can only prepend: export just the
    # entries setup put ahead of the original PATH (not Vite+'s appended
    # fallback-bin), in reverse because each line is prepended.
    IFS=: read -ra entries <<<"$PATH"
    prefix=()
    for entry in "${entries[@]}"; do
        [[ ":$initial_path:" != *":$entry:"* ]] || break
        [[ " ${prefix[*]} " == *" $entry "* ]] || prefix+=("$entry")
    done
    for ((i = ${#prefix[@]} - 1; i >= 0; i--)); do echo "${prefix[i]}" >>"$GITHUB_PATH"; done
fi

log "$changes change(s); checking the contract"
exec "$check" --env "$env_name"
