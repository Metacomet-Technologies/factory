import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/utils";

/** Glass text field with a `--border-control` outline; styled by `[data-slot="input"]`. */
function Input({ className, ...props }: InputPrimitive.Props) {
  return <InputPrimitive data-slot="input" className={cn("field", className)} {...props} />;
}

export { Input };
