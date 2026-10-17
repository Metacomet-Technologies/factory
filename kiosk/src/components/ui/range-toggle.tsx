import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

/**
 * RangeToggle: segmented control for time ranges (1h / 24h / 7d …).
 * Generic over the literal union so `onChange` receives a typed value.
 */
export function RangeToggle<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(values) => {
        const next = values[0];
        if (next != null && options.includes(next as T)) onChange(next as T);
      }}
      aria-label={label}
      size="sm"
      className="range-toggle"
    >
      {options.map((option) => (
        <ToggleGroupItem key={option} value={option}>
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
