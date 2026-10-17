import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * PageHeader: eyebrow + title on the left, an optional aside (links, refresh note) on the right.
 * Every routed page starts with one so the rhythm under the top bar is identical.
 */
export function PageHeader({
  eyebrow,
  title,
  aside,
  className,
}: {
  eyebrow?: ReactNode | undefined;
  title: ReactNode;
  aside?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div data-slot="page-header" className={cn("page-header", className)}>
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2 className="page-title">{title}</h2>
      </div>
      {aside && <div className="page-aside muted">{aside}</div>}
    </div>
  );
}
