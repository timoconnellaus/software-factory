// Open terminal (spec 41, spec 42): the one escape hatch every session view has in its header, for
// when a run or a planning session is stuck. Pressing it opens the session's live terminal in place
// (TerminalDock: over the lower part of the page, resizable, Expand to the window, Esc or Close to
// leave it with the session still running). Only when the terminal can't be reached does the panel
// say why, with the tmux command behind "Attach from a terminal instead". With no live run, the
// button isn't shown.
import type { WorkItemDetail } from "@software-factory/client/ops";
import { Button } from "@software-factory/ui/components/button";
import { SquareTerminalIcon } from "lucide-react";
import { useState } from "react";
import { type TerminalRun, terminalOf } from "../lib/terminal.ts";
import { TerminalDock } from "./terminal-panel.tsx";

export { terminalOf };

export function OpenTerminal({
  detail,
  stage,
  className,
}: {
  detail: WorkItemDetail;
  stage?: string;
  className?: string;
}) {
  const [open, setOpen] = useState<TerminalRun | null>(null);
  const run = terminalOf(detail.runs, stage);
  if (!run && !open) return null;
  return (
    <>
      {run && (
        <Button
          variant="outline"
          className={className}
          aria-pressed={!!open}
          onClick={() => setOpen((o) => (o ? null : run))}
          data-testid="open-terminal"
        >
          <SquareTerminalIcon className="size-3.5" />
          {open ? "Close terminal" : "Open terminal"}
        </Button>
      )}
      {open && (
        <TerminalDock workItemId={detail.item.id} run={open} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
