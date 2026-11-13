// The System tab (spec 22 part B, design PlanFocus's "System" tab): the planner's system designs
// (data model, architecture, data flow, sequence, state, API), each drawn from the preview the
// runner's checks made. The SVG is shown only as an image (`lib/design-view.ts`): the app draws its
// own boxes over it, from the parts the runner measured, to mark what changed against the file
// pulled from the default branch and to pin comments on a table, a box or an arrow.
import { ago } from "@software-factory/client/format";
import type { DesignPreview, PlanningView } from "@software-factory/client/planning";
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, MapPinIcon, Maximize2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { comparison, designOverlays, pinOn, pinOnPart, svgDataUrl } from "../lib/design-view.ts";
import { lineDiff } from "../lib/line-diff.ts";
import { read } from "../lib/op.ts";
import { type Pin, pinsFor } from "./planning-visuals.tsx";

type Artifact = PlanningView["artifacts"][number];

/** How each design type reads in the list. */
const TYPE_LABEL: Record<string, string> = {
  "data-model": "Data model · DBML",
  architecture: "Architecture · D2",
  "data-flow": "Data flow · D2",
  sequence: "Sequence · Mermaid",
  state: "State · Mermaid",
  api: "API · OpenAPI",
};

/**
 * A revision of a design from the door, with its preview. Keyed on the revision and the artifact's
 * `updatedAt` (review of #168): a drawing can arrive after its revision (`design.preview`) and a
 * re-pull rewrites revision 0, and both move `updatedAt`.
 */
function useDesign(
  workItemId: string,
  design: Pick<Artifact, "id" | "updatedAt">,
  revision: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ["workItem", workItemId, "artifact", design.id, revision, design.updatedAt],
    queryFn: () => read("artifact.get", { workItemId, artifactId: design.id, revision }),
    staleTime: Number.POSITIVE_INFINITY,
    enabled,
  });
}

