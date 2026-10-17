#!/usr/bin/env bash
# MET-237: measure Chromium CPU and frame stats for one ambient mode on factory-console.
#
#   sudo bash ambient-trial.sh [--dry-run] <v1|none|static|sweep|both> [minutes=10]
#
# Opens a separate trial Chrome as `console` (fresh temporary profile, the kiosk's own
# Exec= flags, DevTools on 127.0.0.1 only), samples /proc CPU time for its process tree
# and for the kiosk's every 5 s, reads window.__ambientPerf at the end and prints one JSON
# object. The kiosk itself, its autostart entry and its profile are never touched. An
# EXIT trap kills only the trial Chrome and removes its profile, including on Ctrl-C.
# --dry-run runs the preflight, prints the planned Chrome command line and exits.
set -euo pipefail

usage() {
  echo "usage: ambient-trial.sh [--dry-run] <v1|none|static|sweep|both> [minutes=10]" >&2
  exit 2
}
die() {
  echo "ambient-trial: $*" >&2
  exit 1
}

dry_run=0
args=()
for arg in "$@"; do
  case $arg in
    --dry-run) dry_run=1 ;;
    -h | --help) usage ;;
    *) args+=("$arg") ;;
  esac
done
((${#args[@]} >= 1 && ${#args[@]} <= 2)) || usage
mode=${args[0]}
minutes=${args[1]:-10}
case $mode in
  v1 | none | static | sweep | both) ;;
  *) usage ;;
esac
[[ $minutes =~ ^[1-9][0-9]?$ ]] || die "minutes must be a whole number from 1 to 99"

origin=https://factory-gpu.bearded-pompano.ts.net
if [[ $mode == v1 ]]; then url="$origin/?perf=1"; else url="$origin/?ambient=$mode&perf=1"; fi
interval=5
settle=15

proc=/proc
autostart=/home/console/.config/autostart/console-kiosk.desktop
lock=/run/lock/factory-ambient-trial.lock
# Test hooks, honoured only by --dry-run so a real trial always reads the real system.
if ((dry_run)); then
  proc=${AMBIENT_TRIAL_PROC:-$proc}
  autostart=${AMBIENT_TRIAL_AUTOSTART:-$autostart}
  lock=${AMBIENT_TRIAL_LOCK:-$lock}
fi

# ---- Preflight ---------------------------------------------------------------
[[ $(id -u) == 0 ]] || die "run as root (sudo bash $0 ...)"
host=$(hostname)
[[ $host == factory-console ]] || die "this is $host, not factory-console"
console_uid=$(id -u console) || die "no console user"

exec 9>"$lock"
flock -n 9 || die "another ambient trial is already running ($lock)"

# The kiosk is console's Chrome browser process started with --kiosk (no --type=).
kiosk_pid=
for dir in "$proc"/[0-9]*; do
  uid=
  { while read -r key value _; do
    if [[ $key == Uid: ]]; then
      uid=$value
      break
    fi
  done <"$dir/status"; } 2>/dev/null || continue
  [[ $uid == "$console_uid" ]] || continue
  argv=()
  { mapfile -d '' -t argv <"$dir/cmdline"; } 2>/dev/null || continue
  ((${#argv[@]})) && [[ ${argv[0]##*/} == chrome ]] || continue
  kiosk=0
  for a in "${argv[@]:1}"; do
    case $a in
      --type=*) continue 2 ;;
      --kiosk) kiosk=1 ;;
    esac
  done
  ((kiosk)) || continue
  [[ -z $kiosk_pid ]] || die "more than one kiosk Chrome is running as console ($kiosk_pid, ${dir##*/})"
  kiosk_pid=${dir##*/}
done
[[ -n $kiosk_pid ]] || die "the kiosk Chrome is not running as console"

# The trial window joins the kiosk's display session.
display_env=()
environ=()
mapfile -d '' -t environ <"$proc/$kiosk_pid/environ" || die "cannot read the kiosk environment"
for entry in "${environ[@]}"; do
  case $entry in
    WAYLAND_DISPLAY=* | DISPLAY=* | XDG_RUNTIME_DIR=* | XAUTHORITY=* | DBUS_SESSION_BUS_ADDRESS=*)
      display_env+=("$entry")
      ;;
  esac
done
[[ " ${display_env[*]} " == *" XDG_RUNTIME_DIR="* ]] || die "the kiosk has no XDG_RUNTIME_DIR"
[[ " ${display_env[*]} " == *" WAYLAND_DISPLAY="* || " ${display_env[*]} " == *" DISPLAY="* ]] ||
  die "the kiosk has neither WAYLAND_DISPLAY nor DISPLAY"

# Same flags as the kiosk's Exec= line, with only the --app URL replaced.
[[ -r $autostart ]] || die "cannot read $autostart"
exec_line=$(sed -n 's/^Exec=//p' "$autostart" | head -n 1)
[[ -n $exec_line ]] || die "no Exec= line in $autostart"
[[ $exec_line != *[\"\'\\]* ]] || die "Exec= uses quoting, which this script does not parse"
read -ra exec_argv <<<"$exec_line"
chrome_argv=()
app=0
for a in "${exec_argv[@]}"; do
  case $a in
    %?) ;;
    --app=*)
      chrome_argv+=("--app=$url")
      app=1
      ;;
    *) chrome_argv+=("$a") ;;
  esac
done
((app)) || die "Exec= has no --app= flag"

# Node 24 (global WebSocket) as agent reads window.__ambientPerf over DevTools.
as_agent=(runuser -u agent -- env -i HOME=/home/agent USER=agent LOGNAME=agent PATH=/usr/local/bin:/usr/bin:/bin)
node_check='process.exit(Number(process.versions.node.split(".")[0]) >= 24 && typeof WebSocket === "function" ? 0 : 1)'
# shellcheck disable=SC2016 # $1 expands in the inner shell
"${as_agent[@]}" bash -lc 'cd /tmp && exec node -e "$1"' _ "$node_check" ||
  die "Node 24 with a global WebSocket does not resolve as agent (bash -lc node); stopping"

launch() {
  runuser -u console -- env -i HOME=/home/console USER=console LOGNAME=console \
    PATH=/usr/local/bin:/usr/bin:/bin "${display_env[@]}" \
    "${chrome_argv[@]}" "--user-data-dir=$1" --remote-debugging-port=0 \
    --remote-debugging-address=127.0.0.1 --start-fullscreen
}

if ((dry_run)); then
  echo "preflight ok: kiosk pid $kiosk_pid, console uid $console_uid, mode $mode, $minutes min"
  printf 'planned:'
  # Print the exact command launch() would run, without running it.
  runuser() { printf ' %q' runuser "$@"; }
  launch "<mktemp -d /tmp/ambient-trial.XXXXXX>"
  echo
  exit 0
fi

# ---- Trial -------------------------------------------------------------------
clk=$(getconf CLK_TCK)
cores=$(nproc)
profile=
launcher=

# Every process under the launcher, plus anything still naming the trial profile
# (Chrome's crash handler re-parents itself). The kiosk matches neither.
trial_pids() {
  local dir argv pid
  declare -A seen=()
  [[ -n $launcher ]] && seen[$launcher]=1
  for dir in "$proc"/[0-9]*; do
    pid=${dir##*/}
    { mapfile -d '' -t argv <"$dir/cmdline"; } 2>/dev/null || continue
    [[ " ${argv[*]} " == *"$profile"* ]] && seen[$pid]=1
  done
  read_stats
  local queue=("${!seen[@]}") child
  while ((${#queue[@]})); do
    pid=${queue[0]}
    queue=("${queue[@]:1}")
    for child in ${children[$pid]:-}; do
      [[ -z ${seen[$child]:-} ]] && seen[$child]=1 && queue+=("$child")
    done
  done
  echo "${!seen[@]}"
}

cleanup() {
  local status=$? pids pid alive i
  trap - EXIT HUP INT PIPE TERM
  if [[ -n $profile ]]; then
    pids=$(trial_pids)
    # shellcheck disable=SC2086 # pids is a space-separated list of numbers
    kill -TERM $pids 2>/dev/null || true
    for ((i = 0; i < 50; i++)); do
      alive=0
      for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive=1; done
      ((alive)) || break
      sleep 0.1
    done
    # shellcheck disable=SC2086
    ((alive)) && kill -KILL $pids 2>/dev/null
    if ((status != 0)) && [[ -r $profile/trial.log ]]; then
      echo "ambient-trial: last trial Chrome output:" >&2
      tail -n 20 "$profile/trial.log" >&2
    fi
    [[ $profile == /tmp/ambient-trial.* && -d $profile ]] && rm -rf -- "$profile"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 141' PIPE
trap 'exit 143' TERM

# One pass over /proc: parent links and cumulative CPU ticks (own plus reaped children).
declare -A children=() ticks=()
read_stats() {
  local file line rest pid
  local -a f
  children=()
  ticks=()
  for file in "$proc"/[0-9]*/stat; do
    { read -r line <"$file"; } 2>/dev/null || continue
    pid=${line%% *}
    rest=${line##*) }
    read -ra f <<<"$rest"
    children[${f[1]}]+=" $pid"
    ticks[$pid]=$((f[11] + f[12] + f[13] + f[14]))
  done
}

# Sets delta to the ticks used since the previous call by the tree under $1; state lives
# in prev_<name>. Not run in a subshell, so that state persists.
# shellcheck disable=SC2004 # associative keys need the $ inside (( ))
tree_delta() {
  local root=$1 name=$2 pid child total=0
  local -n prev=prev_$name
  local -A cur=()
  local queue=("$root")
  while ((${#queue[@]})); do
    pid=${queue[0]}
    queue=("${queue[@]:1}")
    [[ -n ${ticks[$pid]:-} ]] || continue
    cur[$pid]=${ticks[$pid]}
    for child in ${children[$pid]:-}; do queue+=("$child"); done
  done
  for pid in "${!cur[@]}"; do
    if [[ -n ${prev[$pid]:-} ]]; then
      ((cur[$pid] > prev[$pid])) && total=$((total + cur[$pid] - prev[$pid]))
    else
      total=$((total + cur[$pid]))
    fi
  done
  prev=()
  for pid in "${!cur[@]}"; do prev[$pid]=${cur[$pid]}; done
  delta=$total
}

profile=$(mktemp -d /tmp/ambient-trial.XXXXXX)
chown "$console_uid" "$profile"
chmod 700 "$profile"
launch "$profile" 9>&- </dev/null >"$profile/trial.log" 2>&1 &
launcher=$!

port=
for ((i = 0; i < 60; i++)); do
  kill -0 "$launcher" 2>/dev/null || die "the trial Chrome exited during startup"
  if [[ -s $profile/DevToolsActivePort ]]; then
    port=$(head -n 1 "$profile/DevToolsActivePort")
    break
  fi
  sleep 0.5
done
[[ $port =~ ^[0-9]+$ ]] || die "the trial Chrome did not open a DevTools port"
listeners=$(ss -Hltn "sport = :$port" | awk '{print $4}')
[[ -n $listeners ]] || die "nothing listens on DevTools port $port"
while read -r address; do
  [[ $address == "127.0.0.1:$port" ]] || die "DevTools listens on $address, not only 127.0.0.1"
done <<<"$listeners"

sleep "$settle"
# shellcheck disable=SC2034 # used through tree_delta's nameref
declare -A prev_trial=() prev_kiosk=()
delta=0
read_stats
tree_delta "$launcher" trial
tree_delta "$kiosk_pid" kiosk
last=${EPOCHREALTIME/./}
samples=()
end=$((SECONDS + minutes * 60))
while ((SECONDS < end)); do
  sleep "$interval"
  kill -0 "$launcher" 2>/dev/null || die "the trial Chrome exited during sampling"
  read_stats
  stamp=${EPOCHREALTIME/./}
  tree_delta "$launcher" trial
  sample="$((stamp - last)) $delta"
  tree_delta "$kiosk_pid" kiosk
  samples+=("$sample $delta")
  last=$stamp
done

# shellcheck disable=SC2016 # JavaScript, not shell
perf_js='
const list = await (await fetch(`http://127.0.0.1:${process.argv[1]}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("perf=1"));
if (!page) throw new Error("no trial page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const value = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("DevTools timeout")), 10000);
  ws.onerror = () => reject(new Error("DevTools WebSocket error"));
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
    params: { expression: "JSON.stringify(window.__ambientPerf ?? null)", returnByValue: true } }));
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) { clearTimeout(timer); resolve(message.result?.result?.value); }
  };
});
ws.close();
process.stdout.write(value ?? "null");
'
# shellcheck disable=SC2016 # $1 and $2 expand in the inner shell
perf=$("${as_agent[@]}" bash -lc 'cd /tmp && exec node --input-type=module -e "$1" "$2"' _ "$perf_js" "$port") ||
  die "could not read window.__ambientPerf over DevTools"

printf '%s\n' "${samples[@]}" | awk -v clk="$clk" -v cores="$cores" -v mode="$mode" \
  -v minutes="$minutes" -v interval="$interval" -v settle="$settle" -v url="$url" -v perf="$perf" '
  {
    pct = $2 * 100 * 1e6 / (clk * $1)
    if (pct > max) max = pct
    us += $1; trial += $2; kiosk += $3; n++
  }
  END {
    avg = trial * 100 * 1e6 / (clk * us)
    kavg = kiosk * 100 * 1e6 / (clk * us)
    printf "{\"mode\":\"%s\",\"minutes\":%d,\"url\":\"%s\",\"settle_s\":%d,\"interval_s\":%d,\"samples\":%d,\"cores\":%d,", mode, minutes, url, settle, interval, n, cores
    printf "\"trial_cpu\":{\"avg_pct_one_core\":%.2f,\"max_pct_one_core\":%.2f,\"avg_pct_all_cores\":%.2f,\"max_pct_all_cores\":%.2f},", avg, max, avg / cores, max / cores
    printf "\"kiosk_cpu\":{\"avg_pct_one_core\":%.2f,\"avg_pct_all_cores\":%.2f},\"perf\":%s}\n", kavg, kavg / cores, perf
  }'
