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

# ---- CPU accounting ------------------------------------------------------------
# Sourcing this file defines only these functions (kiosk/src/ambient/trial.test.ts).
proc=/proc
declare -A children=() parent=() started=() own=() reaped=()
# One pass over $proc: each pid's parent, start time, own CPU (utime + stime) and reaped
# CPU (cutime + cstime: everything its waited-for children used, recursively).
read_stats() {
  local file line pid
  local -a f
  children=() parent=() started=() own=() reaped=()
  for file in "$proc"/[0-9]*/stat; do
    { read -r line <"$file"; } 2>/dev/null || continue
    pid=${line%% *}
    read -ra f <<<"${line##*) }"
    children[${f[1]}]+=" $pid"
    parent[$pid]=${f[1]}
    own[$pid]=$((f[11] + f[12]))
    reaped[$pid]=$((f[13] + f[14]))
    started[$pid]=${f[19]}
  done
}

# Sets delta to the CPU ticks the tree under $1 used since the previous call for the same
# name, counting each tick once. Not run in a subshell, so its state persists:
#   prev_<name>  pid -> "start own reaped parent" as last counted
#   owed_<name>  pid -> "start ticks": CPU already counted for exited descendants that has
#                not yet appeared in that process's reaped CPU
# Own CPU counts as it grows. A member that exits and is reaped moves its whole total
# into its parent's reaped CPU, so its counted total (plus anything still owed to it)
# becomes owed by its parent, and the parent's reaped growth pays that off before any of
# it counts. Owed CPU carries across samples, because /proc is not read atomically: the
# parent may be read before the reap and the child after it. A member gone by the end of
# the pass departs in this sample even though it was read, because the parent may have
# been read after the reap. A child that starts and exits between samples is counted
# once, through its parent's reaped CPU. Members stay tracked if re-parented; identity is
# pid plus start time; a member that leaves through a process outside the tree is dropped.
# shellcheck disable=SC2034 # used through tree_delta's namerefs
declare -A prev_trial=() prev_kiosk=() owed_trial=() owed_kiosk=()
delta=0
# shellcheck disable=SC2004 # associative keys need the $
tree_delta() {
  local root=$1 name=$2 pid child s o r p po pr g c n line total=0
  local -n prev=prev_$name carried=owed_$name
  local -A cur=() gone=() grow=() owed=() departed=()
  local -a queue=("$root") f
  for pid in "${!prev[@]}"; do
    read -r s _ <<<"${prev[$pid]}"
    [[ ${started[$pid]:-} != "$s" ]] || queue+=("$pid")
  done
  while ((${#queue[@]})); do
    pid=${queue[0]}
    queue=("${queue[@]:1}")
    [[ -n ${own[$pid]:-} && -z ${cur[$pid]:-} ]] || continue
    cur[$pid]="${started[$pid]} ${own[$pid]} ${reaped[$pid]} ${parent[$pid]}"
    for child in ${children[$pid]:-}; do queue+=("$child"); done
  done
  for pid in "${!cur[@]}"; do
    line=
    { read -r line <"$proc/$pid/stat"; } 2>/dev/null || true
    read -ra f <<<"${line##*) }"
    [[ ${f[19]:-} == "${cur[$pid]%% *}" ]] || gone[$pid]=1
  done
  for pid in "${!cur[@]}"; do
    read -r s o r _ <<<"${cur[$pid]}"
    po=0
    pr=0
    [[ ${prev[$pid]:-} != "$s "* ]] || read -r _ po pr _ <<<"${prev[$pid]}"
    ((o <= po)) || total=$((total + o - po))
    grow[$pid]=$((r > pr ? r - pr : 0))
    [[ -z ${gone[$pid]:-} ]] || departed[$pid]=${cur[$pid]}
  done
  for pid in "${!prev[@]}"; do
    [[ ${cur[$pid]:-} == "${prev[$pid]%% *} "* ]] || departed[$pid]=${prev[$pid]}
  done
  for pid in "${!carried[@]}"; do
    read -r s c <<<"${carried[$pid]}"
    [[ ${cur[$pid]:-} != "$s "* && ${departed[$pid]:-} != "$s "* ]] || owed[$pid]=$c
  done
  # Settle departures deepest first, so a chain of exits carries up to a live member.
  while read -r _ pid; do
    [[ -n $pid ]] || continue
    read -r _ o r p <<<"${departed[$pid]}"
    c=${owed[$pid]:-0}
    if [[ -n ${gone[$pid]:-} ]]; then
      g=${grow[$pid]}
      ((g <= c)) && c=$((c - g)) || total=$((total + g - c)) c=0
    fi
    unset "owed[$pid]"
    [[ -z ${departed[$p]:-} && -z ${cur[$p]:-} ]] || owed[$p]=$((${owed[$p]:-0} + o + r + c))
  done < <(for pid in "${!departed[@]}"; do
    n=0
    p=${departed[$pid]##* }
    while [[ -n ${departed[$p]:-} ]] && ((n < 64)); do
      n=$((n + 1))
      p=${departed[$p]##* }
    done
    echo "$n $pid"
  done | sort -rn)
  prev=()
  carried=()
  for pid in "${!cur[@]}"; do
    [[ -z ${gone[$pid]:-} ]] || continue
    prev[$pid]=${cur[$pid]}
    g=${grow[$pid]}
    c=${owed[$pid]:-0}
    ((g <= c)) && c=$((c - g)) || total=$((total + g - c)) c=0
    ((c == 0)) || carried[$pid]="${cur[$pid]%% *} $c"
  done
  delta=$total
}
# Stop here when sourced.
if (return 0 2>/dev/null); then return 0; fi

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
