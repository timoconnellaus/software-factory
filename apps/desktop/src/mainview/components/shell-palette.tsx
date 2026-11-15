// Search (⌘K, spec 41): the places in the org on screen (its sections and projects) and All orgs.
// ↑ ↓ move, Enter goes, Esc closes. It reads nothing new: the sidebar already loaded the projects.
import { Dialog, DialogContent, DialogTitle } from "@software-factory/ui/components/dialog";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ArrowRightIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { flowProjectsQuery } from "../lib/flow-queries.ts";
import { matchPlaces, type Place, placesIn } from "../lib/places.ts";
import { useFlowOrg } from "./flow/shell.tsx";

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const orgId = useFlowOrg();
  const router = useRouter();
  const projects = useQuery({ ...flowProjectsQuery(orgId ?? ""), enabled: !!orgId && open });
  const [text, setText] = useState("");
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (open) {
      setText("");
      setAt(0);
    }
  }, [open]);

  const rows = useMemo<Place[]>(
    () => (orgId ? matchPlaces(placesIn(orgId, projects.data?.projects ?? []), text) : []),
    [text, projects.data, orgId],
  );

  function go(row: Place | undefined) {
    if (!row) return;
    onOpenChange(false);
    router.history.push(row.to);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        data-testid="palette"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex h-11 items-center gap-2 border-line border-b px-3.5">
          <SearchIcon className="size-4 text-ink-muted" />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="palette-results"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAt((i) => Math.min(i + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setAt((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(rows[at]);
              }
            }}
            placeholder="Go to a section or a project"
            className="h-full flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-muted"
            data-testid="palette-input"
          />
        </div>
        <div id="palette-results" role="listbox" className="max-h-[360px] overflow-y-auto p-1.5">
          {rows.length === 0 && (
            <div className="px-3 py-6 text-center text-ink-muted">Nothing matches.</div>
          )}
          {rows.map((r, i) => (
            <div
              key={r.id}
              role="option"
              tabIndex={-1}
              aria-selected={i === at}
              onMouseMove={() => setAt(i)}
              onClick={() => go(r)}
              onKeyDown={() => undefined}
              className={cn(
                "flex h-9 cursor-default items-center gap-2.5 rounded-[7px] px-2.5",
                i === at && "bg-selected",
              )}
              data-testid="palette-row"
            >
              <ArrowRightIcon className="size-3.5 flex-none text-ink-muted" />
              <span className="truncate">{r.label}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
