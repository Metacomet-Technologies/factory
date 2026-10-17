import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * MeterBar: a 0–100 fill with optional threshold markers.
 * Uses a native <progress> for semantics; width transitions animate live changes.
 * `tone` colors the fill; "muted" is for stale readings (keeps contrast, signals age).
 */
export function MeterBar({
  value,
  label,
  tone = "accent",
  markers = [],
  className,
}: {
  value: number | null | undefined;
  label: string;
  tone?: "accent" | "ok" | "warn" | "fail" | "muted" | "foreground" | undefined;
  markers?: { at: number; label?: string | undefined }[] | undefined;
  className?: string | undefined;
}) {
  const clamped = value == null ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div data-slot="meter" data-tone={tone} className={cn("meter", className)}>
      <progress aria-label={label} max={100} value={value == null ? undefined : clamped} />
      <span className="meter-fill" style={{ "--fill": `${clamped}%` } as CSSProperties} />
      {markers.map((marker) => (
        <i
          key={marker.at}
          className="meter-marker"
          title={marker.label}
          style={{ left: `${Math.min(100, Math.max(0, marker.at))}%` }}
        />
      ))}
    </div>
  );
}
