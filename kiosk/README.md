# factory / kiosk

A React 19 dashboard for factory-api's v1 contract. MET-114 targets
the API/static origin on factory-gpu; Chrome remains on factory-console.
The app contacts only factory-api; the
optional live verification script sends four small Ollama requests. All authored app,
server, configuration, test and script sources are TypeScript. Both TypeScript
projects enable `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`.

## Manual usage refresh (MET-139)

The Frontier CLIs header has a keyboard-accessible refresh button on all layouts,
including `/?kiosk`. It posts without a body to `/v1/agents/refresh`; this requests
quota reads, not inference or account changes. “Refreshing…” ends on the next
`agents.usage` event; after 90 seconds without one it says “Refresh didn't complete”.
Accepted and cooldown responses disable the button until the server's deadline,
with native title “Next refresh in N s”. Other clients and timer runs can extend
the server cooldown; a 429 supplies the updated deadline. Labeled balances show
`<label>: <amount>` (for example `workspace metacomet: $0`); unlabeled pools retain
their existing formatting. Deploy the API, usage path unit, then kiosk in that order.

## Frontier CLIs (MET-126)

The existing card now shows Amp, Claude Code and ChatGPT account capacity from
`/v1/agents`. It polls on load/every 60 seconds and refetches on `agents.usage`
and SSE reconnect, using the same snapshot invalidation pattern as Fleet/pricing.
Amp's USD and orb-hour pools remain separate; Codex credits are never USD.
Stale values use muted text/bars (not reduced opacity, preserving AA contrast);
unknown values show the reason without quota numbers. Nulls show `—`.
Every non-ok row also shows its reason and, when available, CLI version in
the existing warning color, including stale rows. Observation age remains
visible separately; an old reading never hides the collection failure.
Reset labels have exact UTC native titles; a one-second clock keeps relative
resets and minute ages current between snapshots. Rows are
keyboard focusable. Cursor/Kimi remain a compact not-tracked line.

Normal mock fixtures include all six windows. Set `MOCK_AGENTS_STATUS` to
`ok`, `stale`, `unknown` or `not_tracked` with `vp run mock-dev` to inspect each
state. Desktop quota rows are inline; the existing ticker viewport is shortened
from 210px to 140px and bottom padding from 60px to 56px to fit 1728×1117.
No cards move; phone cards still stack and scroll. No dependencies or deploy
artifacts are added. Regenerate/check API types with `OPENAPI_URL=file:///.../factory-api/openapi.json`;
the MET-125 committed types already match. Install with `deploy/install-kiosk.sh`
only after the MET-125 API deployment; merge and deployment remain human gates.

## Running versions (MET-107 phase 1)

`VERSION` at the repository root controls the kiosk's build-time version.
`package.json` must match it or the build fails. The fixed footer shows
`factory v0.2.0 · api <sha> · kiosk <sha> · meter <sha>` even while the page
scrolls. It distinguishes version/SHA mismatch, any dirty build, and incomplete
identity; legacy meter health without identity displays `meter unknown` rather
than inventing a version. Native title text includes each component's version,
dirty state, and UTC build time. Known versions also appear in Fleet.

Generate types and run the strict check against the updated isolated API using
`OPENAPI_URL=http://127.0.0.1:18080/openapi.json`, not the still-deployed old schema.
The source of truth remains the live OpenAPI response. No drift/lint/type gate is
disabled. Footer tests cover matching builds, independent version/SHA mismatches,
dirty builds, unknown SHA, and missing health/Fleet data.

Desktop Fleet columns fill available space and pricing notices use two columns
to reserve footer space at 1728×1117. Phone/tablet retain scrolling cards with
bottom padding, so the last card can scroll clear of the fixed footer.
See the root README's phase 1 handoff for per-node builds and explicit installer
paths. Release workflows and version-downloading installers remain phases 2–3.

## Toolchain and commands

Install Vite+ in user space with `curl -fsSL https://vite.plus | bash`, then load
`/home/agent/.config/vite-plus/env` in this runner's shell. From `kiosk/`:

