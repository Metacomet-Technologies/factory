# Usage range

Usage range lets a user switch the Local LLM card between the last 24 hours, 7 days, and 30 days. The dashboard asks the API again for that window.

## Sub-features

- `usage-24h` is the default window when the page loads.
- `usage-7d` requests seven days.
- `usage-30d` requests thirty days.

## How to get to it (user POV)

- In the Local LLM card, choose `24h`, `7d`, or `30d` in the control labeled `Usage range`.

## Driving it with verify.mjs

Preconditions:

- `verify.mjs doctor` succeeds for this `VERIFY_ROOT`.
- The Local LLM section labeled `Local LLM` has finished loading and shows a Requests metric.

- **Default.** Load `http://127.0.0.1:4181/`. The browser requests `GET /v1/llm/usage?range=24h` on the mock. The `24h` toggle in `Usage range` is pressed.
- **Seven days.** Choose `7d` inside the group named `Usage range`. The browser requests `GET /v1/llm/usage?range=7d`, and `7d` is pressed.
- **Thirty days.** Choose `30d` inside that same group. The browser requests `GET /v1/llm/usage?range=30d`, and `30d` is pressed.
- **Proof.** Save a screenshot of the Local LLM card and a text file listing the three request URLs to `$VERIFY_ROOT/evidence/usage-range/`. The heading `factory / kiosk` stays visible.

## Gotchas

- `1h` is a GPU range, not a usage range. The usage control only offers `24h`, `7d`, and `30d`.
- A pressed toggle without a matching `/v1/llm/usage?range=` request is not proof. The card can keep showing the previous payload.
- The mock returns HTTP 400 for any other range value. Do not invent a fourth range to force a success.
