# Mac helpers: source this file from ~/.zshrc; do not execute it with bash.
# zsh resolves the sourced file's own absolute directory, not the caller's cwd.
# shellcheck disable=SC2296,SC2298
# shellcheck source=client/factory.env
source "${${(%):-%x}:A:h}/factory.env"

_ts_state() { tailscale status --json 2>/dev/null | awk -F'"' '/"BackendState"/{print $4; exit}'; }

# Ensure Tailscale is running, on the factory tailnet, and the host is reachable.
_factory_ready() {
  local host=$1 state i current
  state=$(_ts_state)
  if [[ -z $state ]]; then
    echo "→ starting Tailscale app..."; open -a Tailscale
    for i in {1..15}; do sleep 1; state=$(_ts_state); [[ -n $state ]] && break; done
  fi
  if [[ $state != Running ]]; then
    echo "→ connecting Tailscale (${state:-unknown})..."; tailscale up &>/dev/null
    # The counter limits retries; its value is intentionally unused.
    # shellcheck disable=SC2034
    for i in {1..15}; do sleep 1; [[ $(_ts_state) == Running ]] && break; done
  fi
  [[ $(_ts_state) == Running ]] || { echo "✗ Tailscale not running"; return 1; }
  current=$(tailscale switch --list | awk '/\*$/{print $2}')
  if [[ $current != "$FACTORY_TAILNET" ]]; then
    echo "→ switching tailnet: ${current:-none} → $FACTORY_TAILNET"
    tailscale switch "$FACTORY_TAILNET" >/dev/null || { echo "✗ switch failed"; return 1; }
  fi
  tailscale ping -c 1 --timeout 5s "$host" &>/dev/null || { echo "✗ can't reach $host"; return 1; }
}

# RDP credentials go to FreeRDP over stdin, never its process arguments.
_factory_rdp() {
  local host=$1; shift
  _factory_ready "$host" || return 1
  local log=~/Library/Logs/$host-desktop.log pidf=~/Library/Logs/$host-desktop.pid pw old pid
  local user=${FACTORY_RDP_USER:-${FACTORY_SSH_USER:-$USER}}
  local account=${FACTORY_RDP_KEYCHAIN_ACCOUNT:-$user}
  mkdir -p ~/Library/Logs || return 1
  pw=$(security find-generic-password -s "$FACTORY_RDP_KEYCHAIN" -a "$account" -w) || { echo "✗ no RDP password in Keychain"; return 1; }
  if [[ -r $pidf ]] && old=$(cat "$pidf") && ps -p "$old" -o comm= 2>/dev/null | grep -q freerdp; then
    kill "$old" && echo "→ closed existing $host session" && sleep 1
  fi
  printf '%s\n' /v:"$host" /u:"$user" /p:"$pw" /cert:tofu /dynamic-resolution +clipboard /kbd:remap:0x15b=0x1d "$@" \
    | nohup sdl-freerdp /args-from:stdin >"$log" 2>&1 &
  pid=$!
  disown "$pid"
  echo "$pid" >"$pidf"
  unset pw
  echo "✓ connecting to $host (log: $log)"
}

# Forward SSH arguments from the caller, exactly as the ssh CLI does.
# shellcheck disable=SC2029
gpu-ssh()     { _factory_ready "$FACTORY_GPU" && ssh "${FACTORY_SSH_USER:-$USER}@$FACTORY_GPU" "$@"; }
gpu-desktop() { _factory_rdp "$FACTORY_GPU" "$@"; }
gpu-dash()    { _factory_ready "$FACTORY_GPU" && open "https://$FACTORY_GPU.$FACTORY_TS_DOMAIN"; }

# shellcheck disable=SC2029
console-ssh()     { _factory_ready "$FACTORY_CONSOLE" && ssh "${FACTORY_SSH_USER:-$USER}@$FACTORY_CONSOLE" "$@"; }
console-desktop() { _factory_rdp "$FACTORY_CONSOLE" "$@"; }

# PiKVM's read-only root cannot install Ghostty's terminfo.
# shellcheck disable=SC2029
kvm-ssh() { _factory_ready "$FACTORY_KVM" && TERM=xterm-256color ssh "$FACTORY_KVM_USER@$FACTORY_KVM" "$@"; }
kvm-web() { _factory_ready "$FACTORY_KVM" && open "$FACTORY_KVM_WEB"; }