```sh
vp env install       # Node 24.21.0 and pnpm 12.11.2, pinned in package.json
vp install
vp run mock-dev     # Native Node TypeScript mock :4179 + vp dev :4181
```

Development and preview bind to loopback. Access remotely through an SSH tunnel
to factory-gpu; no host firewall, production service or Tailscale changes are
needed. Deployment is tailnet-only, served by factory-api on factory-gpu.

## MET-114 origin switch

Follow the root README's **MET-114 move** runbook; no watchdog or new console
web server is needed. Build with `VITE_API_BASE=`. Relative `/v1/*`, SSE and
`/version.json` then use `https://factory-gpu.bearded-pompano.ts.net`, served
through GPU Tailscale Serve to `127.0.0.1:8080`. The existing no-cache manifest
and reload guard work at that origin without a code change or CORS setting.
Browser theme storage is origin-specific; an old console-origin preference
does not transfer automatically.

Only the existing `Exec=` URL changes; preserve every other Chrome flag and
desktop key. From Mac after GPU health and Serve pass:

```sh
console-ssh "sudo -u console cp -p /home/console/.config/autostart/console-kiosk.desktop /home/console/.config/autostart/console-kiosk.desktop.met-114"
console-ssh "sudo -u console sed -i '/^Exec=/s|--app=http://localhost:8080|--app=https://factory-gpu.bearded-pompano.ts.net|' /home/console/.config/autostart/console-kiosk.desktop"
console-ssh "sudo -u console grep '^Exec=' /home/console/.config/autostart/console-kiosk.desktop"
```

Make the backup once, before the first edit. Check exactly one `Exec=` line
has the new URL. UI only: close and relaunch Chrome in the console desktop
session (or log out/in). Changing autostart does not change an already-running
Chrome process. Permissions and the physical session remain an administrator
verification; do not restart the Amp runner. Rollback replaces only the new
URL with `http://localhost:8080`, as printed by the rollback script.

```sh
vp fmt
vp run api:types    # Regenerate committed types from the deployed OpenAPI
vp check            # Live schema drift + format + type-aware lint + types gate
vp test --run       # Testing Library + jsdom, supplied by Vite+
vp build            # kiosk/dist; no mock proxy baked into the bundle
vp run mock-preview # Native mock :4179 + production preview :4180
```

Tasks and test configuration live in `vite.config.ts`; there is no separate
Vitest, ESLint, Prettier or Tailwind config. Tailwind v4 uses `@theme` in
`src/index.css`. Components were added with shadcn's CLI, use Base UI rather
than Radix, and use `tw-animate-css`. System fonts only; no remote fonts,
analytics or CDN assets. Recharts is the dependency supplied by shadcn chart.
Runtime dependencies are limited to React/React DOM, Base UI, lucide-react,
Recharts, class-variance-authority, clsx and tailwind-merge. All components use
the standard local `cn()` helper in `src/lib/utils.ts`. There is no direct `cn`
dependency or runtime import; shadcn's build-only CLI still depends on `cn`
transitively. shadcn and tw-animate-css are development dependencies.
The GPU chart is loaded with React.lazy and a Suspense skeleton only when
history is available, keeping Recharts out of the initial JavaScript bundle.

## API and behavior

`VITE_API_BASE` defaults to same-origin. For phase 3b, build with that default
and serve `dist/` at the API origin. To use another API origin, set
`VITE_API_BASE=https://host:port vp build`; its HTTP and SSE responses must allow
the dashboard origin. Do not put secrets in Vite environment variables.

`src/api/generated.ts` is generated by the dev-only `openapi-typescript` package
from `http://127.0.0.1:8080/openapi.json`. `src/api/types.ts` uses exact schema
aliases and derives endpoint responses from generated paths. The API's SSE
envelope has an unconstrained `data` schema, so its discriminated union uses
the generated payload schemas plus the documented event names. No API change
is needed. Nullable fields may also be omitted in OpenAPI; both render as unknown.

