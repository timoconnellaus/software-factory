// Search (⌘K, spec 41): the places in the app and the work items the app has loaded, by number or
// title. ↑ ↓ move, Enter goes, Esc closes. It reads nothing new: the shell already loaded the lists.
import { Dialog, DialogContent, DialogTitle } from "@software-factory/ui/components/dialog";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { matchItems, PLACE_COMMANDS } from "../lib/places.ts";
import { workListsQuery } from "../lib/queries.ts";
import { useSession } from "../lib/session.ts";
import { useOrgScope } from "./shell-sidebar.tsx";

type Row =
  | { kind: "place"; id: string; label: string; to: string; search?: Record<string, string> }
  | { kind: "item"; id: string; label: string; number: number; status: string };

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const session = useSession();
  const orgId = useOrgScope();
  const navigate = useNavigate();
  const items = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (open) {
      setQuery("");
      setAt(0);
    }
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const places: Row[] = PLACE_COMMANDS.filter(
      (p) => !q || p.label.toLowerCase().includes(q) || p.keywords.includes(q),
    ).map((p) => ({ kind: "place", ...p }));
    const scoped = (items.data ?? []).filter((i) => orgId === null || i.orgId === orgId);
    const found: Row[] = matchItems(scoped, query).map((i) => ({
      kind: "item",
      id: i.id,
      label: i.title,
      number: i.number,
      status: i.status,
    }));
    return /^#?\d+$/.test(q) ? [...found, ...places] : [...places, ...found];
  }, [query, items.data, orgId]);

  function go(row: Row | undefined) {
    if (!row) return;
    onOpenChange(false);
    if (row.kind === "item") void navigate({ to: "/work/$id", params: { id: row.id } });
    else void navigate({ to: row.to, search: row.search ?? {} });
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
            // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into.
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="palette-results"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
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
            placeholder="Search work items by number or title, or go to a place"
            className="h-full flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-muted"
            data-testid="palette-input"
          />
        </div>
        <div id="palette-results" role="listbox" className="max-h-[360px] overflow-y-auto p-1.5">
          {rows.length === 0 && (
            <div className="px-3 py-6 text-center text-ink-muted">
              Nothing loaded matches. The list covers each org's 100 most recent work items.
            </div>
          )}
          {rows.map((r, i) => (
            <div
              key={`${r.kind}-${r.id}`}
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
              {r.kind === "item" ? (
                <>
                  <span className="w-10 flex-none font-mono text-[12px] text-ink-muted">
                    #{r.number}
                  </span>
                  <span className="truncate">{r.label}</span>
                  <span className="ml-auto text-ink-muted text-xs">{r.status}</span>
                </>
              ) : (
                <>
                  <ArrowRightIcon className="size-3.5 flex-none text-ink-muted" />
                  <span className="truncate">{r.label}</span>
                </>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