# Health checks are read-only; failures are displayed beside each component.
factory-status() {
  local ok="\033[32m✓\033[0m" bad="\033[31m✗\033[0m" url="https://$FACTORY_GPU.$FACTORY_TS_DOMAIN" h t code p
  _factory_chk() { if eval "$2" &>/dev/null; then echo -e "  $ok $1"; else echo -e "  $bad $1"; fi; }
  _factory_ready "$FACTORY_GPU" >/dev/null 2>&1 || return 1
  echo "== tailnet ($(tailscale switch --list | awk '/\*$/{print $2}'))"
  for h in "$FACTORY_GPU" "$FACTORY_CONSOLE" "$FACTORY_KVM"; do _factory_chk "$h reachable" "tailscale ping -c 1 --timeout 3s $h"; done
  for h in "$FACTORY_GPU" "$FACTORY_CONSOLE"; do
    echo "== $h"
    ssh -o ConnectTimeout=5 "${FACTORY_SSH_USER:-$USER}@$h" 'bash -s' -- "$FACTORY_GPU" "$FACTORY_TS_DOMAIN" <<'R'
ok="\033[32m✓\033[0m"; bad="\033[31m✗\033[0m"
units="tailscaled amp-runner gnome-remote-desktop ufw factory-backup.timer"
[ "$(hostname)" = "$1" ] && units="$units ollama meter factory-api" || units="$units gdm"
for u in $units; do systemctl is-active -q "$u" && echo -e "  $ok $u" || echo -e "  $bad $u ($(systemctl is-active "$u"))"; done
f=$(systemctl --failed --no-legend --plain | awk '{print $1}' | paste -sd' '); [ -z "$f" ] && echo -e "  $ok no failed units" || echo -e "  $bad failed: $f"
if [ "$(hostname)" = "$1" ]; then
  nvidia-smi &>/dev/null && echo -e "  $ok GPU: $(nvidia-smi --query-gpu=memory.used,memory.total,temperature.gpu --format=csv,noheader)" || echo -e "  $bad GPU not responding"
  s=$(cat /sys/class/net/enp42s0/speed 2>/dev/null); [ "${s:-0}" -ge 1000 ] && echo -e "  $ok ethernet ${s} Mb/s" || echo -e "  $bad ethernet speed: ${s:-down}"
  tailscale serve status 2>/dev/null | grep -q 127.0.0.1:8080 && echo -e "  $ok tailscale serve -> :8080" || echo -e "  $bad tailscale serve missing"
  l=$(ss -H -ltn "sport = :8080" | awk '{print $4}' | paste -sd" "); [ "$l" = 127.0.0.1:8080 ] && echo -e "  $ok api loopback only" || echo -e "  $bad api listening on: ${l:-nothing}"
else
  pgrep -u console -f -- "--app=https://$1.$2" >/dev/null && echo -e "  $ok kiosk Chrome -> $1" || echo -e "  $bad kiosk Chrome not on the GPU URL"
  [ "$(systemctl is-active factory-api)" != active ] && echo -e "  $ok old console API stopped (rollback copy)" || echo -e "  $bad old console API is running"
  tailscale serve status 2>/dev/null | grep -q 8080 && echo -e "  $bad console still serving :8080" || echo -e "  $ok console serve off"
fi
d=$(df --output=pcent / | tail -1 | tr -dc 0-9); [ "$d" -lt 85 ] && echo -e "  $ok disk / ${d}%" || echo -e "  $bad disk / ${d}%"
[ -f /var/run/reboot-required ] && echo -e "  \033[33m!\033[0m reboot required" || true
R
  done
  echo "== endpoints"
  _factory_chk "meter health" "curl -sf --max-time 5 http://$FACTORY_GPU:11434/meter/health"
  _factory_chk "ollama via meter" "curl -sf --max-time 5 http://$FACTORY_GPU:11434/api/version"
  _factory_chk "dashboard HTTPS" "curl -sf --max-time 5 -o /dev/null $url/"
  _factory_chk "kiosk version.json" "curl -sf --max-time 5 $url/version.json | jq -e .build"
  _factory_chk "fleet all green" "curl -sf --max-time 10 $url/v1/fleet | jq -e '[.nodes[].services[].ok] | all'"
  _factory_chk "kvm web redirects to login" "curl -sk --max-time 5 -o /dev/null -w '%{http_code}' $FACTORY_KVM_WEB/ | grep -qx 302"
  for p in "v1/llm/usage?range=24h" "v1/pricing"; do
    read -r code t < <(curl -s -o /dev/null --max-time 90 -w '%{http_code} %{time_total}' "$url/$p")
    if [[ $code == 200 && ${t%.*} -lt 2 ]]; then echo -e "  $ok $p ${t}s"; else echo -e "  $bad $p (HTTP $code, ${t}s)"; fi
  done
}

# Run agent tools in the main checkout (read-only work only).
_factory_agent() {
  local host=$1 tool=$2; shift 2 2>/dev/null
  # funcstack is a zsh builtin array.
  # shellcheck disable=SC2154
  case $tool in
    claude|amp|agent|opencode|codex|kimi) ;;
    *) print -u2 "usage: ${funcstack[2]} {claude|amp|agent|opencode|codex|kimi} [args...]"; return 2 ;;
  esac
  _factory_ready "$host" || return 1
  # zsh quotes each argument, then joins them for the remote login shell.
  # shellcheck disable=SC2296
  ssh -t "${FACTORY_SSH_USER:-$USER}@$host" \
    "sudo -iu agent env -C /home/agent/work/factory $tool ${(j: :)${(q)@}}"
}
gpu-agent()     { _factory_agent "$FACTORY_GPU" "$@"; }
console-agent() { _factory_agent "$FACTORY_CONSOLE" "$@"; }

# zsh's functions table tests whether completion has been initialized.
# shellcheck disable=SC2154
if (( $+functions[compdef] )); then
  _factory_agent_tools() { _values tool claude amp agent opencode codex kimi; }
  compdef _factory_agent_tools gpu-agent console-agent
fi
