# MET-237 spike: ambient scene and glass on factory-console

Can factory-console afford the v2 scene (sky, Teton ridgeline, alpenglow sweep, stars
and aurora) under frosted-glass panels? This spike draws it behind a URL parameter
and measures it on the device before [MET-227](https://linear.app/metacomet/issue/MET-227)
restyles the kiosk.

## Go/no-go rule

Decided by Devon on MET-227: **go** if Chromium averages **≤ 15% CPU over 10 minutes**
on factory-console **with no jank on the sweep**. Otherwise ship `static`: a
pre-blurred static sky, `backdrop-filter` off, and motion only in the band.

For this spike, "Chromium CPU" is `trial_cpu.avg_pct_one_core` from the trial script
(the trial Chrome's whole process tree, as a percentage of one core). Proposed reading
of "no jank", for Devon to confirm: `perf.long_frames_100ms` is 0 and `perf.p99_ms`
stays under 50 ms over the run, and the sweep looks smooth on the panel.

## Modes

Read once at load from `?ambient=`. No parameter, or any other value, renders the v1
kiosk exactly as before: no scene, no v2 styling, no extra requests. `?perf=1` adds
frame instrumentation in any mode, including v1.

| Mode | Draws | Moves |
| -- | -- | -- |
| `both` | Sky gradient; ridgeline band (360 px, far and near ranges, snow, teal rim light); glass panels with `backdrop-filter: blur(18px) saturate(170%)`, edge, sheen, glint and glass shadow. At night, 50 stars and two aurora ellipses. | 60 s sweep; at night, 48 s aurora drift and 6 s star twinkle |
| `sweep` | As `both`, without stars and aurora | 60 s sweep |
| `none` | As `sweep` | Nothing |
| `static` | Sky and band as `sweep`; `backdrop-filter` off on panels, top bar and footer. Panels show a viewport-sized image of the sky and ridge, rendered once, blurred 18 px and saturated 170%, as a fixed background under the same glass tint. | 60 s sweep, only where the band is uncovered |

Every animation is a CSS keyframe on `transform` or `opacity`. The sweep is an HTML layer
masked to the near range, so it animates on the compositor rather than repainting the
SVG. Under `prefers-reduced-motion`, nothing animates in any mode and the scene holds
a still frame. Panels, grid, type and colours outside the scene and glass are v1;
the content restyle is MET-227. Colours come from `tokens.json`, both themes.

Code: `kiosk/src/ambient/` (`mode.ts`, `scene.tsx`, `ambient.css`, `perf.ts`), wired in
`kiosk/src/App.tsx` and `kiosk/src/index.css`.

Captures at 1728×1117 from `vp run ambient:check` against the populated mock (a failing
Network panel and a warning Local LLM panel):
[dark `both`](spike/1728-dark-both.png), [light `both`](spike/1728-light-both.png),
[dark `static`](spike/1728-dark-static.png). The v1 grid covers most of the band; the
MET-227 grid leaves the ridgeline open below the panels.

## Frame instrumentation

With `?perf=1`, a `requestAnimationFrame` sampler records every frame interval and
updates `window.__ambientPerf` every 10 s:

```json
{ "mode": "both", "frames": 0, "long_frames_50ms": 0, "long_frames_100ms": 0,
  "p50_ms": null, "p95_ms": null, "p99_ms": null, "started_ms": 1792270000000 }
```

That is the object at load; `frames` counts intervals since then.

`mode` is `v1` without `?ambient=`. Percentiles use 0.1 ms buckets. Nothing is sent
over the network; the trial script reads the object over the DevTools port.

## Browser check

Against the populated mock (plain, warning and failure panels), with a build of main as
the baseline, from `kiosk/`:

```sh
vp build && MOCK_NETWORK=down vp run mock-preview   # mock :4179, this build on :4180
# A build of origin/main served with KIOSK_API_PROXY=http://127.0.0.1:4179 on :14237, then:
AMBIENT_ORIGIN=http://127.0.0.1:4180 AMBIENT_BASELINE_ORIGIN=http://127.0.0.1:14237 vp run ambient:check
```

Against the sandbox, from the repository root:

```sh
scripts/sandbox up --kiosk
(cd kiosk && vp run ambient:check)   # Playwright Chromium installed for this user
scripts/sandbox down
```

`ambient:check` uses `AMBIENT_ORIGIN`, else this worktree's sandbox, else the mock
preview on :4180. Per theme it checks that the default URL, `?ambient=stars` and
`?perf=1` produce the same DOM classes and the same style on every panel, with no scene.
With `AMBIENT_BASELINE_ORIGIN` set to a build of main against the same API, it also
compares the default URL's classes, panel styles and request paths with main. Classes
that only track live data (`chip-dot-pulse`, `ticker`, `empty`) are reported, not failed.
Any origin other than the sandbox, whose synthetic data is healthy, must show plain,
warning and failure panels. For each mode it checks the scene animation count, no page
scroll and no added dashboard overflow, the perf object, no requests the v1 page does
not make, and zero running animations under reduced motion. On every panel it checks
the `backdrop-filter`, the glass shadow (both inset sheens and the depth drop), and, on
warning and failure panels only, v1's 3 px tone ring and tone border. Captures and
`ambient-check.json` go to `.amp/in/artifacts/ambient/`.

## Trial on factory-console

`kiosk/scripts/ambient-trial.sh <v1|none|static|sweep|both> [minutes=10]`, run as root
on factory-console. It never touches the kiosk, its autostart entry or its profile.

1. **Preflight:** root; host is `factory-console`; exactly one kiosk Chrome (console's
   `--kiosk` browser process); `WAYLAND_DISPLAY`, `DISPLAY`, `XDG_RUNTIME_DIR` (plus
   `XAUTHORITY` and `DBUS_SESSION_BUS_ADDRESS` when present) from its environment; the
   kiosk's `Exec=` flags from `/home/console/.config/autostart/console-kiosk.desktop`;
   Node 24 with a global WebSocket in `agent`'s login shell; no other trial running
   (`flock` on `/run/lock/factory-ambient-trial.lock`).
2. **Trial window:** a separate Chrome as `console` with a fresh `mktemp` profile, the
   kiosk's `Exec=` flags with only `--app` replaced by
   `https://factory-gpu.bearded-pompano.ts.net/?ambient=<mode>&perf=1` (`?perf=1` for
   `v1`), `--start-fullscreen`, and `--remote-debugging-port=0`. It refuses to continue
   unless DevTools listens on 127.0.0.1 only.
3. **Sampling:** after a 15 s settle, every 5 s it reads `/proc/<pid>/stat` for the trial
   Chrome's process tree and, with separate state, the kiosk's. Each process's own CPU
   (utime + stime) counts as it grows. A child that exits and is reaped moves its whole
   total into its parent's reaped CPU (cutime + cstime); the part already counted at the
   previous sample is credited back, so each tick counts once, including children that
   start and finish between samples. Members stay tracked if re-parented; PID reuse is
   detected by start time.
4. **Output:** at the end it reads `window.__ambientPerf` over DevTools with Node (as
   `agent`) and prints one JSON object: `mode`, `minutes`, `url`, `settle_s`,
   `interval_s`, `samples`, `cores`, `trial_cpu` (`avg`/`max` as % of one core and of all
   cores), `kiosk_cpu` (`avg`) and `perf`.
5. **Teardown:** an EXIT trap (also on HUP, INT, PIPE and TERM) kills only the trial
   Chrome's processes (its tree, plus anything naming its profile) and removes the
   profile.

`--dry-run` runs the preflight and prints the planned Chrome command line without
launching anything. The trial window covers the kiosk while it runs; the kiosk keeps
running underneath, so `kiosk_cpu` is its occluded cost, not its visible cost.

Run the modes in this order, 10 minutes each, from the console's own checkout
(`/home/agent/work/factory`, fast-forwarded to the merged main first):

```sh
for mode in v1 none static sweep both; do
  console-ssh "sudo bash /home/agent/work/factory/kiosk/scripts/ambient-trial.sh $mode"
done
```

## Results

Filled in from Devon's runs on factory-console after merge.

| Mode | Trial CPU avg (% one core) | Trial CPU max (% one core) | Trial CPU avg (% all cores) | Kiosk CPU avg (% one core) | Frames | Long > 50 ms | Long > 100 ms | p50 / p95 / p99 ms |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| `v1` | | | | | | | | |
| `none` | | | | | | | | |
| `static` | | | | | | | | |
| `sweep` | | | | | | | | |
| `both` | | | | | | | | |

Decision:
