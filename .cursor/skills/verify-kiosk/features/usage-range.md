# Usage range

Usage range lets a user switch the Local LLM page (`/llm`) between the last 24 hours, 7 days, and 30 days. The dashboard asks the API again for that window.

## Sub-features

- `usage-24h` is the default window when the page loads.
- `usage-7d` requests seven days.
- `usage-30d` requests thirty days.

## How to get to it (user POV)

- On the dashboard, choose the Local LLM card (link named `Local LLM usage, pricing and model details`). On the `/llm` page, choose `24h`, `7d`, or `30d` in the control labeled `Usage range` next to the heading `Local LLM · Usage & spend`.
- Open `http://127.0.0.1:4181/llm` directly.

## Driving it with verify.mjs

Preconditions:

- `verify.mjs doctor` succeeds for this `VERIFY_ROOT`.
- The dashboard's Local LLM card has finished loading and shows a Requests metric.

- **Default.** Load `http://127.0.0.1:4181/`. The browser requests `GET /v1/llm/usage?range=24h` on the mock. Choose the link `Local LLM usage, pricing and model details`. The URL becomes `/llm`, and the `24h` toggle in `Usage range` is pressed.
- **Seven days.** Choose `7d` inside the group named `Usage range`. The browser requests `GET /v1/llm/usage?range=7d`, and `7d` is pressed.
- **Thirty days.** Choose `30d` inside that same group. The browser requests `GET /v1/llm/usage?range=30d`, and `30d` is pressed.
- **Run it.** `node .cursor/skills/verify-kiosk/verify.mjs drive usage` does every step above.
- **Proof.** Save a screenshot of the `/llm` page and a text file listing the three request URLs to `$VERIFY_ROOT/evidence/usage-range/`. The heading `factory` stays visible.

## Gotchas

- The dashboard card has no range control; it shows the range chosen on `/llm` in its subtitle. Looking for `Usage range` on `/` fails.
- `1h` is a GPU range, not a usage range. The usage control only offers `24h`, `7d`, and `30d`.
- A pressed toggle without a matching `/v1/llm/usage?range=` request is not proof. The card can keep showing the previous payload.
- The mock returns HTTP 400 for any other range value. Do not invent a fourth range to force a success.
