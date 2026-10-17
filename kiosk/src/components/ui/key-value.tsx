import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * KeyValue: a definition list of label/value rows (model cards, host facts, settings).
 * Values stay in the foreground color; labels are muted.
 */
export function KeyValue({
  rows,
  className,
}: {
  rows: readonly (readonly [label: ReactNode, value: ReactNode])[];
  className?: string | undefined;
}) {
  return (
    <dl data-slot="key-value" className={cn("key-value", className)}>
      {rows.map(([label, value], index) => (
        <div className="key-value-row" key={typeof label === "string" ? label : index}>
          <dt className="muted">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
