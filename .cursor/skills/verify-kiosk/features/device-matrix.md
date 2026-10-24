# Device matrix

Every kiosk page fits each of Devon's devices in every listed orientation: no horizontal scroll, nothing past the viewport or under the Dynamic Island and home indicator, no inner page scrollers, touch targets of at least 44 px, and AA contrast in both themes.

## Sub-features

- `devices-fit` keeps `document.scrollingElement.scrollWidth <= innerWidth` with the layout viewport at the device width on every page.
- `devices-safe-area` keeps text inside the safe-area insets and pads the footer past the home indicator.
- `devices-scroll` scrolls only the document; reserved MET-296 boxes, wide tables and the topology canvas are the only inner scrollers.
- `devices-touch` makes buttons, toggles, fields and top-bar links at least 44 × 44 px on touch screens.
- `devices-contrast` holds text at 4.5:1 and control boundaries at 3:1 over the worst-case scene at each viewport.
- `devices-explanation` shows the topology "How … works" steps inline on a phone: the document scrolls them, with no nested vertical scroller and no horizontal overflow, and every line can be scrolled on screen.
- `devices-navigation` opens an in-app link at the top of its page with the heading below the sticky bar, not at the previous page's offset, and Back/Forward return each page to the offset it was left at.

## How to get to it (user POV)

- Open `/`, `/ups`, `/llm`, `/network`, `/devices/factory-gpu` or `/topology` on one of these devices.
- On `/topology` on an iPhone, choose the flow `Linear dispatch`, then `How linear dispatch works`.
- On `/` on an iPhone or iPad, scroll down to the `Network` card and tap it, then go Back and Forward.

| Device | Name in the run | CSS viewport | DPR | Insets |
| -- | -- | -- | -- | -- |
| iPhone 15 Pro Max, Safari portrait | `iphone-portrait` | 430×739 | 3 | bottom 34 |
| iPhone 15 Pro Max, Safari landscape | `iphone-landscape` | 932×380 | 3 | left and right 59, bottom 21 |
| iPad Air 11-inch (M3) portrait | `ipad-portrait` | 820×1180 | 2 | none |
| iPad Air 11-inch (M3) landscape | `ipad-landscape` | 1180×820 | 2 | none |
| MacBook Pro 14-inch, default scaling | `macbook-14` | 1512×982 | 2 | none |
| 27-inch 2560×1440 monitor | `monitor-27` | 2560×1440 | 1 | none |
| factory-console kiosk screen | `kiosk-console` | 1728×1117 | 1 | none |

## Driving it with verify.mjs

Preconditions:

- `verify.mjs doctor` succeeds for this `VERIFY_ROOT`.
- Playwright Chromium is installed in `PLAYWRIGHT_BROWSERS_PATH`.

- **Run the matrix.** From the repo root, run `BASE_URL=http://127.0.0.1:4181 node .cursor/skills/verify-kiosk/devices.mjs` (output goes to `$VERIFY_ROOT/evidence/devices`). Each context uses the row's viewport, DPR, touch and `isMobile`, and sets the insets with `Emulation.setSafeAreaInsetsOverride`. Without `viewport-fit=cover` the landscape iPhone width drops to 814 px, as Safari letterboxes it. The run ends with `Device matrix: 92 captures (pages × viewports × themes, plus the topology explanation), 0 problem(s).` and exits 0.
- **Narrow a run.** `DEVICES=iphone-portrait,iphone-landscape THEMES=dark` limits devices and themes.
- **Open the explanation.** For `iphone-landscape` (932×380) and `iphone-portrait` (430×739) in both themes, the helper presses the toggle button `Linear dispatch`, then `How linear dispatch works`, and waits for `#topology-steps`. It fails when that box or an ancestor scrolls or clips it vertically, when the page scrolls horizontally, or when any heading, step or legend line, scrolled into view, is not the topmost element at its centre.
- **Follow a link and go Back/Forward.** For the four iPhone and iPad rows (first theme), the helper loads `/`, scrolls the `Network` card to the middle of the screen and taps it. `/network` must open at `scrollY` 0 with its `.page-title` below the top bar. It scrolls `/network` to 240 px, goes Back (the `Network` card must be on screen again), then Forward (`/network` must be back at 240 px). `JOURNEY_ONLY=1` runs only this journey; `<device>-<theme>-network-journey.png` is the final viewport.
- **Proof.** `$VERIFY_ROOT/evidence/devices/<device>-<theme>-<page>.png` is a full-page screenshot; `<device>-<theme>-topology-explanation.png` shows the open explanation. `devices-check.json` records, per capture, the layout viewport, document size, panel width used, smallest font, contrast minimums and every problem.

## Gotchas

- This is Chromium device emulation, not Safari. Toolbar collapse, momentum and rubber-banding on iOS stay unverified until Devon checks the real iPhone and iPad. WebKit needs system libraries outside the environment contract.
- A mobile viewport widens itself (zooms out) when content is too wide, so `scrollWidth <= innerWidth` alone passes. The run also requires `innerWidth` to equal the device width.
- Contrast is measured over the worst scene behind each element's current viewport position. Text below the fold is measured at the bottom of the viewport, over the ridgeline.
- A restored page may still be loading, so its first scroll clamps and Chromium's scroll anchoring then drifts it. `App.tsx` holds the offset while the document grows; a check that reads the offset right after Back/Forward without waiting sees the clamp.
- The dev server on 4181 is slower than the preview on 4180. A timeout waiting for `main .panel` means the app did not render, not a layout failure.