`vp check` fetches and regenerates the live schema in memory, compares it with
the formatted committed file, then runs its normal gates. It fails on drift or
an unreachable API rather than silently accepting a stale contract. Set
`OPENAPI_URL` to another API's OpenAPI URL or a captured `file:///.../openapi.json`
when working offline. Run `vp run api:types` after an intentional contract change.
The drift gate was checked with a scratch schema changing Health.version to
integer: `vp check` fails with “Live OpenAPI has changed”.

Each endpoint polls independently on load and every 60 seconds. Range changes
abort the old request. Fleet and
pricing change events refetch the affected sections; pricing changes also
refresh spend avoided. Request events populate a six-entry, newest-first
ticker. GPU events update the current sample; history comes only from GET.
Native EventSource reconnects automatically. Reconnection refetches Fleet,
GPU/history, usage and pricing snapshots without inventing missed ticker rows.
A disconnect clears live GPU
values rather than presenting stale telemetry as live. Nulls render as `—`,
not zero, except that an online Fleet node with no last-seen timestamp shows
`Last seen now`. Section errors do not blank other sections.

The dashboard follows `prefers-color-scheme`, including changes while it is
open, unless the user selects a theme different from the current system scheme.
`?kiosk` is accepted and ignored; it never forces dark. The theme control saves
an override as `light` or `dark` in localStorage under `factory-theme`, not in
API data. Selecting the system-matching theme clears that key and immediately
resumes following future system changes. Invalid preferences and unavailable
storage follow the system on load. A blocking head script sets the resolved `data-theme` and dark
class before styles or modules load; React initializes from that attribute.
The head's `light-dark()` tokens color both html and body before React starts,
including manual and self-update reloads. No remote script or forced default
is used. Keyboard focus, a skip link, semantic sections,
polite ticker announcements and reduced-motion styles are included.

Phone widths below 640px use stacked cards and per-model cards. 640–1279px uses
a two-column grid. Desktop uses Fleet/GPU above Local LLM and a tool/ticker
side column. The ticker has a keyboard-scrollable bounded viewport. The current
mock fixture fits the 1728×1117 kiosk in both themes (MET-87 verification).
Arbitrarily large real fleets/model lists may still require page scrolling.

## First-paint verification (MET-87)

`vp run screenshots` first reloads with CDP cache disabled and 6× CPU throttling.
It records body background at first contentful paint and every animation frame,
plus every delivered PNG screencast frame. Pixel (0, 0) must match the expected
page token in every captured frame. The first frame and per-case JSON go to
`screenshots/first-frame/` (override with `FIRST_FRAME_DIRECTORY`). The matrix
covers both system schemes, both opposite saved preferences, invalid preferences,
blocked storage, override persistence across reload, and returning to system
following after a system-matching selection. Contrast tokens are resolved through
a hidden element's computed color and recorded as RGB before ratio calculation;
rendered-text pass/fail thresholds are unchanged.

From the repository root, start `scripts/sandbox up --rows 1k --kiosk`, then
use its printed factory-api URL from `kiosk/`:

```sh
FIRST_FRAME_URL="http://127.0.0.1:<sandbox-api-port>/?kiosk" FIRST_FRAME_ONLY=1 vp run screenshots
# Exercise the actual self-update hook with a browser-only changed manifest:
FIRST_FRAME_URL="http://127.0.0.1:<sandbox-api-port>/?kiosk" FIRST_FRAME_ONLY=1 FIRST_FRAME_RELOAD=self-update vp run screenshots
```

Stop the stack with `scripts/sandbox down`. Start it again without `--kiosk`
to check the real built-in placeholder: set `PLACEHOLDER_URL` to that API URL
while the normal mock preview remains available at 4180, then run
`FIRST_FRAME_ONLY=1 vp run screenshots`. Stop the sandbox again afterward.
The placeholder deliberately follows the system rather than saved kiosk state;
its existing 30-second meta refresh and JavaScript fallback are unchanged.

