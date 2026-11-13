// The babysitter's conflict resolution at the reopened merge gate (spec 53, decision 1): a person
// reviews only what the resolution changed, not the whole PR again. From `workItem.get`'s
// `babysitResolution` (stored, no GitHub call); the patches load on demand from
// `babysit.resolutionPatches`, for exactly the head shown. When it isn't a clean resolution read in
// full, or the engine reopened the gate for a resolution it couldn't record (`resolutionExpected`),
// it says so loudly: review the whole diff (and review.merge holds the person to that).

import type { WorkItemDetail } from "@software-factory/client/ops";
import { fullDiffNeeded } from "@software-factory/core/resolution-rule";
import { Button } from "@software-factory/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { openExternal } from "../lib/external.tsx";
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

/** What the reopened gate shows for a resolution: none, a clean one, or the whole diff (and why). */
export type ResolutionView =
  | { kind: "none" }
  | { kind: "clean"; resolution: Resolution }
  | { kind: "whole"; why: string; sha: string | null };

/** How the gate reads the item's resolution (#201 review): never silent when one was expected. */
export function resolutionView(detail: WorkItemDetail): ResolutionView {
  const atGate = detail.gates.some((g) => g.kind === "merge" && g.status === "pending");
  const r = detail.babysitResolution;
  if (!atGate) return { kind: "none" };
  if (!r) {
    if (!detail.resolutionExpected) return { kind: "none" };
    return detail.resolvedHead
      ? {
          kind: "whole",
          why: `The babysitter resolved a conflict in ${detail.resolvedHead.slice(0, 7)}, and the branch has moved on since: nobody has reviewed the resolution or what came after it.`,
          sha: detail.resolvedHead,
        }
      : {
          kind: "whole",
          why: "The babysitter resolved a conflict on this commit, but its resolution couldn't be shown.",
          sha: detail.item.headSha,
        };
  }
  if (r.status === "clean") return { kind: "clean", resolution: r };
  const reason = r.reason ?? "it couldn't be read";
  const why =
    r.status === "unclean"
      ? `This isn't a plain merge of the commit you approved and the default branch (${reason}).`
      : r.status === "incomplete"
        ? `The resolution couldn't be read in full (${reason}).`
        : `The resolution couldn't be read (${reason}).`;
  return { kind: "whole", why, sha: r.sha };
}

/**
 * Whether merging needs the full diff opened first: review.merge's own rule (`fullDiffNeeded`, the
 * one predicate core exports for both), at a pending merge gate, on what the engine computed for
 * the gate's head.
 */
export function resolutionNeedsFullDiff(detail: WorkItemDetail): boolean {
  const atGate = detail.gates.some((g) => g.kind === "merge" && g.status === "pending");
  return (
    atGate &&
    fullDiffNeeded({
      resolution: detail.babysitResolution ?? null,
      expected: !!detail.resolutionExpected,
      resolvedHead: detail.resolvedHead ?? null,
    }) !== null
  );
}

/** The resolution's commit and the review packet's, when they differ (any view). */
function OtherHead({ detail, sha }: { detail: WorkItemDetail; sha: string | null }) {
  const packetHead = detail.reviewPacket?.headSha ?? null;
  if (!sha || !packetHead || packetHead === sha) return null;
  return (
    <div className="flex items-start gap-2 text-xs" data-testid="resolution-other-head">
      <StatusDot status="waiting" className="mt-1" />
      <span>
        This resolution is for <span className="font-mono">{sha.slice(0, 7)}</span>, but the review
        packet is for <span className="font-mono">{packetHead.slice(0, 7)}</span>.
      </span>
    </div>
  );
}

/** A link to the PR's full diff on GitHub, which also marks the full diff opened. */
function FullDiff({ prUrl, onOpen }: { prUrl: string | null; onOpen: () => void }) {
  if (!prUrl) return null;
  const url = `${prUrl}/files`;
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-fit"
      data-testid="resolution-full-diff"
      onClick={() => {
        onOpen();
        openExternal(url);
      }}
    >
      Open the full diff on GitHub
    </Button>
  );
}

