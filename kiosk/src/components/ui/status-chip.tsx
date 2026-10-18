import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export type Tone = "ok" | "warn" | "fail" | "neutral" | "accent";

/**
 * StatusChip: tinted pill for state words (Online, Failing, Stale, 2 / 3 online).
 * Tone colors are the semantic tokens; the tint keeps AA text contrast in both themes.
 * `fail` is the one solid chip (the brand never fills) and carries an alert icon unless
 * `icon={false}`. `dot` adds a leading status dot; `pulse` rings it for live states.
 */
export function StatusChip({
  tone = "neutral",
  dot = false,
  pulse = false,
  icon = true,
  className,
  children,
  ...props
}: ComponentProps<"span"> & {
  tone?: Tone | undefined;
  dot?: boolean | undefined;
  pulse?: boolean | undefined;
  icon?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <span
      data-slot="chip"
      data-tone={tone}
      className={cn("chip", tone !== "neutral" && tone !== "accent" && `status-${tone}`, className)}
      {...props}
    >
      {tone === "fail" && icon && <AlertTriangle aria-hidden="true" size={14} />}
      {dot && <span className={cn("chip-dot", pulse && "chip-dot-pulse")} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Inline status text without a pill (table cells, dense rows). */
export function StatusText({
  tone,
  className,
  ...props
}: ComponentProps<"span"> & { tone: Exclude<Tone, "neutral"> }) {
  return (
    <span
      className={cn(tone === "accent" ? "accent-text" : `status-${tone}`, className)}
      {...props}
    />
  );
}
