import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Glass single-choice field. A native `<select>` on purpose: phones get the system picker and
 * the value stays a form value, which the UPS Controls flow and its checks rely on.
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <span data-slot="select-wrapper" className={cn("select-wrapper", className)}>
      <select data-slot="select" className="field" {...props}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" size={16} />
    </span>
  );
}

export { Select };