The isolated Chromium run reproduces light frames before dark on the original
build. After the fix, system dark and light produce only `rgb(19, 19, 21)` and
`rgb(246, 246, 247)`, respectively. Opposite saved preferences produce only their
selected token. The same eight kiosk cases pass through self-update reload;
both placeholder schemes pass too. Existing five viewport checks, contrast,
height, overflow, SSE reconnects, range controls and tooltips pass. The tooltip
check now reads the fixture version rather than the obsolete `1.0.0-mock`.
No screenshot baselines or production settings were changed. Mac, physical
iPhone and console session checks remain deployment gates; this PR contributes
to MET-87 and does not close it. Install factory-api and kiosk from the same
combined MET-92 release commit; a static-only install cannot update the placeholder.

## Mock and screenshots

Normal fixtures distinguish local models from reference families: Claude Sonnet
uses `anthropic/claude-sonnet-5.5`; ChatGPT mid-tier uses `openai/gpt-6.1-sol`.
The pending Sonnet 5.6 model is synthetic fixture data, not a provider claim.
Frontier tools are exactly `amp`, `cursor`, `claude-code`, `codex` and `kimi`.
Fixtures also include an offline node, a failing service, pending pricing,
estimated pre-history spend and null prompt tps. Local models are `factory-assist`,
`factory-code` and `factory-assist-max`; `/api/ps` may report `:latest` suffixes.
GPU fixtures represent the supplied RTX 3060: 12,288 MiB, one loaded model,
9,255 MiB loaded memory from the live sample and 110–154 W illustrative samples
below its 170 W limit.
Request throughput is illustrative, not a hardware benchmark. Named mock SSE
frames match the captured transport and include nullable model/token counts.
Outage
fixtures use contract nulls, empty model/history lists and warnings. Mock SSE
emits GPU samples every 3s, requests every 5s and keepalive comments every 15s.
Every response uses only contract fields. Change `MOCK_PORT` to choose another
mock port. `MOCK_OUTAGE=1 vp run mock-dev` runs the entire dashboard against
outage fixtures.

To repeat the production browser check, run `vp run mock-preview` in one
terminal and `vp run mock-outage` in another, then:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.browsers" vp exec playwright install chromium
vp run screenshots
```

Playwright and Chromium install under this user and `kiosk/`; no sudo. The
script verifies native SSE delivery/reconnection, range selection, keyboard
tooltip access, absence of horizontal overflow, kiosk height, phone model
cards and WCAG text contrast. The committed captures were regenerated for
MET-86 with current fixtures, including the Phase 3b GPU and local-model updates:

- [1728 dark](screenshots/1728-dark.png): full default kiosk with the ticker
  filled, all KPIs, pricing, warnings and model table. Older ticker rows scroll
  inside the card rather than enlarging the page.
- [1728 light](screenshots/1728-light.png): the same desktop composition in light.
- [1024 dark](screenshots/1024-dark.png): exact 1024×768 viewport showing the
  two-column layout. [Full page](screenshots/1024-dark-full.png) also shows the
  full-width model table and tool/ticker row.
- [390 dark](screenshots/390-dark.png) and [390 light](screenshots/390-light.png):
  exact 390×844 viewport captures with a compact sticky header and stacked
  cards. [Dark full page](screenshots/390-dark-full.png) and
  [light full page](screenshots/390-light-full.png) also show the per-model cards.
- [Dark details](screenshots/1728-dark-details.png) and
  [light details](screenshots/1728-light-details.png): 7d usage, 24h GPU history,
  keyboard focus and the API health tooltip.
- [Outage](screenshots/1728-dark-outage.png): actual native mock outage responses,
  unknown telemetry/reference values, empty history/usage and warnings.
- [Loading](screenshots/1728-dark-loading.png): held Fleet response with
  skeletons while other sections load successfully.
- [Chart loading](screenshots/1728-dark-chart-loading.png): the lazy chart chunk
  is held to verify the Suspense skeleton while metrics and other sections
  remain usable; releasing it verifies that the real chart renders.
- [Error](screenshots/1728-dark-error.png): injected Fleet HTTP 503 without
  hiding other sections.
- [Reconnecting](screenshots/1728-dark-reconnecting.png): stopped isolated SSE
  mock on port 4184, reconnecting indicator and cleared GPU values; the script
  restarts that mock and checks that native EventSource reconnects. It stops the
  extra mock on exit. Playwright's offline switch did not terminate an existing
  loopback SSE connection, so the check disconnects the source process instead.

`screenshots/checks.json` records viewport/page dimensions and browser-rasterized
contrast measurements for all five required default captures. Screenshots are
review artifacts, not production data. MET-86 regeneration exposed an existing
desktop mock overflow: page height 1,147px at a 1,117px viewport in both themes.
The old last-seen label produces the same height. The normal screenshot check
still fails on this; layout was left unchanged. A temporary capture-only copy
ran the remaining checks and recorded both failures in `checks.json`. All
captures were refreshed; horizontal overflow, contrast, SSE reconnects, range
controls and tooltips passed. Desktop viewport captures cut off the footer.

## Accent and contrast

- Fill: `--primary: oklch(0.38 0.17 300)` in both themes.
- Fill text: `--primary-foreground: #ffffff`, 10.89:1 against primary.
- Dark text/icons/focus: `--accent-text: oklch(0.72 0.15 300)`, 7.12:1 against
  page `#131315` and 6.59:1 against card `#1b1b1e`.
