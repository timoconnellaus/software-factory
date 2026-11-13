// The small presentational pieces of the config editors (no reads): a change's class, a one-of-a-
// few picker, and an instructions counter. Kept apart from config-editor.tsx so a page can use them
// without the draft hook's reads (the loaders test follows a page's component imports).
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { cn } from "@software-factory/ui/lib/utils";
import { Chip } from "./shell-list.tsx";

/** The cap on any instructions text (project and org agents and steps: the schemas' max). */
export const INSTRUCTIONS_MAX = 4_000;

/** How a change moves the config, as the engine classified it. */
export function ImpactChip({ value }: { value: string }) {
  return (
    <Chip
      tone={value === "loosens" ? "amber" : value === "tightens" ? "green" : "neutral"}
      data-impact={value}
    >
      {value}
    </Chip>
  );
}

/** One of a few: a ToggleGroup that can't be cleared. */
export function Segmented({
  options,
  value,
  label,
  onChange,
}: {
  options: readonly string[];
  value: string;
  label: string;
  onChange: (v: string) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label={label}
      value={value}
      onValueChange={(v) => v && onChange(v)}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o}
          value={o}
          className="px-3 capitalize data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {o}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** "1,234 / 4,000" under an instructions box, amber near the cap, so it is seen before the error. */
export function CharCount({ value, max = INSTRUCTIONS_MAX }: { value: string; max?: number }) {
  const n = value.length;
  return (
    <span
      className={cn(
        "self-end text-[11px] tabular-nums",
        n > max
          ? "font-medium text-chip-amber-ink"
          : n > max * 0.9
            ? "text-chip-amber-ink"
            : "text-ink-muted",
      )}
      data-testid="char-count"
    >
      {n.toLocaleString("en")} / {max.toLocaleString("en")}
      {n > max ? ": too long to save" : ""}
    </span>
  );
}
