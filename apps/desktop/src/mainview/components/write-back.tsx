// What approving the plan writes (spec 22, review of #130): every file the write-back creates or
// changes, its path, whether it is new or changed against the pulled base, and its text as plain
// text with the added and removed lines marked. Designs aren't drawn until the System tab (part B),
// so this list is where a person sees them before they approve; approval records exactly these.
import type { PlanningView } from "@software-factory/client/planning";
import { Badge } from "@software-factory/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { cn } from "@software-factory/ui/lib/utils";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";
import { svgDataUrl } from "../lib/design-view.ts";
import { lineDiff } from "../lib/line-diff.ts";
import { read } from "../lib/op.ts";
import { TALL_PLANNING, useMedia, WIDE_PLANNING } from "../lib/use-media.ts";

/** The write-back for the plan as it stands: keyed on the spec and each artifact's revision. */
const writeBackQuery = (workItemId: string, view: PlanningView) =>
  queryOptions({
    queryKey: [
      "workItem",
      workItemId,
      "writeBack",
      view.spec?.id ?? null,
      view.artifacts.map((a) => `${a.id}:${a.revision}:${a.keep ? 1 : 0}`).join(","),
    ],
    queryFn: () => read("spec.writeBack", { workItemId }),
    staleTime: 30_000,
  });

/** The write-back list while the spec gate is open; undefined until it has loaded. */
export function useWriteBack(workItemId: string, view: PlanningView, atGate: boolean) {
  return useQuery({ ...writeBackQuery(workItemId, view), enabled: atGate }).data;
}

/** The approve button's words: what approving writes. */
export function approveLabel(kimCount: number | undefined): string {
  if (kimCount === undefined) return "Approve the plan";
  return `Approve the plan and write ${kimCount} file${kimCount === 1 ? "" : "s"} to .kim/`;
}

export function WriteBack({ workItemId, view }: { workItemId: string; view: PlanningView }) {
  const data = useWriteBack(workItemId, view, true);
  // In a small window the list starts folded to its one line, so the panes keep their room
  // (review of #130); the approve button still says how many files it writes.
  const wide = useMedia(WIDE_PLANNING);
  const tall = useMedia(TALL_PLANNING);
  const roomy = wide && tall;
  if (!data) {
    return (
      <div
        className="flex-none border-line-soft border-t bg-panel px-[22px] py-2 text-muted-foreground text-xs"
        data-testid="write-back"
      >
        Reading what approving writes…
      </div>
    );
  }
  return (
    <Collapsible
      defaultOpen={roomy}
      className="flex max-h-[30vh] flex-none flex-col border-line-soft border-t bg-panel"
      data-testid="write-back"
    >
      <CollapsibleTrigger className="group flex items-center gap-1.5 px-[22px] pt-2.5 pb-1.5 text-left font-semibold text-sm">
        <ChevronRightIcon className="size-3.5 flex-none transition-transform group-data-[state=open]:rotate-90" />
        Approving writes {data.files.length} file{data.files.length === 1 ? "" : "s"} to this item's
        branch
      </CollapsibleTrigger>
      <CollapsibleContent className="min-h-0 overflow-y-auto px-[22px] pb-2.5">
        <ul className="flex flex-col gap-1">
          {data.files.map((f) => (
            <WriteBackFile key={f.path} file={f} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function WriteBackFile({
  file,
}: {
  file: {
    path: string;
    kind: string;
    status: "new" | "changed";
    content: string;
    base: string | null;
  };
}) {
  const preview = file.kind === "preview";
  const lines = useMemo(
    () => (preview ? [] : lineDiff(file.base, file.content)),
    [preview, file.base, file.content],
  );
  const added = lines.filter((l) => l.mark === "+").length;
  const removed = lines.filter((l) => l.mark === "-").length;
  return (
    <li data-testid="write-back-file">
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-selected">
          <ChevronRightIcon className="size-3.5 flex-none transition-transform group-data-[state=open]:rotate-90" />
          <span className="min-w-0 truncate font-mono" title={file.path}>
            {file.path}
          </span>
          <Badge variant={file.status === "new" ? "secondary" : "outline"} className="flex-none">
            {file.status === "new" ? "New" : "Changed"}
          </Badge>
          <span className="grow" />
          {!preview && <span className="flex-none font-mono text-status-done">+{added}</span>}
          {removed > 0 && (
            <span className="flex-none font-mono text-status-failed">-{removed}</span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          {preview ? (
            // The design's preview, drawn on the runner (spec 22 part B): only ever an image, so
            // nothing in it runs or loads.
            <img
              src={svgDataUrl(file.content)}
              alt={`Preview of ${file.path}`}
              className="mt-1 max-h-[320px] max-w-full rounded-md border border-line-soft bg-white object-contain"
              data-testid="write-back-preview"
            />
          ) : (
            <pre
              className="mt-1 max-h-[320px] overflow-auto rounded-md bg-selected py-2 font-mono text-xs"
              data-testid="write-back-text"
            >
              {lines.map((l, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity but their place.
                  key={i}
                  className={cn(
                    "whitespace-pre px-3",
                    l.mark === "+" && "bg-status-done/10 text-status-done",
                    l.mark === "-" && "bg-status-failed/10 text-status-failed",
                  )}
                >
                  <span aria-hidden className="select-none pr-2 opacity-70">
                    {l.mark}
                  </span>
                  <span className="sr-only">
                    {l.mark === "+" ? "added: " : l.mark === "-" ? "removed: " : ""}
                  </span>
                  {l.text}
                </div>
              ))}
            </pre>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