- Light text/icons/focus: `--accent-text: oklch(0.38 0.17 300)`, 10.08:1 against
  page `#f6f6f7` and 10.89:1 against white cards.

The GPU series uses dark-purple fill with an accent-text outline, keeping its
boundary visible in dark mode. Purple never indicates service status. On
cards, dark semantic colors have contrast ratios of 9.77:1 (ok), 10.12:1 (warn)
and 8.17:1 (fail); light equivalents have 6.51:1, 6.31:1 and 6.50:1. Muted
text's lowest measured surface contrast is 6.45:1 dark and 5.17:1 light. The
browser check also inspects each rendered text/background pair rather than
relying only on token calculations.

## Contract gaps resolved against the deployed API

GET health, fleet, usage, GPU, pricing, agents and OpenAPI were captured from
`:8080`. A direct 60-second `curl -N` capture is committed in
[live-stream.txt](screenshots/live-stream.txt), preserving exact `event:` / `data:`
lines and blank-line separators. Source and existing Rust contract tests settle
states that cannot be induced without changing deployed services or pricing.
No outage or pricing confirmation was forced. Those states are **source/test
verified, not live-observed**.

| Gap                        | Real behavior                                                                                                                                                                                                                                                                     | Decision                                                                                                  | Change                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE naming                 | Named `gpu.sample` and `llm.request`, JSON `{type,ts_ms,data}`, independent `: keepalive` every 15s; no `id:`. Initial headers can wait for the first frame (up to 15s).                                                                                                          | Use named listeners and the envelope; retain default-message compatibility.                               | Mock emits exact named framing; browser verifies both real event types.                                                                                                          |
| GPU-event nullability      | Live GET/events have six numeric fields, 12,288 MiB total; idle capture has 13 MiB, 0%, 41 °C, 7.59 W. OpenAPI permits null GET current; collector emits null after upstream failure (source/tests).                                                                              | Null means unknown, never zero or last-known-live.                                                        | Generated GpuCurrent alias; existing null/disconnect handling retained and tested.                                                                                               |
| Pending-model nullability  | Live GET has `pending:null` for both families. Generated PricingChanged permits null/omitted `pending_model_id`; source emits null when pending clears. No pricing event occurred during capture.                                                                                 | Refetch pricing and usage; never infer rates from an event.                                               | Generated payload alias; parser accepts null/omitted ID. No operator pricing write.                                                                                              |
| Aggregate semantics        | Live totals/spend are numeric, warnings empty, with priced and pre-history spend separate. Source/tests retain cached inference rows during outages; a fresh empty cache returns zeros plus warnings. Only inference endpoints count, including failed inference with null usage. | Show supplied totals and warnings. Never sum reference families or turn missing request tokens into zero. | Generated aliases; nullable request fields render `—`; null model groups render “Non-model requests”. Zero-outage fixture represents an empty cache, not loss of cached history. |
| Request replay             | New stream starts with future samples, not the two existing requests. No recent-request GET, event ID or replay exists. Collector syncs every 30s.                                                                                                                                | Ticker is session-only; recover snapshots, not missed ticker entries.                                     | Refetch Fleet, GPU, usage and pricing on native SSE reconnect; keep six-entry ticker.                                                                                            |
| Latency versus load        | Initial usage p50 6,301.823696 ms, p95 6,333.009912 ms, total load 11,261.527431 ms across two requests. Source/tests use Ollama total duration (includes load), falling back to wall time; TPS excludes load.                                                                    | Keep supplied percentiles and cumulative load; do not subtract load.                                      | Replace misleading caption with “Latency includes load; total load is also reported separately.”                                                                                 |
| Missing GPU/Fleet warnings | Live GPU and Fleet have no warnings field or GPU name/count. Fleet has two online nodes with service `ok`, `detail` and latency; usage carries GPU/history warnings (source/tests).                                                                                               | Do not invent hardware metadata or warning fields.                                                        | Keep generic GPU heading, unavailable telemetry, empty history, service details and section HTTP errors; nullable Fleet metadata renders `—`.                                    |

