Eyebrow and title on the left, an aside on the right; every routed page starts with one.

Source: `ui/page-header.tsx`, `index.css:286-305`.

**Consumer provides:** `title`, optional `eyebrow` (11 px uppercase `accent-text`), `aside` (rendered `.muted`; links, a refresh note or a RangeToggle), `className`.

Title 26 px / 600 / −0.6 px; 22 px at ≥1280 and 23 px below 640, where the header stacks and the aside left-aligns. Margin below 20 px (10 at ≥1280; 0 on details pages, whose grid gap spaces it).
