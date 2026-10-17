import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useAnimatedNumber } from "@/lib/motion";

/**
 * Stat: label above a large tabular number, optional note below.
 * Pass `value` as a number plus `format` to tween live changes; pass a string to render as-is.
 * `size` picks the display scale: "lg" for hero totals, "md" for card metrics, "sm" for dense rows.
 */
export function Stat({
  label,
  value,
  format,
  suffix,
  note,
  size = "md",
  tone,
  className,
}: {
  label: ReactNode;
  value: number | string | null | undefined;
  format?: ((value: number | null) => string) | undefined;
  suffix?: ReactNode | undefined;
  note?: ReactNode | undefined;
  size?: "sm" | "md" | "lg" | undefined;
  tone?: "ok" | "warn" | "fail" | "accent" | undefined;
  className?: string | undefined;
}) {
  const numeric = typeof value === "number" ? value : null;
  const animated = useAnimatedNumber(numeric);
  const text =
    typeof value === "string"
      ? value
      : (format ?? ((n) => (n == null ? "—" : String(Math.round(n)))))(animated);
  return (
    <div data-slot="stat" data-size={size} data-tone={tone} className={cn("stat", className)}>
      {label != null && <p className="stat-label">{label}</p>}
      <p className="stat-value">
        {text}
        {suffix && <span className="stat-suffix">{suffix}</span>}
      </p>
      {note && <p className="stat-note">{note}</p>}
    </div>
  );
}

/** Horizontal row of Stats with equal columns. */
export function StatGrid({
  columns,
  className,
  children,
}: {
  columns?: number | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="stat-grid"
      className={cn("stat-grid", className)}
      style={columns ? ({ "--columns": columns } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}