## Self-updating deployments

`vp build` hashes the emitted HTML/assets with SHA-256, embeds that identity in
`index.html` as `<meta name="kiosk-build">`, and emits `/version.json` with the
same `build` value. Identical outputs produce an identical identity. A change
to HTML, CSS or either JavaScript chunk changes it. MET-107 embeds build time,
so rebuilding the same commit also changes the JavaScript and build identity.

The app checks same-origin `/version.json` with `cache: "no-store"` on startup,
every 60 seconds and after every native SSE reconnect. It also checks when
`visibilitychange` makes the page visible, on `pageshow` with `persisted: true`,
and on `online`. These lifecycle events share a 250ms trailing debounce, so a
wake/reconnect burst performs one check. Listeners and pending checks are removed
on cleanup. The deployed static
server already gives this non-asset file `Cache-Control: no-cache`. A changed
valid identity schedules a full reload. A one-second idle tick defers it while
range data is loading, a range toggle is hovered/focused, any tooltip (including
the chart tooltip) is open, or a pointer/key interaction happened within the
last second. Move focus/pointer away to finish the interaction. Failed, missing
or malformed version responses leave the running dashboard intact. Development
without a build meta tag skips these checks. Tests cover unchanged builds,
60-second checks, reconnects, failures, tooltip/range interaction, idle reload,
each lifecycle trigger, ignored hidden/non-persisted events and burst debounce.

The placeholder retains its 30-second meta refresh and now has a 30-second
JavaScript fallback plus an immediate reload when visibility returns. This
placeholder change requires a factory-api binary redeploy; static kiosk
installation alone cannot update it. Already-open old placeholders need one
manual refresh to receive the new fallback. Later dashboard installs use the
build check. Reload preserves the saved theme; range/ticker state resets.

## Live build and administrator handoff

From `kiosk/`, with the deployed API left running:

```sh
VITE_API_BASE= vp build
KIOSK_API_PROXY=http://127.0.0.1:8080 vp preview --host 127.0.0.1 --port 14180 --strictPort
# In another terminal; generates four real factory-assist requests:
vp run screenshots:live
```

