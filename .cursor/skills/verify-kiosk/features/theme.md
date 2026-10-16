# Theme

Theme lets a user switch the dashboard between light and dark from the header. The choice is stored for the next visit in this browser profile.

## Sub-features

- `theme-toggle` flips the visible theme from the header button.
- `theme-persist` writes the same choice to `localStorage` key `factory-theme`.

## How to get to it (user POV)

- Choose the header button named `Use dark theme` when the page is light.
- Choose the header button named `Use light theme` when the page is dark.

## Driving it with verify.mjs

Preconditions:

- `verify.mjs doctor` succeeds for this `VERIFY_ROOT`.
- The Playwright context has no `factory-theme` localStorage entry.

- **Read the control.** The header shows one theme button. Its accessible name is `Use dark theme` or `Use light theme`, which is the theme the click will apply, not the theme already showing.
- **Toggle.** Choose that button. Run `node /home/agent/work/factory/.cursor/skills/verify-kiosk/verify.mjs drive theme`. The button's accessible name flips, `document.documentElement.dataset.theme` changes, and `localStorage['factory-theme']` equals the new theme.
- **Proof.** The command writes `$VERIFY_ROOT/evidence/theme/after.png` and `$VERIFY_ROOT/evidence/theme/after.aria.txt`. The text file names both labels and both theme values. The screenshot shows the heading `factory / kiosk`.

## Gotchas

- The button name is the destination theme. Asserting that `Use dark theme` remains visible after the click means the click did nothing.
- A shared browser profile can already contain `factory-theme`. Drive a fresh context.
- Matching the system color scheme removes the stored preference. A verification click from the default theme sets an explicit preference instead.
- Do not set `dataset.theme` from the console. That skips the control the user presses.