/** The loud panel: review the whole diff, and why; the checks' verdict below isn't about this. */
function WholeDiff({
  why,
  sha,
  prUrl,
  onOpenDiff,
}: {
  why: string;
  sha: string | null;
  prUrl: string | null;
  onOpenDiff: () => void;
}) {
  return (
    <Panel needsYou className="gap-1.5" data-testid="resolution-unreadable">
      <div className="flex items-start gap-2 font-semibold">
        <StatusDot status="failed" className="mt-1.5" />
        <span>Review the whole diff, not only the resolution</span>
      </div>
      <div className="text-ink-2">{why}</div>
      <div className="text-ink-muted text-xs">
        Verify's checks below are about whether this commit builds and passes; they say nothing
        about whether the conflict was resolved the right way. Merging needs the full diff opened
        first.
      </div>
      {sha && <div className="font-mono text-ink-muted text-xs">head {sha.slice(0, 7)}</div>}
      <FullDiff prUrl={prUrl} onOpen={onOpenDiff} />
    </Panel>
  );
}

/**
 * The resolution panel, above the packet at a pending merge gate. Nothing when the gate wasn't
 * reopened for a resolution (an ordinary gate: the packet's whole diff is the review).
 */
export function ResolutionPanel({
  detail,
  onOpenDiff = () => {},
}: {
  detail: WorkItemDetail;
  onOpenDiff?: () => void;
}) {
  const view = resolutionView(detail);
  if (view.kind === "none") return null;
  const prUrl = detail.item.prUrl;
  if (view.kind === "whole") {
    return (
      <section className="flex flex-col gap-2" data-testid="resolution">
        <SectionTitle note="The babysitter resolved a conflict with the default branch">
          The resolution
        </SectionTitle>
        <WholeDiff why={view.why} sha={view.sha} prUrl={prUrl} onOpenDiff={onOpenDiff} />
        <OtherHead detail={detail} sha={view.sha} />
      </section>
    );
  }
  const r = view.resolution;
  const sha = r.sha.slice(0, 7);
  const outside = new Set(r.outside);
  const listed = new Set(r.files.map((f) => f.path));
  const unlisted = r.outside.filter((p) => !listed.has(p));
  const outsideCount = r.outside.length + (r.outsideNotShown ?? 0);
  return (
    <section className="flex flex-col gap-2" data-testid="resolution">
      <SectionTitle note="Only what the resolution changed: the rest is what you approved before">
        The resolution
      </SectionTitle>
      <Panel needsYou={outsideCount > 0} className="gap-2">
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
        <OtherHead detail={detail} sha={r.sha} />
        {outsideCount > 0 && (
          <div className="flex items-start gap-2 font-medium" data-testid="resolution-outside">
            <StatusDot status="failed" className="mt-1.5" />
            <span>
              {outsideCount === 1
                ? "1 file outside the conflict differs from a plain merge: look at it closely."
                : `${outsideCount} files outside the conflict differ from a plain merge: look at these closely.`}
            </span>
          </div>
        )}
        {r.files.length === 0 ? (
          <div className="text-ink-muted" data-testid="resolution-empty">
            No file differs from what a plain merge gives.
          </div>
        ) : (
          <ResolutionFiles
            workItemId={detail.item.id}
            headSha={r.sha}
            files={r.files}
            outside={outside}
          />
        )}
        {(unlisted.length > 0 || (r.outsideNotShown ?? 0) > 0) && (
          <div className="flex flex-col gap-1 text-xs" data-testid="resolution-outside-unlisted">
            <span className="font-medium">Also outside the conflict (not listed above):</span>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono">
              {unlisted.map((p) => (
                <li key={p} className="break-all">
                  {p}
                </li>
              ))}
            </ul>
            {(r.outsideNotShown ?? 0) > 0 && (
              <span className="text-ink-muted">and {r.outsideNotShown} more.</span>
            )}
          </div>
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
        <FullDiff prUrl={prUrl} onOpen={onOpenDiff} />
      </Panel>
    </section>
  );
}

/**
 * The Inbox merge card's line for a resolution (#201 review): what it is, and whether the card may
 * merge from here. Only a clean resolution may; otherwise the item's review is where to decide.
 */
export function ResolutionSummary({ detail }: { detail: WorkItemDetail }) {
  const view = resolutionView(detail);
  if (view.kind === "none") return null;
  if (view.kind === "whole") {
    return (
      <Panel needsYou className="gap-1.5" data-testid="inbox-resolution-whole">
        <div className="flex items-start gap-2 font-semibold">
          <StatusDot status="failed" className="mt-1.5" />
          <span>The babysitter resolved a conflict: review the whole diff</span>
        </div>
        <div className="text-ink-2">{view.why}</div>
        <div className="text-ink-muted text-xs">
          The verdict below is about the checks only. Decide from the item's review.
        </div>
        <ReviewLink workItemId={detail.item.id} />
      </Panel>
    );
  }
  const r = view.resolution;
  const outside = r.outside.length + (r.outsideNotShown ?? 0);
  return (
    <Panel needsYou={outside > 0} className="gap-1" data-testid="inbox-resolution-clean">
      <div className="font-semibold">
        The babysitter resolved a conflict in {r.files.length}{" "}
        {r.files.length === 1 ? "file" : "files"}
        {r.notShown > 0 ? ` (and ${r.notShown} more)` : ""}
      </div>
      {outside > 0 && (
        <div className="flex items-start gap-2 font-medium">
          <StatusDot status="failed" className="mt-1.5" />
          <span>
            {outside === 1
              ? "1 file outside the conflict differs from a plain merge"
              : `${outside} files outside the conflict differ from a plain merge`}
            : {r.outside.slice(0, 5).join(", ")}
            {outside > 5 ? ", …" : ""}. Look at {outside === 1 ? "it" : "them"} in the full diff
            before you merge.
          </span>
        </div>
      )}
      {outside === 0 && r.notShown === 0 && resolutionNeedsFullDiff(detail) && (
        <div className="text-ink-muted text-xs">
          Some patches aren't shown in full here: look at them in the full diff before you merge.
        </div>
      )}
      {outside === 0 && r.notShown > 0 && (
        <div className="text-ink-muted text-xs">
          {r.notShown} more {r.notShown === 1 ? "file isn't" : "files aren't"} listed: look at them
          in the full diff before you merge.
        </div>
      )}
      <ReviewLink workItemId={detail.item.id} label="Review the resolution" />
    </Panel>
  );
}

function ReviewLink({
  workItemId,
  label = "Open the review",
}: {
  workItemId: string;
  label?: string;
}) {
  return (
    <Link
      to="/work/$id"
      params={{ id: workItemId }}
      search={{ tab: "review" }}
      className="w-fit font-medium underline"
      data-testid="inbox-resolution-review"
    >
      {label}
    </Link>
  );
}

function ResolutionFiles({
  workItemId,
  headSha,
  files,
  outside,
}: {
  workItemId: string;
  headSha: string;
  files: ResolutionFile[];
  outside: ReadonlySet<string>;
}) {
  // The patches are read once, the first time a file is opened, for exactly this head.
  const [wanted, setWanted] = useState(false);
  const patches = useQuery({
    queryKey: ["babysit.resolutionPatches", workItemId, headSha],
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
                {f.patchOmitted && <Chip className="ml-1">no patch</Chip>}
                {f.patchTruncated && <Chip className="ml-1">patch clipped</Chip>}
                <span className="block text-ink-muted text-xs">
                  Took {TOOK[f.took]}
                  {f.note ? `: ${f.note}` : ""}
                </span>
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Patch file={f} headSha={headSha} data={patches.data} isError={patches.isError} />
            </CollapsibleContent>
          </Collapsible>
        </li>
      ))}
    </ul>
  );
}

