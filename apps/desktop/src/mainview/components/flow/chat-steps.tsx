// What the model is doing in a chat (spec 70, "Chat"): while a run is in flight, the latest few steps
// from its events as quiet lines ("Reading the projects", "Creating an item in Notes", "Thinking…")
// and its notes as they arrive, read every 2 seconds. Once the reply lands they fold into one line,
// "Did 6 things", that opens to show them all. A finished run's events are read once, and only for a
// turn that changed something (or one this window watched run).
import { flowKey } from "@software-factory/client/flow";
import {
  type ChatStepLine,
  chatStepLines,
  didThings,
} from "@software-factory/client/flow-chat-steps";
import { runSteps } from "@software-factory/client/flow-run";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, LoaderIcon } from "lucide-react";
import { useState } from "react";
import { chatStepsQuery } from "../../lib/flow-chat-queries.ts";
import { flowProjectsQuery } from "../../lib/flow-queries.ts";

/** How many of the latest lines show while the run goes. */
const LIVE_LINES = 4;

function useStepLines(orgId: string, runId: string, live: boolean, wanted: boolean) {
  const client = useQueryClient();
  const projects = useQuery(flowProjectsQuery(orgId));
  const options = chatStepsQuery(client, orgId, runId, live);
  // A run watched here until its reply landed is read on until it says it is done (its last events
  // arrive just after the hand-back).
  const unfinished = client.getQueryData(options.queryKey)?.done === false;
  const events = useQuery({ ...options, enabled: live || wanted || unfinished });
  const projectName = (id: string) => {
    const p = projects.data?.projects.find((x) => x.id === id);
    return p ? p.name : null;
  };
  const lines = events.data ? chatStepLines(runSteps(events.data.events), projectName) : null;
  return { lines, loading: events.isFetching && !events.data, failed: events.isError };
}

/** A live line comes in from below as it arrives; a folded turn's lines just show. */
const ARRIVES = "fade-in-0 slide-in-from-bottom-1 animate-in duration-200 ease-out";

function Line({ line, live }: { line: ChatStepLine; live?: boolean }) {
  return line.kind === "note" ? (
    <p
      className={cn("m-0 line-clamp-3 text-ink-muted italic", live && ARRIVES)}
      data-testid="chat-step-note"
    >
      {line.text}
    </p>
  ) : (
    <p
      className={cn("m-0 truncate text-ink-muted", line.failed && "text-bad", live && ARRIVES)}
      data-testid="chat-step"
    >
      {line.text}
    </p>
  );
}

/** The live steps under a working turn. */
export function LiveSteps({ orgId, runId }: { orgId: string; runId: string }) {
  const { lines } = useStepLines(orgId, runId, true, true);
  const shown = (lines ?? []).slice(-LIVE_LINES);
  return (
    <div className="mt-1 grid gap-1 text-[12.5px]" data-testid="chat-working">
      {shown.map((l) => (
        <Line key={l.seq} line={l} live />
      ))}
      <p className="m-0 flex items-center gap-2 text-ink-faint">
        <LoaderIcon className="size-3.5 animate-spin" />
        Thinking…
      </p>
    </div>
  );
}

/**
 * A finished turn's steps, folded into one line that opens. Read when the turn changed something
 * (`acted`: it has did rows) or this window watched it; a plain answer shows no line.
 */
export function DoneSteps({
  orgId,
  runId,
  acted,
}: {
  orgId: string;
  runId: string;
  acted: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { lines, loading, failed } = useStepLines(orgId, runId, false, open || acted);
  if ((!lines && !acted) || (failed && !lines)) return null;
  if (lines?.every((l) => l.kind === "note")) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-0.5">
      <CollapsibleTrigger
        className="flex items-center gap-1 rounded-[6px] text-[12px] text-ink-faint hover:text-ink-muted"
        data-testid="chat-steps-summary"
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {lines ? didThings(lines) : "What it did"}
        {loading && <LoaderIcon className="ml-1 size-3 animate-spin" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className="mt-1 mb-2 ml-[7px] grid gap-1 border-line-soft border-l pl-3 text-[12.5px]"
          data-testid="chat-steps"
        >
          {(lines ?? []).map((l) => (
            <Line key={l.seq} line={l} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** An item as the side pane names it: `API-13` from its project's key. */
export function itemRef(
  projects: { id: string; key: string }[] | undefined,
  projectId: string | undefined,
  number: number | undefined,
): string | null {
  if (!projectId || number === undefined) return null;
  const project = projects?.find((p) => p.id === projectId);
  return project ? flowKey(project, number) : null;
}
