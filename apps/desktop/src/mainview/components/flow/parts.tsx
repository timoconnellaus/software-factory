// The small pieces the new core's screens share (.kim/mockups/board-and-item-panel.html): the page
// header with its tabs, pills and chips, the owner's avatar, a status's dot, and the placeholder for
// a section still to come.
import type { Chip } from "@software-factory/client/flow";
import { Tabs, TabsList, TabsTrigger } from "@software-factory/ui/components/tabs";
import { cn } from "@software-factory/ui/lib/utils";
import { BotIcon } from "lucide-react";
import type * as React from "react";

/** The content's header: the page's title, its section's tabs, then whatever the page adds. */
export function PageHeader({
  title,
  tabs,
  tab,
  onTab,
  children,
}: {
  title: React.ReactNode;
  tabs?: string[];
  tab?: string;
  onTab?: (tab: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <header
      className="flex h-12 flex-none items-center gap-3 border-line-soft border-b px-4"
      data-testid="page-header"
    >
      <h1 className="truncate font-semibold text-[14px]">{title}</h1>
      {tabs && tabs.length > 0 && (
        <Tabs value={tab} onValueChange={onTab} className="h-full">
          <TabsList variant="line" className="h-full gap-0.5 p-0" data-testid="section-tabs">
            {tabs.map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className="-mb-px h-full flex-none rounded-none border-0 border-transparent border-b-2 px-2.5 font-normal text-[13px] text-ink-muted after:hidden data-[state=active]:border-ink dark:data-[state=active]:border-ink data-[state=active]:font-medium data-[state=active]:text-ink"
              >
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {children}
    </header>
  );
}

/** A quiet pill: the workflow's name, a property. */
export function Pill({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex h-[20px] flex-none items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2 text-[11.5px] text-ink-muted [&>svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

const CHIP: Record<Exclude<Chip, null>, { label: string; className: string }> = {
  working: { label: "Working", className: "border-transparent bg-work-soft text-work" },
  "needs-you": { label: "Needs you", className: "border-need-line bg-need-soft text-need" },
  stopped: { label: "Stopped", className: "border-transparent bg-bad/10 text-bad" },
};

/** Working, Needs you or Stopped, as a card and the panel's header show it. */
export function ChipPill({ chip, className }: { chip: Chip; className?: string }) {
  if (!chip) return null;
  const c = CHIP[chip];
  return (
    <Pill className={cn(c.className, className)} data-testid={`chip-${chip}`}>
      {c.label}
    </Pill>
  );
}

/** An owner's mark: an agent's is square, a person's round. */
export function OwnerMark({ name, kind }: { name: string; kind: "agent" | "person" | "none" }) {
  if (kind === "none") return null;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid size-[17px] flex-none place-items-center border border-line bg-window font-semibold text-[9px] text-ink",
        kind === "person" ? "rounded-full" : "rounded-[5px]",
      )}
    >
      {kind === "agent" && name === "An agent" ? (
        <BotIcon className="size-[11px]" />
      ) : (
        initials(name)
      )}
    </span>
  );
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  return (words[0]?.[0] ?? "?").toUpperCase();
}

/** The colours a workflow's statuses take, in order; the last status is always the done green. */
const DOT_COLOURS = ["#8b6fd6", "#d9822b", "#2f5fd0", "#2aa3b8", "#b45f06", "#c2372d"];

/** A status's dot: the first hollow, the last full, the ones between half full. */
export function StatusMark({ index, count }: { index: number; count: number }) {
  const last = count > 1 && index === count - 1;
  const colour = last ? "var(--ok)" : DOT_COLOURS[index % DOT_COLOURS.length];
  const fill =
    index === 0 && !last
      ? "transparent"
      : last
        ? colour
        : `linear-gradient(90deg, ${colour} 50%, transparent 50%)`;
  return (
    <span
      aria-hidden
      className="inline-block size-[9px] flex-none rounded-full border-2"
      style={{ borderColor: colour, background: fill }}
    />
  );
}

/** A section still to be built: its header and one line. */
export function ComingNext({ title }: { title: string }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col" data-testid="coming-next">
      <PageHeader title={title} />
      <p className="p-6 text-ink-muted">Coming next.</p>
    </main>
  );
}