`KIOSK_API_PROXY` proxies `/v1` and `/openapi.json` only in dev/preview. It is not
baked into the production bundle. The live check uses native browser SSE,
asserts ticker/GPU values against received frames, waits for usage to refresh,
checks layout/phone cards, and saves exact viewport screenshots plus full-page
tablet/phone views. Stop the preview after verification. No service restarts,
deploy scripts, meter configuration or model changes are part of this check.

Captures: [1728×1117 dark](screenshots/live-1728-dark.png),
[1024×768 dark](screenshots/live-1024-dark.png),
[390×844 dark](screenshots/live-390-dark.png),
[tablet full page](screenshots/live-1024-dark-full.png),
[phone full page](screenshots/live-390-dark-full.png).
[Live checks](screenshots/live-checks.json) now record the MET-86 read-only
capture run: native SSE, Fleet labels and dimensions, with no inference or API
mutation requests. Usage and pricing requests exceeded 60 seconds on the
deployed API, while health, Fleet, GPU and SSE responded. The refreshed live
captures preserve those sections' actual loading state. The unchanged range
loading guard therefore prevents a changed build from reloading on the fully
live page until those requests complete or fail. The lifecycle/reload browser
check used browser-only timeout failures for those two requests, real Fleet/GPU/
SSE, and simulated manifest/index replacement. Hidden events performed no
check; a visible/pageshow/online burst performed one check after 250ms. A changed
identity stayed loaded during an open tooltip and navigated once after dismissal.
This is Chromium simulation, not physical iPhone Safari or console Chrome proof.

The earlier Phase 3b successful run sent four requests (90 prompt tokens, 96 output tokens),
matches all four completions in each browser's real SSE, and sees cached totals
increase from 68 to 94 requests, 58,908 to 81,519 input tokens and 6,325 to
11,191 output tokens. Other tailnet clients generate concurrently; these deltas
are not attributed solely to verification traffic. Each viewport has no
horizontal overflow; desktop scroll height is exactly 1,117px. Its ticker's
partial last visible row is intentional inside a bounded scroll viewport.

The first browser attempt's 5s SSE-open timeout was too short for the API's
15s first-frame cadence. The next attempt assumed an isolated four-row ticker
and failed on concurrent traffic. The corrected check matches our completion
counts/latencies instead of excluding other clients. Self-update verification
also checks a simulated manifest/index replacement in the built app: an unchanged
identity stays loaded, an open API tooltip defers reload, and dismissing it
causes a full navigation to the new identity. No real deployment is performed.

Built directory: `/home/agent/work/factory/kiosk/dist`. Devon installs it:

```sh
sudo bash deploy/install-kiosk.sh /home/agent/work/factory/kiosk/dist
```

Kiosk installation changes only static files and does not restart factory-api.
MET-86 also changes the API's built-in placeholder: **factory-api needs a binary
redeploy for that fallback**, separately from installing this dist. No deployment
or production restart was performed during development.

`vp check`, `vp test --run` (15 tests), `vp build`, Rust fmt, clippy with denied
warnings and workspace tests pass. The live preview is stopped after checking.

## MET-86 console investigation and administrator handoff

Read-only observations on factory-console (Ubuntu 26.04.1, GNOME Wayland):

- Console is UID 1001, session 1: `Active=yes`, `State=active`, `IdleHint=no`,
  `IdleSinceHint=0`, `LockedHint=no`. This does not establish its earlier state.
- Chrome 155.0.8059.39 runs with `--kiosk --app=http://localhost:8080` and the
  error/first-run/password-store flags below, but no background flags.
- Agent cannot read console's autostart files or connect to `/run/user/1001/bus`.
  `gsettings` as agent reads agent settings, even with that bus address; its
  `idle-delay=300` is **not** console's value. Console's blanking/lock/suspend
  policy remains unverified.
- The server currently returns matching dashboard index/manifest identities.
  No first-deploy page/timer history is available. An old hidden/suspended
  placeholder is a hypothesis; the original foreground failure's cause is
  **not established**. Today's hung usage/pricing requests independently block
  reload through the existing loading guard; that is not proof of the old cause.

