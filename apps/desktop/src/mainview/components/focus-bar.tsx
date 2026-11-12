// Focus mode's bar (spec 41, design PlanFocus): in place of the toolbar while planning has the whole
// window. Shown only on a work item's page, whose loader already loaded the item and its planning.
import { Button } from "@software-factory/ui/components/button";
import { Kbd } from "@software-factory/ui/components/kbd";
import { useQuery } from "@tanstack/react-query";
import { Minimize2Icon } from "lucide-react";
import { planningQuery, workItemQuery } from "../lib/queries.ts";
import { setFocus, updateViewState } from "../lib/view-state.ts";
import { OpenTerminal } from "./open-terminal.tsx";
import { SessionPill } from "./planning.tsx";

/**
 * Focus mode's session bar, in place of the toolbar (spec 41, design PlanFocus): leave focus, the
 * item, the planner's state and the terminal. The window stays draggable by it.
 */
export function FocusBar({ workItemId }: { workItemId: string }) {
  const item = useQuery(workItemQuery(workItemId));
  const planning = useQuery(planningQuery(workItemId));
  const d = item.data;
  return (
    <div
      className="electrobun-webkit-app-region-drag flex h-11 flex-none items-center gap-2.5 pr-2.5 pl-[84px]"
      data-testid="focus-bar"
    >
      <Button
        variant="outline"
        size="md"
        className="electrobun-webkit-app-region-no-drag"
        onClick={() => updateViewState((s) => setFocus(s, null))}
        data-testid="exit-focus"
      >
        <Minimize2Icon className="size-3.5" />
        Exit focus <Kbd className="bg-transparent">Esc</Kbd>
      </Button>
      {d && (
        <>
          <span className="font-mono text-ink-muted">#{d.item.number}</span>
          <span className="truncate font-semibold">{d.item.title}</span>
          <span className="flex-none rounded-full bg-chip-blue px-[7px] py-px font-medium text-[11px] text-chip-blue-ink">
            Planning
          </span>
        </>
      )}
      <span className="flex-1" />
      <span className="electrobun-webkit-app-region-no-drag flex items-center gap-2">
        {planning.data && <SessionPill view={planning.data} />}
        {d && <OpenTerminal detail={d} stage="spec" />}
      </span>
    </div>
  );
}
