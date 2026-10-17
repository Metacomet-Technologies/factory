The kiosk's answer to "is everything OK?": one glass strip under the page header, with a headline count, the issues as chips, and how many other checks pass.

New in v2. Source of truth: every failing or warning signal on the overview (fleet nodes, services, UPS, pricing, builds) feeds one list.

**Consumer provides:** `issues` (`{tone: "fail" | "warn", label}[]`, failures first), `okCount`.

- **Headline:** `verdict` 22 px / 650. The dot takes the worst tone and glows.
- **Issues:** fail chips are solid with an icon; warn chips are tinted with a dot. Each label names the thing and what's wrong ("backup failing on factory-console").
- **All clear:** "All systems nominal · N checks OK", with an `ok` dot and no glow ring.
- **Tone:** the strip takes the warn ring whenever anything needs attention.

Do: keep one strip per page, only on the overview. Don't: repeat panel detail in it; the strip points, the panels explain.
