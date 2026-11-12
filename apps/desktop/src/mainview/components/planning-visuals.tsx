// Planning visuals in the Planning tab (spec 21, ADR 0472, designs PlanFocusMockup and the mobile
// PlanMockups): the planner's mockups rendered in sandboxed frames, options as cards, live
// controls, the canvas, and comments pinned to an element.
//
// A mockup is untrusted HTML. It renders from `srcdoc` in an `<iframe sandbox="allow-scripts">`
// (no `allow-same-origin`: its origin is opaque, so it can't reach the app's storage, DOM or door),
// behind a Content-Security-Policy the app puts before anything of the planner's. A small script the app also
// puts in talks to the app over `postMessage`: it applies control values, previews them, reports
// the element under a click in comment mode, and draws pins. Messages are accepted only from the
// frame's own window, and every field is treated as data.
import { ago, errorMessage } from "@software-factory/client/format";
import {
  appliedValues,
  frameSize,
  type PlanningQuestion,
  type PlanningView,
} from "@software-factory/client/planning";
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
import { MapPinIcon, Maximize2Icon, MinusIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { frameDocument } from "../lib/mockup-frame.ts";
import { op, read, submitKey } from "../lib/op.ts";

type Artifact = PlanningView["artifacts"][number];
export type Pin = NonNullable<PlanningView["messages"][number]["pin"]>;
type Values = Record<string, string>;

/** An artifact's content, from the door (read-only; cached by revision). */
function useArtifact(workItemId: string, artifact: Pick<Artifact, "id" | "revision">) {
  return useQuery({
    queryKey: ["workItem", workItemId, "artifact", artifact.id, artifact.revision],
    queryFn: () => read("artifact.get", { workItemId, artifactId: artifact.id }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * One mockup in a sandboxed frame, at its own frame width, scaled to fit `fit` pixels wide.
 * `values` are applied; `preview` is shown over them while set; in comment mode a click pins.
 */
export function MockupFrame({
  workItemId,
  artifact,
  fit,
  width,
  values,
  preview,
  pinMode = false,
  pins = [],
  onPin,
  interactive = true,
  className,
}: {
  workItemId: string;
  artifact: Artifact;
  /** The width it is drawn into, in the app's pixels. */
  fit: number;
  /** The document width; default the artifact's frame size (desktop, tablet or phone). */
  width?: number;
  values?: Values | null;
  preview?: Values | null;
  pinMode?: boolean;
  pins?: { n: number; x: number; y: number }[];
  onPin?: (pin: Omit<Pin, "artifactId">) => void;
  interactive?: boolean;
  className?: string;
}) {
  const content = useArtifact(workItemId, artifact);
  const frame = useRef<HTMLIFrameElement>(null);
  const size = frameSize(artifact.title, artifact.description);
  const docWidth = width ?? size.width;
  const scale = fit / docWidth;
  const [height, setHeight] = useState(size.height);
  const [loaded, setLoaded] = useState(0);
  const srcDoc = useMemo(
    () => (content.data ? frameDocument(content.data.content) : undefined),
    [content.data],
  );
  const post = (message: Record<string, unknown>) =>
    frame.current?.contentWindow?.postMessage(message, "*");
  // Only this frame's own window is listened to (ADR 0472).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data || typeof e.data !== "object")
        return;
      const m = e.data as Record<string, unknown>;
      if (m.type === "ready") {
        setLoaded((n) => n + 1);
        if (typeof m.height === "number" && m.height > 0) setHeight(Math.min(m.height, 20_000));
      } else if (m.type === "pin" && onPin) {
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        onPin({
          element: String(m.element ?? "element").slice(0, 300),
          selector: typeof m.selector === "string" ? m.selector.slice(0, 1_000) : null,
          x: num(m.x),
          y: num(m.y),
          fx: Math.min(1, Math.max(0, num(m.fx))),
          fy: Math.min(1, Math.max(0, num(m.fy))),
          width: Math.max(1, num(m.width)),
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onPin]);
  const valuesKey = JSON.stringify(values ?? {});
  const previewKey = JSON.stringify(preview ?? null);
  const pinsKey = JSON.stringify(pins);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by value; resent when the frame (re)loads.
  useEffect(() => {
    post({ type: "apply", values: values ?? {} });
  }, [valuesKey, loaded]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: as above.
  useEffect(() => {
    post({ type: "preview", values: preview ?? null });
  }, [previewKey, loaded]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: as above.
  useEffect(() => {
    post({ type: "pin-mode", on: pinMode });
  }, [pinMode, loaded]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: as above.
  useEffect(() => {
    post({ type: "pins", pins });
  }, [pinsKey, loaded]);
  const shown = Math.min(height, interactive ? 20_000 : size.height);
  return (
    <div
      className={cn("relative overflow-hidden rounded-md bg-white", className)}
      style={{ width: fit, height: shown * scale }}
      data-testid="mockup-frame"
      data-artifact={artifact.id}
    >
      {content.error ? (
        <div className="p-3 text-destructive text-xs">{errorMessage(content.error)}</div>
      ) : (
        <iframe
          ref={frame}
          title={artifact.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          className={cn(
            "absolute top-0 left-0 origin-top-left border-0",
            !interactive && "pointer-events-none",
          )}
          style={{ width: docWidth, height: shown, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}

/** Values a question's saved answer applies to its mockup, as the planner will hear them. */
export function savedValues(q: PlanningQuestion): Values | null {
  return q.status === "answered" && !q.skipped
    ? appliedValues(
        {
          kind: q.kind,
          artifactId: q.artifactId,
          optionValues: q.optionValues,
          control: q.control,
          unit: q.unit,
        },
        q.answer,
      )
    : null;
}

/** All saved values for one artifact, from every question bound to it. */
export function valuesFor(view: PlanningView, artifactId: string): Values {
  const out: Values = {};
  for (const q of view.questions)
    if (q.artifactId === artifactId) Object.assign(out, savedValues(q) ?? {});
  return out;
}

/** Pins on an artifact, numbered in the order they were sent. */
export function pinsFor(view: PlanningView, artifactId: string) {
  return view.messages
    .filter((m) => m.pin?.artifactId === artifactId)
    .map((m, i) => ({ n: i + 1, message: m, x: m.pin?.x ?? 0, y: m.pin?.y ?? 0 }));
}

/** The question an artifact belongs to on the canvas: the first that names it. */
function ownerOf(view: PlanningView, artifactId: string): PlanningQuestion | undefined {
  return [...view.questions]
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
    .find(
      (q) =>
        q.artifactId === artifactId || Object.values(q.optionArtifacts ?? {}).includes(artifactId),
    );
}

/** The question the Mockups tab is about: the focused one with visuals, else the first open one. */
export function visualQuestion(view: PlanningView): PlanningQuestion | undefined {
  const withVisuals = view.questions.filter((q) => q.optionArtifacts || q.artifactId);
  const focused = withVisuals.find((q) => q.id === view.session?.focusedQuestionId);
  return focused ?? withVisuals.find((q) => q.status === "open") ?? withVisuals.at(-1);
}

/** Answers a planning question with an option (from a card), as the question card would. */
async function choose(q: PlanningQuestion, option: string) {
  try {
    await op(
      "planning.answer",
      { questionId: q.id, answer: option, questionRevision: q.revision },
      { idempotencyKey: submitKey() },
    );
  } catch (error) {
    toast.error(errorMessage(error));
  }
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The Mockups tab: the options of the question in view as cards (design PlanFocusMockup), or the
 * one mockup a bound question changes, live, or every mockup when no question names one.
 */
export function MockupsPane({
  view,
  workItemId,
  preview,
  pinMode,
  onPin,
  onAsk,
  onOpen,
}: {
  view: PlanningView;
  workItemId: string;
  /** Values a hovered option or a dragged slider shows, by artifact. */
  preview: { artifactId: string; values: Values } | null;
  pinMode: boolean;
  onPin: (pin: Pin) => void;
  /** Start a chat message (Ask for another option). */
  onAsk: (text: string, questionId?: string) => void;
  onOpen: (artifact: Artifact) => void;
}) {
  const q = visualQuestion(view);
  const byId = new Map(view.artifacts.map((a) => [a.id, a]));
  const pinned = (a: Artifact) =>
    onPin === undefined
      ? undefined
      : (p: Omit<Pin, "artifactId">) => onPin({ ...p, artifactId: a.id });
  if (view.artifacts.length === 0) {
    return (
      <div className="px-8 py-6 text-ink-muted text-sm" data-testid="mockups-empty">
        No mockups yet. The planner draws them when a choice is easier to see than to describe.
      </div>
    );
  }
  const cards = q?.optionArtifacts ? Object.entries(q.optionArtifacts) : [];
  if (q && cards.length) {
    return (
      <div className="grid gap-3 px-6 py-5" data-testid="option-cards">
        <div className="flex items-baseline gap-2 font-semibold text-[15px]">
          <span className="font-mono text-status-running text-xs">Q{q.number}</span>
          {q.prompt}
        </div>
        <div className="flex gap-3 overflow-x-auto pb-1">
          {cards.map(([option, id], i) => {
            const a = byId.get(id);
            if (!a) return null;
            const recommended = q.defaultValues?.includes(option);
            const chosen = q.status === "answered" && q.answer === option;
            const pins = pinsFor(view, a.id);
            return (
              <div
                key={option}
                className={cn(
                  "grid w-[340px] flex-none content-start gap-2.5 rounded-xl border bg-panel p-3",
                  recommended || chosen
                    ? "border-status-running ring-1 ring-status-running"
                    : "border-line",
                )}
                data-testid="option-card"
                data-option={option}
              >
                <div className="flex items-center gap-2">
                  <span className="flex size-5 items-center justify-center rounded-md bg-ink font-semibold text-[11px] text-window">
                    {LETTERS[i]}
                  </span>
                  <span className="font-semibold">{option}</span>
                  {recommended && (
                    <span className="rounded-full bg-status-waiting/18 px-2 py-0.5 font-medium text-[11px] text-status-waiting">
                      Recommended
                    </span>
                  )}
                  <span className="grow" />
                  <span className="font-mono text-[11px] text-ink-muted">rev {a.revision}</span>
                </div>
                <MockupFrame
                  workItemId={workItemId}
                  artifact={a}
                  fit={314}
                  values={valuesFor(view, a.id)}
                  pinMode={pinMode}
                  pins={pins}
                  {...(pinned(a) ? { onPin: pinned(a) } : {})}
                  className="border border-line"
                />
                {a.description && <p className="m-0 text-[12.5px] text-ink-3">{a.description}</p>}
                {pins.map((p) => (
                  <div
                    key={p.message.id}
                    className="flex gap-2 rounded-lg bg-status-done/10 px-2.5 py-1.5 text-xs"
                    data-testid="card-pin"
                  >
                    <span className="flex size-4 flex-none items-center justify-center rounded-full bg-status-done font-semibold text-[10px] text-white">
                      {p.n}
                    </span>
                    <span>
                      <b className="font-medium">{p.message.authorName}</b> on{" "}
                      {p.message.pin?.element}: {p.message.text}
                    </span>
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={chosen ? "outline" : "default"}
                    disabled={chosen}
                    onClick={() => choose(q, option)}
                    data-testid="choose-option"
                  >
                    {chosen ? "Chosen" : `Choose ${LETTERS[i]}`}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onOpen(a)}>
                    <Maximize2Icon className="size-3.5" /> Open full size
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 text-ink-muted text-xs">
          <MapPinIcon className="size-3.5" />
          Comment (C) pins a note to any element of a mockup.
          <span className="grow" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onAsk(`Could you draw another option for Q${q.number}?`, q.id)}
            data-testid="ask-another-option"
          >
            Ask for another option
          </Button>
        </div>
      </div>
    );
  }
  // A bound question (or the one the planner showed last): one mockup, live.
  const one =
    (q?.artifactId && byId.get(q.artifactId)) ||
    (view.session?.shownArtifactId && byId.get(view.session.shownArtifactId)) ||
    view.artifacts.at(-1);
  if (!one) return null;
  return (
    <div className="grid gap-3 px-6 py-5" data-testid="mockup-single">
      <div className="flex items-center gap-2">
        <span className="font-semibold">{one.title}</span>
        <span className="font-mono text-[11px] text-ink-muted">rev {one.revision}</span>
        {one.keep && <span className="text-[11px] text-status-running">saves to the repo</span>}
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={() => onOpen(one)}>
          <Maximize2Icon className="size-3.5" /> Open full size
        </Button>
      </div>
      <MockupFrame
        workItemId={workItemId}
        artifact={one}
        fit={720}
        values={valuesFor(view, one.id)}
        preview={preview?.artifactId === one.id ? preview.values : null}
        pinMode={pinMode}
        pins={pinsFor(view, one.id)}
        {...(pinned(one) ? { onPin: pinned(one) } : {})}
        className="border border-line"
      />
      {one.description && <p className="m-0 text-ink-3 text-xs">{one.description}</p>}
    </div>
  );
}

/** The canvas (spec 21): every visual as a frame, in a row per question, to pan, zoom and drag. */
export function CanvasPane({
  view,
  workItemId,
  onOpen,
}: {
  view: PlanningView;
  workItemId: string;
  onOpen: (artifact: Artifact) => void;
}) {
  const [zoom, setZoom] = useState(0.25);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>(() => {
    try {
      return JSON.parse(localStorage.getItem(`sf-canvas-${workItemId}`) ?? "{}");
    } catch {
      return {};
    }
  });
  const drag = useRef<{ id: string; x: number; y: number; ox: number; oy: number } | null>(null);
  // Rows: designs tied to no question first, then one row per question that names any.
  const rows = new Map<string, { label: string; items: Artifact[] }>();
  for (const a of view.artifacts) {
    const owner = ownerOf(view, a.id);
    const key = owner?.id ?? "";
    const row = rows.get(key) ?? {
      label: owner ? `Q${owner.number} · ${owner.prompt}` : "Not tied to a question",
      items: [],
    };
    row.items.push(a);
    rows.set(key, row);
  }
  const ordered = [...rows.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : 0));
  const GAP = 80;
  const layout: { a: Artifact; x: number; y: number; w: number; h: number; label?: string }[] = [];
  let y = 0;
  for (const [, row] of ordered) {
    let x = 0;
    let tallest = 0;
    row.items.forEach((a, i) => {
      const size = frameSize(a.title, a.description);
      const at = moved[a.id] ?? { x, y: y + 60 };
      layout.push({
        a,
        x: at.x,
        y: at.y,
        w: size.width,
        h: size.height,
        ...(i === 0 ? { label: row.label } : {}),
      });
      x += size.width + GAP;
      tallest = Math.max(tallest, size.height);
    });
    y += tallest + 60 + GAP * 2;
  }
  const save = (next: typeof moved) => {
    setMoved(next);
    try {
      localStorage.setItem(`sf-canvas-${workItemId}`, JSON.stringify(next));
    } catch {
      // A per-viewer convenience: fine without it.
    }
  };
  if (view.artifacts.length === 0) {
    return <div className="px-8 py-6 text-ink-muted text-sm">Nothing on the canvas yet.</div>;
  }
  return (
    <div
      className="relative h-full min-h-[480px] overflow-auto bg-[radial-gradient(var(--line)_1px,transparent_1px)] [background-size:16px_16px]"
      data-testid="canvas"
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setZoom((z) => Math.min(1, Math.max(0.1, z * (e.deltaY > 0 ? 0.9 : 1.1))));
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        save({
          ...moved,
          [d.id]: { x: d.ox + (e.clientX - d.x) / zoom, y: d.oy + (e.clientY - d.y) / zoom },
        });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      <div className="sticky top-2 left-2 z-10 flex w-fit gap-1 rounded-lg bg-panel p-1 shadow">
        <Button
          size="sm"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.1, z * 0.8))}
        >
          <MinusIcon className="size-3.5" />
        </Button>
        <span className="flex w-12 items-center justify-center font-mono text-xs">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(1, z * 1.25))}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      <div
        className="relative origin-top-left px-8 pt-28 pb-8"
        style={{ transform: `scale(${zoom})` }}
      >
        {layout.map(({ a, x, y: top, w, label }) => (
          <div key={a.id} className="absolute" style={{ left: x, top }} data-testid="canvas-frame">
            {label && (
              <div className="-mt-12 mb-3 font-semibold text-[28px] text-ink-3">{label}</div>
            )}
            <div
              className="mb-2 flex cursor-grab items-center gap-3 text-[24px]"
              onPointerDown={(e) => {
                const at = moved[a.id] ?? { x, y: top };
                drag.current = { id: a.id, x: e.clientX, y: e.clientY, ox: at.x, oy: at.y };
              }}
            >
              <b className="font-semibold">{a.title}</b>
              <span className="font-mono text-ink-muted">rev {a.revision}</span>
              <button
                type="button"
                className="text-status-running underline"
                onClick={() => onOpen(a)}
              >
                Open
              </button>
            </div>
            <MockupFrame
              workItemId={workItemId}
              artifact={a}
              fit={w}
              values={valuesFor(view, a.id)}
              pins={pinsFor(view, a.id)}
              interactive={false}
              className="shadow-[0_0_0_2px_var(--line)]"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A mockup full size at 1280, 834 or 390 wide (spec 21), with its pins and its history. */
export function FullSize({
  view,
  workItemId,
  artifact,
  onClose,
  footer,
}: {
  view: PlanningView;
  workItemId: string;
  artifact: Artifact | null;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const [width, setWidth] = useState("1280");
  useEffect(() => {
    if (artifact) setWidth(String(frameSize(artifact.title, artifact.description).width));
  }, [artifact]);
  return (
    <Dialog open={!!artifact} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(1340px,96vw)] max-w-none overflow-auto sm:max-w-none">
        {artifact && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                {artifact.title}
                <span className="font-mono font-normal text-ink-muted text-xs">
                  rev {artifact.revision} · updated {ago(artifact.updatedAt)}
                </span>
                <span className="grow" />
                <ToggleGroup
                  type="single"
                  value={width}
                  onValueChange={(v) => v && setWidth(v)}
                  size="sm"
                  variant="outline"
                >
                  <ToggleGroupItem value="1280">Desktop</ToggleGroupItem>
                  <ToggleGroupItem value="834">Tablet</ToggleGroupItem>
                  <ToggleGroupItem value="390">Phone</ToggleGroupItem>
                </ToggleGroup>
              </DialogTitle>
            </DialogHeader>
            <div className="flex justify-center">
              <MockupFrame
                workItemId={workItemId}
                artifact={artifact}
                width={Number(width)}
                fit={Math.min(Number(width), 1280)}
                values={valuesFor(view, artifact.id)}
                pins={pinsFor(view, artifact.id)}
                className="border border-line"
              />
            </div>
            {footer}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
