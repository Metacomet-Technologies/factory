import { StatusChip } from "./status-chip";

export type VerdictIssue = { tone: "fail" | "warn"; label: string };

/**
 * Verdict: the overview's answer to "is everything OK?". One glass strip under the page
 * header with a headline count, the issues as chips (failures first) and how many other
 * checks pass. The strip points; the panels explain.
 */
export function Verdict({ issues, okCount }: { issues: VerdictIssue[]; okCount: number }) {
  const sorted = [...issues].sort((a, b) => Number(b.tone === "fail") - Number(a.tone === "fail"));
  const tone = sorted.some((issue) => issue.tone === "fail")
    ? "fail"
    : sorted.length
      ? "warn"
      : "ok";
  return (
    <section
      data-slot="verdict"
      data-tone={tone}
      className="panel verdict"
      aria-label="Verdict"
      role="status"
    >
      <p className="verdict-title">
        <span className="verdict-dot" aria-hidden="true" />
        {sorted.length
          ? `${sorted.length} need${sorted.length === 1 ? "s" : ""} attention`
          : "All systems nominal"}
      </p>
      {sorted.length ? (
        <ul className="verdict-items" aria-label="Attention items">
          {sorted.map((issue) => (
            <li key={`${issue.tone}:${issue.label}`}>
              <StatusChip tone={issue.tone} dot={issue.tone === "warn"}>
                {issue.label}
              </StatusChip>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="verdict-rest">
        {sorted.length ? `${okCount} other checks OK` : `${okCount} checks OK`}
      </p>
    </section>
  );
}