export function SystemPane({
  view,
  workItemId,
  pinMode,
  onPin,
}: {
  view: PlanningView;
  workItemId: string;
  pinMode: boolean;
  onPin: (pin: Pin) => void;
}) {
  const designs = view.artifacts.filter((a) => a.kind === "design");
  const [chosen, setChosen] = useState<string | null>(null);
  const [mode, setMode] = useState<"drawing" | "source">("drawing");
  const shown = view.session?.shownArtifactId;
  const current =
    designs.find((d) => d.id === chosen) ??
    designs.find((d) => d.id === shown) ??
    designs[0] ??
    null;
  if (!current) {
    return (
      <div className="px-8 py-6 text-ink-muted text-sm" data-testid="system-empty">
        No system designs yet. The planner adds a data model, an architecture, a flow or an API when
        the plan needs one, or pulls one from the repository's .kim/designs.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="system-pane">
      <div className="flex min-w-0 items-center gap-2 border-line-soft border-b px-5 py-2">
        {designs.length > 1 ? (
          <ToggleGroup
            type="single"
            value={current.id}
            onValueChange={(v) => v && setChosen(v)}
            size="sm"
            variant="outline"
            className="min-w-0 overflow-x-auto"
            aria-label="Designs"
          >
            {designs.map((d) => (
              <ToggleGroupItem
                key={d.id}
                value={d.id}
                className="max-w-[220px] flex-none px-3"
                title={d.title}
                data-testid="system-design"
              >
                <span className="truncate">{d.title}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : (
          <span className="min-w-0 truncate font-semibold">{current.title}</span>
        )}
        <span className="grow" />
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(v) => v && setMode(v as "drawing" | "source")}
          size="sm"
          variant="outline"
          className="flex-none"
        >
          <ToggleGroupItem value="drawing" className="px-3">
            Drawing
          </ToggleGroupItem>
          <ToggleGroupItem value="source" className="px-3" data-testid="system-source">
            Source
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <Design
        key={`${current.id}:${current.revision}`}
        view={view}
        workItemId={workItemId}
        design={current}
        mode={mode}
        pinMode={pinMode}
        onPin={onPin}
      />
    </div>
  );
}

function Design({
  view,
  workItemId,
  design,
  mode,
  pinMode,
  onPin,
}: {
  view: PlanningView;
  workItemId: string;
  design: Artifact;
  mode: "drawing" | "source";
  pinMode: boolean;
  onPin: (pin: Pin) => void;
}) {
  const latest = useDesign(workItemId, design, design.revision);
  const pulled = design.pulledPath !== null;
  const base = useDesign(workItemId, design, 0, pulled);
  const [compare, setCompare] = useState(true);
  const [full, setFull] = useState(false);
  const preview = latest.data?.preview ?? null;
  // A failed or missing read is never shown as "no changes" (review of #168).
  const against = comparison(pulled, compare, base);
  const basePreview = against.kind === "ready" ? against.base : null;
  const drawn = useMemo(
    () => (preview ? designOverlays(preview, basePreview) : null),
    [preview, basePreview],
  );
  const changed = drawn ? drawn.counts.added + drawn.counts.changed + drawn.counts.removed : 0;
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="system-design-view">
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-line-soft border-b px-5 py-2 text-xs"
        data-testid="system-compare"
      >
        <Badge variant="outline" className="flex-none">
          {TYPE_LABEL[design.designType ?? ""] ?? design.designType}
        </Badge>
        <span className="font-mono text-ink-muted">rev {design.revision}</span>
        {design.keep && <span className="text-status-running">saves to the repo</span>}
        {pulled && (
          <span className="min-w-0 truncate text-ink-muted">
            from <span className="font-mono">{design.pulledPath}</span>
          </span>
        )}
        {against.kind === "ready" && drawn && (
          <>
            <ChangeCount kind="added" n={drawn.counts.added} />
            <ChangeCount kind="changed" n={drawn.counts.changed} />
            <ChangeCount kind="removed" n={drawn.counts.removed} />
            {changed === 0 && <span className="text-ink-muted">No changes yet</span>}
          </>
        )}
        {against.kind === "loading" && (
          <span className="text-ink-muted" data-testid="system-compare-loading">
            Reading the default branch's copy…
          </span>
        )}
        {against.kind === "error" && (
          <span className="text-status-failed" data-testid="system-compare-error">
            Couldn't read the default branch's copy: {against.message}
          </span>
        )}
        {against.kind === "no-drawing" && (
          <span className="text-ink-muted" data-testid="system-compare-none">
            The default branch's copy has no drawing to compare with
          </span>
        )}
        <span className="grow" />
        {preview && mode === "drawing" && (
          <Button size="sm" variant="ghost" onClick={() => setFull(true)} data-testid="system-full">
            <Maximize2Icon className="size-3.5" /> Open full size
          </Button>
        )}
        {pulled && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCompare((c) => !c)}
            data-testid="system-compare-toggle"
          >
            {compare ? "Hide changes" : "Show changes"}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {latest.isError ? (
          <p className="text-status-failed text-sm" data-testid="system-error">
            Couldn't read this design:{" "}
            {latest.error instanceof Error ? latest.error.message : "the read failed"}
          </p>
        ) : latest.isPending ? (
          <p className="text-ink-muted text-sm">Loading the design…</p>
        ) : mode === "source" || !preview ? (
          <>
            {!preview && latest.data && (
              <p className="mb-3 text-ink-muted text-sm" data-testid="system-no-preview">
                No drawing for this revision: the runner that saved it didn't draw designs. Its
                source is below.
              </p>
            )}
            <Source
              content={latest.data?.content ?? ""}
              base={
                against.kind === "ready" || against.kind === "no-drawing"
                  ? (base.data?.content ?? null)
                  : null
              }
            />
          </>
        ) : (
          <Drawing
            view={view}
            design={design}
            preview={preview}
            overlays={drawn?.overlays ?? []}
            pinMode={pinMode}
            onPin={onPin}
          />
        )}
        {mode === "drawing" && drawn && drawn.removed.length > 0 && (
          <div className="mt-4 grid gap-1 text-xs" data-testid="system-removed">
            <span className="font-medium">Removed since the default branch's copy</span>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {drawn.removed.map((p) => (
                <li
                  key={p.id}
                  className="rounded-md bg-status-failed/10 px-2 py-0.5 font-mono text-status-failed line-through"
                >
                  {p.id}
                </li>
              ))}
            </ul>
          </div>
        )}
        {preview && preview.warnings.length > 0 && (
          <div className="mt-4 grid gap-1.5" data-testid="system-warnings">
            {preview.warnings.map((w, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: warnings have no identity but their place.
                key={i}
                className="flex gap-2 rounded-md bg-status-waiting/10 px-3 py-2 text-xs"
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 flex-none text-status-waiting" />
                <span>
                  <span className="font-medium">
                    {w.code.startsWith("layout/") ? "Layout: " : "Drawing: "}
                  </span>
                  {w.message}
                  {w.fixes[0] && <span className="text-ink-muted"> {w.fixes[0]}.</span>}
                </span>
              </div>
            ))}
          </div>
        )}
        <PinList view={view} design={design} parts={preview?.parts ?? null} />
      </div>
      {preview && (
        <Dialog open={full} onOpenChange={setFull}>
          <DialogContent className="max-h-[90vh] max-w-[92vw] overflow-auto sm:max-w-[92vw]">
            <DialogHeader>
              <DialogTitle>{design.title}</DialogTitle>
            </DialogHeader>
            <div className="overflow-auto">
              <Drawing
                view={view}
                design={design}
                preview={preview}
                overlays={drawn?.overlays ?? []}
                pinMode={false}
                onPin={onPin}
                natural
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

const CHANGE_STYLE = {
  added: "border-status-done bg-status-done/10 text-status-done",
  changed: "border-status-waiting bg-status-waiting/10 text-status-waiting",
  removed: "border-status-failed bg-status-failed/10 text-status-failed",
} as const;

function ChangeCount({ kind, n }: { kind: keyof typeof CHANGE_STYLE; n: number }) {
  if (n === 0) return null;
  return (
    <span
      className={cn("rounded-md border px-1.5 py-px font-medium", CHANGE_STYLE[kind])}
      data-testid={`system-${kind}`}
    >
      {n} {kind}
    </span>
  );
}

/**
 * The preview as an image at its own size (shrunk to fit), with the app's own boxes over it: one per
 * part, outlined when it changed, clickable in comment mode, and the pins placed on their parts.
 */
function Drawing({
  view,
  design,
  preview,
  overlays,
  pinMode,
  onPin,
  natural = false,
}: {
  view: PlanningView;
  design: Artifact;
  preview: DesignPreview;
  overlays: ReturnType<typeof designOverlays>["overlays"];
  pinMode: boolean;
  onPin: (pin: Pin) => void;
  /** At its own size (full size), rather than shrunk to fit. */
  natural?: boolean;
}) {
  const src = useMemo(() => svgDataUrl(preview.svg), [preview.svg]);
  const pins = pinsFor(view, design.id);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <div
      className={cn("relative rounded-md border border-line bg-white", !natural && "max-w-full")}
      style={{ width: preview.width, aspectRatio: `${preview.width} / ${preview.height}` }}
      data-testid="system-drawing"
    >
      <img
        src={src}
        alt={`${design.title}: ${preview.parts.length} parts`}
        className="block h-full w-full select-none"
        draggable={false}
      />
      {overlays.map(({ part, box, change }) => (
        <Button
          key={part.id}
          type="button"
          variant="ghost"
          tabIndex={pinMode ? 0 : -1}
          title={part.id}
          aria-label={pinMode ? `Comment on ${part.id}` : part.id}
          disabled={!pinMode}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const sx = box.w / Math.max(1, r.width);
            const sy = box.h / Math.max(1, r.height);
            onPin(
              pinOnPart(
                design.id,
                preview,
                part,
                { x: box.x + (e.clientX - r.left) * sx, y: box.y + (e.clientY - r.top) * sy },
                design.revision,
              ),
            );
          }}
          className={cn(
            "absolute h-auto min-h-0 rounded-[6px] border-2 border-transparent bg-transparent p-0 shadow-none hover:bg-transparent disabled:cursor-default disabled:opacity-100",
            change && CHANGE_STYLE[change],
            pinMode && "cursor-crosshair hover:border-status-running hover:bg-status-running/10",
          )}
          style={{
            left: pct(box.x, preview.width),
            top: pct(box.y, preview.height),
            width: pct(box.w, preview.width),
            height: pct(box.h, preview.height),
          }}
          data-testid="system-part"
          data-part={part.id}
          data-change={change ?? undefined}
        />
      ))}
      {pins.map((p) => {
        const pin = p.message.pin;
        if (!pin) return null;
        const at = pinOn(pin, preview.parts, design.revision);
        if (!at) return null;
        return (
          <span
            key={p.message.id}
            className="-translate-x-1/2 -translate-y-full pointer-events-none absolute flex size-5 items-center justify-center rounded-full rounded-bl-none bg-status-done font-semibold text-[10px] text-white shadow"
            style={{ left: pct(at.x, preview.width), top: pct(at.y, preview.height) }}
            data-testid="system-pin"
          >
            {p.n}
          </span>
        );
      })}
    </div>
  );
}

/** The comments pinned on this design, numbered as on the drawing. */
function PinList({
  view,
  design,
  parts,
}: {
  view: PlanningView;
  design: Artifact;
  parts: DesignPreview["parts"] | null;
}) {
  const pins = pinsFor(view, design.id);
  if (!pins.length) {
    return (
      <p className="mt-4 flex items-center gap-2 text-ink-muted text-xs">
        <MapPinIcon className="size-3.5" />
        Comment (C), then click a table, a box or an arrow, to tell the planner about it.
      </p>
    );
  }
  return (
    <div className="mt-4 grid gap-1.5" data-testid="system-pins">
      {pins.map((p) => (
        <div
          key={p.message.id}
          className="flex gap-2 rounded-lg bg-status-done/10 px-2.5 py-1.5 text-xs"
        >
          <span className="flex size-4 flex-none items-center justify-center rounded-full bg-status-done font-semibold text-[10px] text-white">
            {p.n}
          </span>
          <span>
            <b className="font-medium">{p.message.authorName}</b> on{" "}
            <span className="font-mono">{p.message.pin?.element}</span>
            {parts && p.message.pin && !pinOn(p.message.pin, parts, design.revision) && (
              <span className="text-status-failed" data-testid="system-pin-gone">
                {" "}
                (part removed
                {p.message.pin.revision !== undefined ? ` since rev ${p.message.pin.revision}` : ""}
                )
              </span>
            )}
            : {p.message.text}
            <span className="text-ink-muted"> · {ago(p.message.createdAt)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** The design's source, with the lines added and removed against the pulled base marked. */
function Source({ content, base }: { content: string; base: string | null }) {
  const lines = useMemo(() => lineDiff(base, content), [base, content]);
  return (
    <pre
      className="m-0 overflow-auto rounded-md bg-selected py-2 font-mono text-xs"
      data-testid="system-source-text"
    >
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity but their place.
          key={i}
          className={cn(
            "whitespace-pre px-3",
            base !== null && l.mark === "+" && "bg-status-done/10 text-status-done",
            l.mark === "-" && "bg-status-failed/10 text-status-failed",
          )}
        >
          <span aria-hidden className="select-none pr-2 opacity-70">
            {base !== null ? l.mark : " "}
          </span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}
