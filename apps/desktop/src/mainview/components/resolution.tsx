// The babysitter's conflict resolution at the reopened merge gate (spec 53, decision 1): a person
// reviews only what the resolution changed, not the whole PR again. From `workItem.get`'s
// `babysitResolution` (stored, no GitHub call); the patches load on demand from
// `babysit.resolutionPatches`. When it isn't a clean resolution read in full (`unclean`,
// `incomplete`, `failed`) it says so loudly: review the whole diff.

import type { WorkItemDetail } from "@software-factory/client/ops";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { read } from "../lib/op.ts";
import { Chip, Panel, SectionTitle } from "./shell-list.tsx";

type Resolution = NonNullable<WorkItemDetail["babysitResolution"]>;
type ResolutionFile = Resolution["files"][number];

const TOOK: Record<ResolutionFile["took"], string> = {
  item: "the item's side",
  main: "the default branch's side",
  both: "both sides (they agree)",
  neither: "neither side: new content",
};

/** Why the gate can't show only the resolution, in words. */
export function resolutionUnreadable(r: Resolution): string {
  const why = r.reason ?? "it couldn't be read";
  switch (r.status) {
    case "unclean":
      return `This isn't a plain merge of the approved commit and the default branch (${why}). Review the whole diff.`;
    case "incomplete":
      return `The resolution couldn't be read in full (${why}). Review the whole diff.`;
    default:
      return `The resolution couldn't be read (${why}). Review the whole diff.`;
  }
}

/**
 * The resolution panel, above the packet at a pending merge gate. Nothing when the head has no
 * resolution (an ordinary gate: the packet's whole diff is the review).
 */
export function ResolutionPanel({ detail }: { detail: WorkItemDetail }) {
  const r = detail.babysitResolution;
  const atGate = detail.gates.some((g) => g.kind === "merge" && g.status === "pending");
  if (!r || !atGate) return null;
  const sha = r.sha.slice(0, 7);
  if (r.status !== "clean") {
    return (
      <section className="flex flex-col gap-2" data-testid="resolution">
        <SectionTitle note="The babysitter resolved a conflict with the default branch">
          The resolution
        </SectionTitle>
        <Panel needsYou className="gap-1.5" data-testid="resolution-unreadable">
          <div className="flex items-start gap-2 font-semibold">
            <StatusDot status="failed" className="mt-1.5" />
            <span>Review the whole diff, not only the resolution</span>
          </div>
          <div className="text-ink-2">{resolutionUnreadable(r)}</div>
          <div className="font-mono text-ink-muted text-xs">head {sha}</div>
        </Panel>
      </section>
    );
  }
  const outside = new Set(r.outside);
  return (
    <section className="flex flex-col gap-2" data-testid="resolution">
      <SectionTitle note="Only what the resolution changed: the rest is what you approved before">
        The resolution
      </SectionTitle>
      <Panel needsYou={outside.size > 0} className="gap-2">
        <div className="text-ink-2">
          The babysitter merged the default branch into the commit you approved and resolved a
          conflict. Commit <span className="font-mono">{sha}</span>
          {r.itemHead ? (
            <>
              {" "}
              merges <span className="font-mono">{r.itemHead.slice(0, 7)}</span>
            </>
          ) : null}
          {r.main ? (
            <>
              {" "}
              with <span className="font-mono">{r.main.slice(0, 7)}</span>
            </>
          ) : null}
          . Each patch is against the commit you approved, so it includes the default branch's
          changes.
        </div>
        {outside.size > 0 && (
          <div className="flex items-start gap-2 font-medium" data-testid="resolution-outside">
            <StatusDot status="failed" className="mt-1.5" />
            <span>
              {outside.size === 1
                ? "1 file outside the conflict differs from a plain merge: look at it closely."
                : `${outside.size} files outside the conflict differ from a plain merge: look at these closely.`}
            </span>
          </div>
        )}
        {r.files.length === 0 ? (
          <div className="text-ink-muted" data-testid="resolution-empty">
            No file differs from what a plain merge gives.
          </div>
        ) : (
          <ResolutionFiles workItemId={detail.item.id} files={r.files} outside={outside} />
        )}
        {r.notShown > 0 && (
          <div className="flex items-start gap-2 text-xs" data-testid="resolution-not-shown">
            <StatusDot status="waiting" className="mt-1" />
            <span>
              {r.notShown} more {r.notShown === 1 ? "file isn't" : "files aren't"} listed. Open the
              diff on GitHub to see them.
            </span>
          </div>
        )}
      </Panel>
    </section>
  );
}

function ResolutionFiles({
  workItemId,
  files,
  outside,
}: {
  workItemId: string;
  files: ResolutionFile[];
  outside: ReadonlySet<string>;
}) {
  // The patches are read once, the first time a file is opened.
  const [wanted, setWanted] = useState(false);
  const patches = useQuery({
    queryKey: ["babysit.resolutionPatches", workItemId],
    queryFn: () => read("babysit.resolutionPatches", { workItemId }),
    enabled: wanted,
  });
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="resolution-files">
      {files.map((f) => (
        <li key={f.path} data-testid="resolution-file">
          <Collapsible onOpenChange={(o) => (o ? setWanted(true) : undefined)}>
            <CollapsibleTrigger className="group flex w-full items-start gap-1.5 text-left">
              <ChevronRightIcon className="mt-0.5 size-3.5 flex-none transition-transform group-data-[state=open]:rotate-90" />
              <span className="min-w-0 flex-1">
                <span className="break-all font-mono text-xs">
                  {f.previousPath ? `${f.previousPath} → ` : ""}
                  {f.path}
                </span>{" "}
                {f.conflicted ? (
                  <Chip tone="blue">conflict</Chip>
                ) : (
                  <Chip tone="amber">
                    {outside.has(f.path) ? "outside the conflict" : "changed"}
                  </Chip>
                )}
                <span className="block text-ink-muted text-xs">
                  Took {TOOK[f.took]}
                  {f.note ? `: ${f.note}` : ""}
                </span>
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Patch file={f} patches={patches} />
            </CollapsibleContent>
          </Collapsible>
        </li>
      ))}
    </ul>
  );
}

function Patch({
  file,
  patches,
}: {
  file: ResolutionFile;
  patches: { data?: { patches: Record<string, string> } | undefined; isError: boolean };
}) {
  if (file.patchOmitted) {
    return (
      <div className="mt-1 text-ink-muted text-xs">
        GitHub gives no patch for this file (binary or too large): open it on GitHub.
      </div>
    );
  }
  if (patches.isError) {
    return <div className="mt-1 text-ink-muted text-xs">The patch couldn't be loaded.</div>;
  }
  if (!patches.data) return <div className="mt-1 text-ink-muted text-xs">Loading the patch…</div>;
  const text = patches.data.patches[file.path];
  if (!text) {
    return (
      <div className="mt-1 text-ink-muted text-xs">
        The patch isn't stored any more: the branch has moved on.
      </div>
    );
  }
  return (
    <>
      <pre
        className="mt-1 max-h-[360px] overflow-auto rounded-md bg-selected p-3 font-mono text-xs"
        data-testid="resolution-patch"
      >
        {text}
      </pre>
      {file.patchTruncated && (
        <div className="text-ink-muted text-xs">Clipped: open the file on GitHub for the rest.</div>
      )}
    </>
  );
}
