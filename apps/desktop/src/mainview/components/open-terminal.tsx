// Open terminal (spec 41): the one escape hatch every session view has in its header, for when a
// run or a planning session is stuck. Today it shows what main has: the run's takeover hint (the
// tmux attach command on its runner, ADR 0380). The web terminal comes with the hosts work (spec 41,
// later slices); with no live run that has a hint, the button isn't shown.
import type { WorkItemDetail } from "@software-factory/client/ops";
import { Button } from "@software-factory/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@software-factory/ui/components/popover";
import { SquareTerminalIcon } from "lucide-react";
import { toast } from "sonner";

/** The newest run that is still going and says how to reach its terminal. */
export function terminalOf(
  runs: WorkItemDetail["runs"],
  stage?: string,
): { label: string; hint: string } | null {
  const live = [...runs]
    .reverse()
    .find((r) => !r.endedAt && r.takeover && (!stage || r.stage === stage));
  return live?.takeover ?? null;
}

export function OpenTerminal({
  detail,
  stage,
  className,
}: {
  detail: WorkItemDetail;
  stage?: string;
  className?: string;
}) {
  const t = terminalOf(detail.runs, stage);
  if (!t) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="md" className={className} data-testid="open-terminal">
          <SquareTerminalIcon className="size-3.5" />
          Open terminal
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] gap-2 text-[13px]">
        <div className="font-medium">{t.label}</div>
        <pre className="m-0 mt-2 whitespace-pre-wrap rounded-md bg-selected p-2 font-mono text-xs">
          {t.hint}
        </pre>
        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() =>
              navigator.clipboard
                .writeText(t.hint)
                .then(() => toast.success("Copied"))
                .catch(() => toast.error("Couldn't copy"))
            }
          >
            Copy
          </Button>
          <span className="text-ink-muted text-xs">
            Run it in Terminal on the runner's Mac. Typing there takes the session over.
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
