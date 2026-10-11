# factory / kiosk

A read-only React 19 dashboard for factory-api's v1 contract. Phase 3a uses a
standalone fixture API; it never contacts meter or Ollama. All authored app,
server, configuration, test and script sources are TypeScript. Both TypeScript
projects enable `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`.

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
needed. The final deployment is tailnet-only, served by factory-api on
factory-console; that integration belongs to phase 3b.

```sh
vp fmt
vp check            # Single format + type-aware lint + types gate
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

Types are hand-written in `src/api/types.ts`. Each endpoint polls independently
on load and every 60 seconds. Range changes abort the old request. Fleet and
pricing change events refetch the affected sections; pricing changes also
refresh spend avoided. Request events populate a six-entry, newest-first
ticker. GPU events update the current sample; history comes only from GET.
Native EventSource reconnects automatically. A disconnect clears live GPU
values rather than presenting stale telemetry as live. Nulls render as `—`,
not zero. Section errors do not blank other sections.

Open `/?kiosk` to default to dark regardless of system preference. Without that
flag, the dashboard follows `prefers-color-scheme`, including changes while it
is open, until the user selects a theme. The theme control is local UI state,
not a mutation of API data. Keyboard focus, a skip link, semantic sections,
polite ticker announcements and reduced-motion styles are included.

Phone widths below 640px use stacked cards and per-model cards. 640–1279px uses
a two-column grid. Desktop uses Fleet/GPU above Local LLM and a tool/ticker
side column. The default fixture fits the 1728×1117 kiosk without page scrolling
even after the ticker fills; the ticker has a keyboard-scrollable bounded
viewport. Arbitrarily large real fleets/model lists may require page scrolling.

## Mock and screenshots

Normal fixtures distinguish local models from reference families: Claude Sonnet
uses `anthropic/claude-sonnet-5.5`; ChatGPT mid-tier uses `openai/gpt-6.1-sol`.
The pending Sonnet 5.6 model is synthetic fixture data, not a provider claim.
Frontier tools are exactly `amp`, `cursor`, `claude-code`, `codex` and `kimi`.
Fixtures also include an offline node, a failing service, pending pricing,
estimated pre-history spend and null prompt tps. Outage
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
cards and WCAG text contrast, then writes these committed captures:

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
review artifacts, not production data.

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

## Contract ambiguities for phase 3b

- SSE transport names are unspecified. The hook accepts default `message`
  frames and named events, using the JSON `{type, ts_ms, data}` envelope in
  either case. No extra fields are added.
- `gpu.sample` is described as `data = current`, but GET `current` is nullable.
  The hook accepts null samples and renders unknown telemetry.
- `pricing.changed.pending_model_id` has no stated nullability. The reader
  tolerates null and refreshes GET pricing instead of inferring pricing state.
- Usage totals and spend amounts are not nullable in the contract. The outage
  fixture uses zero aggregates with explicit unavailable warnings, not invented
  nullable fields; the real API must define how unavailable aggregates behave.
- No recent-request GET, event IDs or replay contract exists. The ticker starts
  empty and cannot recover requests missed before load or during disconnection.
- Per-model p50/p95 latency's relationship to load duration is unspecified.
  The UI shows supplied latency unchanged and labels `total_load_ms` separately;
  it does not subtract load time or invent an average.
- No GPU name/count or telemetry-warning field exists. The UI says “GPU” and
  “Telemetry unavailable”, without inferring hardware details. Fleet has no
  warnings array; service details and explicit section errors provide its status.

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

Initial JavaScript is 382.66 kB / 122.02 kB gzip, down from 708.68 kB /
221.24 kB gzip (46.0% smaller before compression). The separately loaded chart
chunk is 328.92 kB / 98.08 kB gzip. No bundle-size warning remains or is suppressed.
This splits delivery rather than reducing total chart code. Browser
checks run Chromium on this runner, not real iOS Safari/Blink devices. The real
factory-api, embedding, production deployment and tailnet access are phase 3b
and remain unverified. Rust builds/tests/clippy are intentionally not run:
this task explicitly prohibits rebuilding meter. Rust files and running meter /
Ollama are untouched.
