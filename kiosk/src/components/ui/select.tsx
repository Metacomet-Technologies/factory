import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Glass single-choice field on Base UI Select: a `combobox` trigger styled like `Input`, and a
 * glass listbox of `option`s. Label it with `<label htmlFor={id}>`. `name` submits the value.
 */
function Select({
  id,
  name,
  value,
  onValueChange,
  options,
  disabled,
  className,
  "aria-describedby": describedBy,
}: {
  id?: string | undefined;
  name?: string | undefined;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly string[];
  disabled?: boolean | undefined;
  className?: string | undefined;
  "aria-describedby"?: string | undefined;
}) {
  return (
    <SelectPrimitive.Root
      name={name}
      value={value}
      disabled={disabled}
      items={options.map((option) => ({ value: option, label: option }))}
      onValueChange={(next) => {
        if (next != null) onValueChange(next);
      }}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-describedby={describedBy}
        data-slot="select-trigger"
        className={cn("field select-trigger", className)}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon className="select-icon">
          <ChevronDown aria-hidden="true" size={16} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner className="select-positioner" sideOffset={4}>
          <SelectPrimitive.Popup data-slot="select-content" className="select-content">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option}
                value={option}
                data-slot="select-item"
                className="select-item"
              >
                <SelectPrimitive.ItemText>{option}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="select-item-indicator">
                  <Check aria-hidden="true" size={14} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export { Select };