[Chrome's timer documentation](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
describes minimal throttling for visible pages and minute-level checks for
intensively throttled hidden pages. [Frozen pages](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
do not execute timers or fetch callbacks. Chromium's kiosk switch enters
fullscreen, without a timer/freezing exemption. A truly visible top-level page
should not undergo ordinary background throttling or freezing.

Devon: run this read-only inspection on factory-console. Confirm the current
console session ID first; session IDs can change:

```sh
loginctl list-sessions
loginctl show-session 1 -p Name -p Active -p State -p IdleHint -p IdleSinceHint -p LockedHint -p Type
sudo -u console env XDG_RUNTIME_DIR=/run/user/1001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus bash -c '
  gsettings get org.gnome.desktop.session idle-delay
  gsettings get org.gnome.desktop.screensaver lock-enabled
  gsettings get org.gnome.settings-daemon.plugins.power idle-dim
  gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type
  gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout
  gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type
  gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-battery-timeout
  gdbus call --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver --method org.gnome.ScreenSaver.GetActive
  cat /home/console/.config/autostart/console-kiosk.desktop
'
```

Recommended change, not applied: edit only the existing `Exec=` line in
`/home/console/.config/autostart/console-kiosk.desktop`, preserving other keys:

```ini
Exec=/usr/bin/google-chrome --kiosk --app=http://localhost:8080 --noerrdialogs --disable-session-crashed-bubble --disable-infobars --no-first-run --no-default-browser-check --password-store=basic --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows
```

- `--disable-background-timer-throttling`: disables Blink background timer
  throttling, including on Linux.
- `--disable-renderer-backgrounding`: retains foreground renderer process
  priority; it does not override page freezing.
- `--disable-backgrounding-occluded-windows`: treats reported occluded WebContents
  as visible; it is not Windows-only, but does not override Wayland compositor
  suspension or actual hidden/minimized state.

See [Chromium's switch definitions](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/common/content_switches.cc).
None guarantees execution during OS sleep or page freezing. Apply at the next
planned Chrome/session launch; no kiosk was restarted here.

Only for a physically secured, dedicated read-only console session: these commands
disable automatic blanking, locking, dimming and idle suspend. Disabling locking
reduces physical-access protection; do not apply to Devon's personal session:

```sh
sudo -u console env XDG_RUNTIME_DIR=/run/user/1001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus bash -c '
  gsettings set org.gnome.desktop.session idle-delay 0
  gsettings set org.gnome.desktop.screensaver lock-enabled false
  gsettings set org.gnome.settings-daemon.plugins.power idle-dim false
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type nothing
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type nothing
'
```

Lid-close behavior is unchanged; browser flags cannot prevent independent system
suspend. If refresh still fails while visibly awake, record page visibility,
console/network errors and `chrome://discards` state rather than assuming throttling.

## Tooling deviations and limits

Vite+ 1.1.0 rejects `vp create vite --directory kiosk`: `--directory` is not
supported for the forwarded create-vite template. The supported equivalent was
`vp create vite --no-agent --no-editor --no-git --no-hooks --package-manager pnpm
--no-interactive -- kiosk --template react-ts`.

shadcn 4.21.4 rejects `--base base-ui`; its enum is `radix | base | aria`.
Initialization used the requested command with `--base base`. Generated imports
are `@base-ui/react`; there are no Radix packages. The scaffold's font dependency
was removed for the required system font stack. `lazyPlugins(...) ?? []` makes
the generated config compatible with exact optional property types. Generated
chart keys use explicit `String(...)` for clean type-aware linting.

The chart remains a separate lazy chunk; no size warning is suppressed.
Browser checks use Chromium on this runner, not the physical kiosk screen or
real iOS Safari. Static installation remains Devon's administrator action.
Rust fmt, clippy and workspace tests run locally under repository guidance;
they do not stop or modify deployed services. Only the factory-api placeholder
and its contract test changed in Rust; meter, deploy and running Ollama
configuration are untouched.