/** One file's patch, for exactly the head shown: a stored patch for another head isn't shown. */
export function Patch({
  file,
  headSha,
  data,
  isError,
}: {
  file: ResolutionFile;
  headSha: string;
  data: { headSha: string | null; patches: Record<string, string> } | undefined;
  isError: boolean;
}) {
  const say = (text: string) => (
    <div className="mt-1 text-ink-muted text-xs" data-testid="resolution-patch-note">
      {text}
    </div>
  );
  if (file.patchOmitted) {
    return say("GitHub gives no patch for this file (binary or too large): open it on GitHub.");
  }
  if (isError) return say("The patch couldn't be loaded.");
  if (!data) return say("Loading the patch…");
  if (data.headSha !== headSha) {
    return say(
      "The branch has moved on since this resolution: its patch isn't shown for another commit.",
    );
  }
  const text = data.patches[file.path];
  if (text === undefined) return say("No patch was stored for this file.");
  if (text === "") return say("No text changed in this file (a rename or a mode change).");
  return (
    <>
      <pre
        className="mt-1 max-h-[360px] overflow-auto rounded-md bg-selected p-3 font-mono text-xs"
        data-testid="resolution-patch"
      >
        {text}
      </pre>
      {file.patchTruncated && say("Clipped: open the file on GitHub for the rest.")}
    </>
  );
}
