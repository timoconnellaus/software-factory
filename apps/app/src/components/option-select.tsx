// A shadcn Select over a list of plain options. Radix Select can't hold "" as an item's value, so
// an option whose value is "" (none, default, any) goes through a sentinel and comes back as "".
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";

const NONE = "__none__";

export type Option = string | { value: string; label?: string; disabled?: boolean };

export function OptionSelect({
  value,
  options,
  onChange,
  placeholder,
  size = "sm",
  className,
  disabled,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  value: string;
  options: readonly Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "sm" | "default";
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  const items = options.map((o) => (typeof o === "string" ? { value: o } : o));
  const hasNone = items.some((o) => o.value === "");
  // With no "" option, an empty value shows the placeholder (Radix allows "" on the root).
  const current = value === "" && hasNone ? NONE : value;
  return (
    <Select
      value={current}
      onValueChange={(v) => onChange(v === NONE ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger size={size} className={className} aria-label={ariaLabel} data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((o) => (
          <SelectItem key={o.value || NONE} value={o.value || NONE} disabled={o.disabled}>
            {o.label ?? o.value}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
