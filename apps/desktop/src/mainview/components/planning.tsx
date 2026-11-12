// The Planning tab (spec 20; restyled for spec 41, design ItemPlan and PlanFocus): questions | the
// plan | chat, the gate bar at the bottom and the session pill. Docked in the work item, chat folds
// to a strip; F gives planning the whole window (focus mode, the shell hides its chrome), Esc gives
// it back. Only what the planning operations support today: new ways to steer the planner are the
// planning build's. It reports who has it open (presence).
// Ported from sf-app for spec 40 M3. Spec 26: the engine pushes `planning.changed` to the desktop's
// live socket for whoever has this view open (presence), and the tab re-reads then; the slow poll
// in `planningQuery` is only a fallback. Planning answers go through `planning.answer` (no Touch ID,
// except for security, privacy and irreversible questions); chat sends after the planner's current
// step (Enter) or interrupts it (⌘-Enter); Stop, Pause and "Let the planner finish alone" steer it.

import { ago, errorMessage } from "@software-factory/client/format";
import type { WorkItemDetail } from "@software-factory/client/ops";
import {
  answerText,
  appliedValues,
  blocks,
  bulkAcceptable,
  changedSpan,
  chipTag,
  editAnswer,
  gateSummary,
  initialAnswer,
  isChanged,
  isSensitiveQuestion,
  markTags,
  type PlanningQuestion,
  type PlanningView,
  questionOptions,
  sessionPill,
} from "@software-factory/client/planning";
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Checkbox } from "@software-factory/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Input } from "@software-factory/ui/components/input";
import { Kbd } from "@software-factory/ui/components/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@software-factory/ui/components/popover";
import { RadioGroup, RadioGroupItem } from "@software-factory/ui/components/radio-group";
import { Slider } from "@software-factory/ui/components/slider";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  CheckIcon,
  MapPinIcon,
  Maximize2Icon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PauseIcon,
  PlayIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import { toast } from "sonner";
import { onPlanningChanged } from "../bridge.ts";
import { NoteDialog, useDecide } from "../lib/decisions.tsx";
import { op, submitKey } from "../lib/op.ts";
import { orphanedComments } from "../lib/plan-blocks.ts";
import { planningQuery } from "../lib/queries.ts";
import { answeredTag, holdsRecommendation, recommendedValues } from "../lib/question-card.ts";
import { setFocus, updateViewState } from "../lib/view-state.ts";
import { OpenTerminal } from "./open-terminal.tsx";
import { type Anchor, PlanBody, releaseEdit, YourEdits } from "./plan-body.tsx";
import { CanvasPane, FullSize, MockupsPane, type Pin } from "./planning-visuals.tsx";
import { approveLabel, useWriteBack, WriteBack } from "./write-back.tsx";

/** How often an open Planning tab says it is still here. */
const PRESENCE_MS = 20_000;

export function Planning({
  detail,
  mode,
}: {
  detail: WorkItemDetail;
  /** Docked in the work item's Plan tab, or focus: the whole window (spec 41). */
  mode: "docked" | "focus";
}) {
  const { item } = detail;
  const planning = useQuery(planningQuery(item.id));
  useLive(item.id, planning.data);
  usePresence(item.id);
  const focus = mode === "focus";
  // Docked, chat folds to a strip on the right; in focus it stays open.
  const [chatOpen, setChatOpen] = useState(false);
  // Spec 21: the workspace's tab, comment mode, a hovered option's preview, a mockup opened full size.
  const [tab, setTab] = useState<"plan" | "mockups" | "canvas">(() => {
    // A link can open the workspace on a tab: `pane=mockups` or `pane=canvas` (spec 21).
    const pane = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("pane");
    return pane === "mockups" || pane === "canvas" ? pane : "plan";
  });
  const [pinMode, setPinMode] = useState(false);
  const [preview, setPreview] = useState<{
    artifactId: string;
    values: Record<string, string>;
  } | null>(null);
  const [opened, setOpened] = useState<PlanningView["artifacts"][number] | null>(null);
  const shown = planning.data?.session?.shownArtifactId ?? null;
  const lastShown = useRef<string | null | undefined>(undefined);
  // The planner showed something: go to it, as kim's `show` does (not on the first load).
  useEffect(() => {
    if (lastShown.current !== undefined && shown && shown !== lastShown.current) setTab("mockups");
    lastShown.current = shown;
  }, [shown]);
  const [draft, setDraft] = useState<Draft>({ text: "" });

  // F gives planning the whole window, Esc gives it back (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (document.querySelector("[role=dialog]")) return;
      if ((e.key === "c" || e.key === "C") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Comment mode (spec 21): the next click on a mockup pins a comment there.
        setPinMode((on) => !on);
        setTab((t) => (t === "plan" ? "mockups" : t));
        return;
      }
      if (e.key === "Escape" && pinMode) {
        setPinMode(false);
        return;
      }
      if (e.key === "Escape" && focus) updateViewState((s) => setFocus(s, null));
      else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        updateViewState((s) => setFocus(s, focus ? null : item.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, item.id, pinMode]);

  const view = planning.data;
  if (!view) {
    return (
      <div className="px-[22px] py-6 text-ink-muted">
        {planning.error ? errorMessage(planning.error) : "Loading the planning view…"}
      </div>
    );
  }
  const discuss = (questionId: string, text = "") => {
    setDraft({ text, questionId });
    setChatOpen(true);
  };
  const showChat = focus || chatOpen;
  // Designs (spec 22) are text in their own notation, not HTML: the mockup panes leave them out.
  const visuals = { ...view, artifacts: view.artifacts.filter((x) => x.kind !== "design") };

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-page"
      data-testid="planning"
      data-fullscreen={focus ? "true" : "false"}
    >
      {!focus && <SessionHeader view={view} detail={detail} />}
      <div className="flex min-h-0 flex-1 border-line-soft border-t">
        <Questions
          view={view}
          workItemId={item.id}
          onDiscuss={discuss}
          onPreview={setPreview}
          className={cn(
            "w-[300px] flex-none overflow-y-auto border-line-soft border-r px-3 py-3",
            focus && "w-[336px]",
          )}
        />
        <section className="flex min-w-0 flex-1 flex-col bg-panel" data-testid="workspace">
          <WorkspaceTabs
            view={view}
            tab={tab}
            onTab={setTab}
            pinMode={pinMode}
            onPinMode={() => {
              setPinMode((on) => !on);
              setTab((t) => (t === "plan" ? "mockups" : t));
            }}
          />
          {tab === "plan" ? (
            <Spec
              view={view}
              workItemId={item.id}
              onComment={(anchor) => {
                setDraft({ text: "", anchor });
                setChatOpen(true);
              }}
              onOverturn={(a) => {
                setDraft({ text: `Overturn this assumption and ask me instead: “${a}”` });
                setChatOpen(true);
              }}
              className="min-h-0 flex-1 overflow-y-auto"
            />
          ) : tab === "mockups" ? (
            <div className="min-h-0 flex-1 overflow-auto">
              <MockupsPane
                view={visuals}
                workItemId={item.id}
                preview={preview}
                pinMode={pinMode}
                onPin={(pin) => {
                  // A pin joins the message being written; it never clears it (review of #90, 3).
                  setDraft((d) => ({ text: d.text, pin }));
                  setPinMode(false);
                  setChatOpen(true);
                }}
                onAsk={(text, questionId) => {
                  setDraft({ text, ...(questionId ? { questionId } : {}) });
                  setChatOpen(true);
                }}
                onOpen={setOpened}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <CanvasPane view={visuals} workItemId={item.id} onOpen={setOpened} />
            </div>
          )}
          <FullSize
            view={visuals}
            workItemId={item.id}
            artifact={opened}
            onClose={() => setOpened(null)}
          />
        </section>
        {showChat ? (
          <Chat
            view={view}
            workItemId={item.id}
            draft={draft}
            onDraft={setDraft}
            onClose={focus ? undefined : () => setChatOpen(false)}
            className="w-[330px] flex-none border-line-soft border-l"
          />
        ) : (
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            className="flex w-10 flex-none flex-col items-center gap-2 border-line-soft border-l bg-panel pt-3 text-ink-3 hover:text-ink"
            data-testid="chat-strip"
            aria-label="Open the chat"
          >
            <MessageSquareIcon className="size-4" />
            {view.messages.length > 0 && (
              <span className="flex size-4 items-center justify-center rounded-full bg-status-running font-semibold text-[10px] text-white">
                {view.messages.length}
              </span>
            )}
            <span className="[writing-mode:vertical-rl]">Chat</span>
          </button>
        )}
      </div>
      {detail.gates.some((g) => g.kind === "spec" && g.status === "pending") && (
        <WriteBack workItemId={item.id} view={view} />
      )}
      <GateBar view={view} detail={detail} />
    </div>
  );
}

/** The session's pill: the planner's state, with its dot. */
export function SessionPill({ view }: { view: PlanningView }) {
  const pill = sessionPill(view.session, view.present.length);
  if (!pill) {
    return (
      <span className="text-ink-muted text-xs">
        No planning session: this item's spec was planned in one-shot rounds.
      </span>
    );
  }
  const dot =
    pill.state === "attached" || pill.state === "working"
      ? "running"
      : pill.state === "waiting" || pill.state === "gate"
        ? "waiting"
        : pill.state === "ended"
          ? "done"
          : "idle";
  return (
    <span
      className="flex h-7 items-center gap-2 rounded-[7px] bg-selected px-2.5"
      data-testid="session-pill"
      data-state={pill.state}
      title={pill.detail ?? undefined}
    >
      <StatusDot status={dot} />
      {pill.label}
    </span>
  );
}

/** Docked: one line above the panes with the session, who's here, and the way into focus. */
function SessionHeader({ view, detail }: { view: PlanningView; detail: WorkItemDetail }) {
  const [moving, setMoving] = useState(false);
  const canMove =
    !!view.session && (view.session.waitingForRunner || view.session.status === "interrupted");
  const pill = sessionPill(view.session, view.present.length);
  return (
    <div className="flex flex-wrap items-center gap-2 px-[22px] py-2">
      <SessionPill view={view} />
      {pill?.detail && (
        <span className="text-ink-muted text-xs" data-testid="session-detail">
          {pill.detail}
        </span>
      )}
      <span className="grow" />
      {view.present.length > 0 && (
        <span className="flex items-center gap-1 text-ink-muted text-xs">
          <StatusDot status="done" /> {view.present.map((p) => p.name).join(", ")} here
        </span>
      )}
      {canMove && (
        <Button variant="outline" size="md" onClick={() => setMoving(true)}>
          Continue on another runner…
        </Button>
      )}
      <OpenTerminal detail={detail} stage="spec" />
      <Button
        size="md"
        onClick={() => updateViewState((s) => setFocus(s, detail.item.id))}
        data-testid="fullscreen"
      >
        <Maximize2Icon className="size-3.5" />
        Focus <Kbd className="bg-transparent text-primary-foreground/70">F</Kbd>
      </Button>
      <MoveDialog
        open={moving}
        onOpenChange={setMoving}
        runner={view.session?.runner?.name ?? null}
        workItemId={detail.item.id}
      />
    </div>
  );
}

/**
 * Re-reads the planning view when the engine pushes a change, and the item (for its gates) whenever
 * the planning view changes (spec 26; the poll in `planningQuery` is only a fallback).
 */
function useLive(workItemId: string, view: PlanningView | undefined) {
  const queryClient = useQueryClient();
  const seen = useRef<PlanningView | undefined>(undefined);
  // The engine says this view changed (spec 26): re-read it now, not at the next poll.
  useEffect(
    () =>
      onPlanningChanged((id) => {
        // "*": the live socket (re)connected, so anything may have changed meanwhile.
        if (id !== workItemId && id !== "*") return;
        void queryClient.invalidateQueries({ queryKey: ["workItem", workItemId, "planning"] });
      }),
    [workItemId, queryClient],
  );
  // Back in front, re-read at once: the view may have missed pushes while hidden (review of #78).
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void queryClient.invalidateQueries({ queryKey: ["workItem", workItemId, "planning"] });
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [workItemId, queryClient]);
  useEffect(() => {
    if (!view) return;
    const first = seen.current === undefined;
    seen.current = view;
    if (first) return;
    void queryClient.invalidateQueries({ queryKey: ["workItem", workItemId], exact: true });
  }, [workItemId, view, queryClient]);
}

/** Tells the planning agent who has the Planning view open (spec 20, presence). */
function usePresence(workItemId: string) {
  useEffect(() => {
    let stopped = false;
    const say = (open: boolean) =>
      op("planning.presence", { workItemId, open }).catch(() => undefined);
    void say(true);
    // Back in front: say so at once, not at the next beat (review of #78).
    const back = () => {
      if (!stopped && document.visibilityState === "visible") void say(true);
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    const timer = setInterval(() => {
      if (!stopped && document.visibilityState === "visible") void say(true);
    }, PRESENCE_MS);
    const leave = () => void say(false);
    window.addEventListener("pagehide", leave);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
      void say(false);
    };
  }, [workItemId]);
}

function MoveDialog({
  open,
  onOpenChange,
  runner,
  workItemId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runner: string | null;
  workItemId: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Continue on another runner?</DialogTitle>
          <DialogDescription>
            The session always waits for {runner ?? "its runner"}. Moving starts a fresh session on
            another runner, rebuilt from the planning record (the spec, questions, answers and
            chat). The old session is stopped if {runner ?? "its runner"} comes back.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep waiting
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await op("planning.move", { workItemId }, { idempotencyKey: submitKey() });
                toast.success("A fresh session starts on the next runner with a free light slot");
                onOpenChange(false);
              } catch (error) {
                toast.error(errorMessage(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            Continue on another runner
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- questions ----
// Design ItemPlan / PlanFocus: answered questions are compact rows on top (a tick, the answer and a
// "default" or "changed by you" tag); each open question lists its options with the recommended one
// already selected and badged, the reason beside it, and "Accept recommended" answers in one click.
// Skip (spec 26) answers with `skipped`: the planner decides it.

function Questions({
  view,
  workItemId,
  onDiscuss,
  onPreview,
  className,
}: {
  view: PlanningView;
  workItemId: string;
  onDiscuss: (questionId: string) => void;
  /** Spec 21: what a hovered option or a dragged slider would show in its mockup. */
  onPreview?: (preview: { artifactId: string; values: Record<string, string> } | null) => void;
  className?: string;
}) {
  const open = view.questions.filter((q) => q.status === "open");
  const answered = view.questions.filter((q) => q.status === "answered");
  const focused = view.session?.focusedQuestionId ?? null;
  const ordered = [...open].sort(
    (a, b) => Number(b.id === focused) - Number(a.id === focused) || a.position - b.position,
  );
  const me = useMe();
  const total = view.questions.length;
  return (
    <section className={cn("flex flex-col gap-2", className)} data-testid="questions-pane">
      <div className="flex items-center gap-2.5 px-1 pb-1 font-semibold">
        Questions
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-line">
          <span
            className="block h-full rounded-full bg-status-running"
            style={{ width: `${total ? (100 * (total - open.length)) / total : 0}%` }}
          />
        </span>
        <span className="font-mono font-normal text-ink-muted text-xs">
          {total - open.length} of {total}
        </span>
      </div>
      {total === 0 && (
        <Card className="px-4 py-5 text-muted-foreground text-sm">
          No questions yet. The planning agent asks them as it drafts the spec.
        </Card>
      )}
      {answered.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="answered">
          {answered.map((q) => (
            <AnsweredRow
              key={`${q.id}:${q.answerRevision}`}
              question={q}
              workItemId={workItemId}
              me={me}
              total={total}
              edit={view.edits.find((e) => e.id === q.answeredViaEdit)}
            />
          ))}
        </div>
      )}
      {ordered.map((q) => (
        <div key={`${q.id}:${q.revision}`} className="grid gap-1.5">
          <EditConfirm question={q} view={view} me={me} />
          <QuestionCard
            question={q}
            workItemId={workItemId}
            focused={q.id === focused}
            total={total}
            messages={view.messages.filter((m) => m.questionId === q.id).length}
            onDiscuss={() => onDiscuss(q.id)}
            {...(onPreview ? { onPreview } : {})}
          />
        </div>
      ))}
    </section>
  );
}

/** The signed-in user's id, from the shell's route context (for "changed by you"). */
function useMe(): string | null {
  const context = useRouteContext({ strict: false }) as { session?: { user: { id: string } } };
  return context.session?.user.id ?? null;
}

function AnsweredRow({
  question: q,
  workItemId,
  me,
  total,
  edit,
}: {
  question: PlanningQuestion;
  workItemId: string;
  me: string | null;
  total: number;
  /** The edit the planner read this answer from (spec 27), shown beside it. */
  edit?: PlanningView["edits"][number];
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <QuestionCard
        question={q}
        workItemId={workItemId}
        focused={false}
        total={total}
        messages={0}
        onDone={() => setEditing(false)}
      />
    );
  }
  const tag = q.skipped
    ? { label: "skipped · the planner decides", changed: true }
    : q.answeredViaEdit
      ? { label: q.answeredBy === me ? "from your edit" : "from an edit", changed: true }
      : q.acceptedAlone
        ? { label: "default · finish alone", changed: false }
        : answeredTag(q, me);
  return (
    <button
      type="button"
      disabled={!q.planning}
      onClick={() => setEditing(true)}
      title={q.planning ? "Change this answer" : undefined}
      className="flex w-full items-start gap-2.5 rounded-lg bg-selected px-3 py-2 text-left enabled:hover:bg-line-soft"
      data-testid={`answered-${q.id}`}
      data-tag={tag.label}
    >
      <span className="mt-px flex size-4 flex-none items-center justify-center rounded-full bg-status-running text-white">
        <CheckIcon className="size-2.5" strokeWidth={3.5} />
      </span>
      <span className="min-w-0 grow">
        <span className="flex items-baseline gap-1.5">
          <span className="font-mono text-[10.5px] text-ink-muted">Q{q.number ?? "·"}</span>
          <span className="font-medium text-[13px]">{q.prompt}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-3">
          <span className="truncate">{q.skipped ? "Skipped" : (q.answer ?? "—")}</span>
          <span
            className={cn(
              "flex-none rounded-full px-1.5 py-px text-[10.5px]",
              tag.changed
                ? "bg-status-running/12 text-status-running"
                : "bg-panel text-ink-3 shadow-[0_0_0_1px_var(--line)]",
            )}
          >
            {tag.label}
          </span>
          {q.answerRevision > 1 && (
            <span className="flex-none text-[10.5px] text-ink-muted">revised</span>
          )}
          <ReadReceipt at={q.answerDeliveredAt} />
        </span>
        {q.answeredViaEdit && (
          // The planner's reading of a person's edit, not their own words (third review of #85):
          // the edit as written beside it, and one click on the row to correct it.
          <span
            className="mt-1 block text-ink-muted text-xs"
            data-testid={`answered-from-edit-${q.id}`}
          >
            The planner read this from {q.answeredBy === me ? "your" : "an"} edit
            {edit ? (
              <>
                :{" "}
                <q className="text-ink-3 italic">
                  {edit.after.trim().replace(/^\s*([-*+]|\d+[.)])\s+/, "")}
                </q>
              </>
            ) : null}
            . <span className="text-status-running underline">Correct it</span>
          </span>
        )}
        {q.note && <span className="mt-0.5 block text-ink-muted text-xs">Note: {q.note}</span>}
      </span>
    </button>
  );
}

function QuestionCard({
  question: q,
  workItemId,
  focused,
  total,
  messages,
  onDiscuss,
  onDone,
  onPreview,
}: {
  question: PlanningQuestion;
  workItemId: string;
  focused: boolean;
  total: number;
  /** Chat messages about this question. */
  messages: number;
  onDiscuss?: () => void;
  onDone?: () => void;
  onPreview?: (preview: { artifactId: string; values: Record<string, string> } | null) => void;
}) {
  const options = questionOptions(q);
  /** Spec 21: shows what an answer would set in the question's mockup, without saving it. */
  const previewAnswer = (answer: string | null) => {
    if (!onPreview || !q.artifactId) return;
    const values =
      answer === null
        ? null
        : appliedValues(
            {
              kind: q.kind,
              artifactId: q.artifactId,
              optionValues: q.optionValues,
              control: q.control,
              unit: q.unit,
            },
            answer,
          );
    onPreview(values ? { artifactId: q.artifactId, values } : null);
  };
  const recommended = recommendedValues(q);
  const [values, setValues] = useState<string[]>(() =>
    q.answer ? initialAnswer(q) : recommended.length ? recommended : initialAnswer(q),
  );
  const [other, setOther] = useState("");
  const [note, setNote] = useState(q.note ?? "");
  const [noting, setNoting] = useState(!!q.note);
  const { decide, pending } = useDecide();
  const [sending, setSending] = useState(false);
  const choice = q.kind === "single-choice" || q.kind === "multiple-choice" || q.kind === "yes-no";
  /**
   * A planning question is answered with `planning.answer` (spec 26): no Touch ID, except for a
   * security, privacy or irreversible one. A question outside a planning session stays a decision.
   */
  const submit = async (input: { answer?: string; skipped?: boolean }) => {
    const note_ = note.trim() ? { note: note.trim() } : {};
    if (!q.planning) {
      return decide({
        kind: "question.answer",
        workItemId,
        questionId: q.id,
        answer: input.answer ?? "",
        ...note_,
      });
    }
    if (needsTouchId(q)) {
      return decide({
        kind: "planning.answer",
        workItemId,
        questionId: q.id,
        questionRevision: q.revision,
        ...input,
        ...note_,
      });
    }
    setSending(true);
    try {
      await op(
        "planning.answer",
        { questionId: q.id, questionRevision: q.revision, ...input, ...note_ },
        { idempotencyKey: submitKey() },
      );
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    } finally {
      setSending(false);
    }
  };
  const multiple = q.kind === "multiple-choice";
  const chosen = other.trim() ? [...values.filter((v) => options.includes(v)), other] : values;
  const answer = answerText(q.kind, multiple ? chosen : other.trim() ? [other] : values);
  const accepting = q.status === "open" && holdsRecommendation(q, values, other);
  const toggle = (option: string) =>
    setValues((v) =>
      multiple ? (v.includes(option) ? v.filter((x) => x !== option) : [...v, option]) : [option],
    );
  const optionRow = (option: string, i: number, control: (id: string) => ReactNode) => {
    const selected = values.includes(option);
    const id = `${q.id}-option-${i}`;
    return (
      <label
        key={option}
        htmlFor={id}
        className={cn(
          "flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-panel px-3 py-2.5 text-[13px]",
          selected && "border-status-running ring-1 ring-status-running",
        )}
        data-testid="question-option"
        data-selected={selected ? "true" : "false"}
        onMouseEnter={() => previewAnswer(option)}
        onMouseLeave={() => previewAnswer(null)}
      >
        {control(id)}
        <span className="grow">{option}</span>
        {recommended.includes(option) && (
          <span className="flex-none rounded-full bg-status-waiting/18 px-2 py-0.5 font-medium text-[11px] text-status-waiting">
            Recommended
          </span>
        )}
      </label>
    );
  };
  return (
    <Card
      className={cn(
        "gap-3 px-3.5 py-3.5",
        q.status === "open" && "shadow-waiting",
        focused && "ring-2 ring-status-running/40",
      )}
      data-testid={`question-${q.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-ink-muted text-xs">
        <span>
          Question {q.number ?? "?"} of {total}
        </span>
        {focused && <span className="text-status-running">asked next</span>}
        <span className="grow" />
        <Badge variant="outline">{q.domain}</Badge>
        {messages > 0 && onDiscuss && (
          <button
            type="button"
            onClick={onDiscuss}
            className="flex items-center gap-1 text-status-running hover:underline"
          >
            <MessageSquareIcon className="size-3" />
            {messages} {messages === 1 ? "message" : "messages"}
          </button>
        )}
      </div>
      {(q.irreversible || q.escalated || !q.blocking) && (
        <div className="-mt-1.5 flex flex-wrap gap-2 text-xs">
          {!q.blocking && <span className="text-ink-muted">not blocking</span>}
          {q.irreversible && (
            <span className="text-status-waiting">irreversible · answer it yourself</span>
          )}
          {q.escalated && <span className="text-status-waiting">escalated</span>}
        </div>
      )}
      <div className="font-semibold text-[14px] leading-snug">{q.prompt}</div>
      {q.context && (
        <div className="text-ink-3 text-xs [&_p]:my-1">
          <Markdown>{q.context}</Markdown>
        </div>
      )}
      {choice && !multiple && (
        <RadioGroup
          value={values[0] ?? ""}
          onValueChange={(v) => setValues([v])}
          aria-label={q.prompt}
          className="gap-2"
        >
          {options.map((option, i) =>
            optionRow(option, i, (id) => (
              <RadioGroupItem
                id={id}
                value={option}
                className="border-ink-muted data-[state=checked]:border-status-running data-[state=checked]:text-status-running [&_svg]:fill-status-running"
              />
            )),
          )}
        </RadioGroup>
      )}
      {multiple && (
        <fieldset className="grid gap-2">
          <legend className="sr-only">{q.prompt}</legend>
          {options.map((option, i) =>
            optionRow(option, i, (id) => (
              <Checkbox
                id={id}
                checked={values.includes(option)}
                onCheckedChange={() => toggle(option)}
              />
            )),
          )}
        </fieldset>
      )}
      {q.recommendationReason && (
        <div className="border-status-waiting border-l-2 pl-3 text-[12.5px] text-ink-3 leading-relaxed [&_p]:my-0">
          <Markdown>{q.recommendationReason}</Markdown>
        </div>
      )}
      {q.kind === "number" && q.control && q.min !== null && q.max !== null ? (
        <div className="flex items-center gap-3" data-testid="question-slider">
          <Slider
            min={q.min}
            max={q.max}
            step={q.step ?? 1}
            value={[Number(values[0] ?? q.defaultAnswer ?? q.min)]}
            onValueChange={([v]) => {
              setValues([String(v)]);
              previewAnswer(String(v));
            }}
            onPointerUp={() => previewAnswer(null)}
            aria-label={q.prompt}
          />
          <span className="w-14 text-right font-mono text-xs">
            {values[0] ?? q.defaultAnswer ?? q.min}
            {q.unit ?? ""}
          </span>
        </div>
      ) : (
        q.kind === "number" && (
          <Input
            type="number"
            value={values[0] ?? ""}
            onChange={(e) => setValues([e.target.value])}
            aria-label={q.prompt}
          />
        )
      )}
      {q.kind === "text" && (
        <Textarea
          rows={2}
          placeholder={q.defaultAnswer ?? "Your answer"}
          value={values[0] ?? ""}
          onChange={(e) => {
            setValues([e.target.value]);
            if (q.control) previewAnswer(e.target.value);
          }}
          onBlur={() => previewAnswer(null)}
          aria-label={q.prompt}
        />
      )}
      {choice && (
        <Input
          placeholder="Other…"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          aria-label="Another answer"
        />
      )}
      {noting && (
        <Input
          placeholder="A note for the agent (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label="Note"
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={!answer || pending !== null || sending}
          className="bg-status-running text-white hover:bg-status-running/90"
          onClick={async () => {
            if (await submit({ answer })) onDone?.();
          }}
          data-testid={`answer-${q.id}`}
        >
          {accepting ? "Accept recommended" : q.status === "answered" ? "Change answer" : "Answer"}
        </Button>
        {q.planning && q.status === "open" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== null || sending}
            title="The planner decides it, and says so in the plan"
            onClick={async () => {
              if (await submit({ skipped: true })) onDone?.();
            }}
            data-testid={`skip-${q.id}`}
          >
            Skip
          </Button>
        )}
        {!noting && (
          <Button size="sm" variant="ghost" onClick={() => setNoting(true)}>
            Add a note
          </Button>
        )}
        {onDiscuss && messages === 0 && (
          <Button size="sm" variant="ghost" onClick={onDiscuss}>
            Discuss
          </Button>
        )}
        {onDone && (
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </Card>
  );
}

/** Security, privacy and irreversible planning questions are still answered with Touch ID. */
const needsTouchId = (q: Pick<PlanningQuestion, "domain" | "irreversible">) =>
  isSensitiveQuestion(q);

/** "✓ Read": when an answer or a message reached the planner (spec 26). */
function ReadReceipt({ at }: { at: string | null | undefined }) {
  if (!at) return null;
  return (
    <span
      className="flex flex-none items-center gap-0.5 text-[10.5px] text-ink-muted"
      title={`Read by the planner ${ago(at)}`}
      data-testid="read-receipt"
    >
      <CheckIcon className="size-2.5" /> Read
    </span>
  );
}

// ---- the living spec ----

function Chip({ tag }: { tag: string }) {
  return (
    <span
      className={cn(
        "mx-0.5 inline-flex items-center rounded-full border px-1.5 py-px align-middle font-mono text-[10px] leading-tight",
        tag === "assumption"
          ? "border-status-waiting/60 bg-status-waiting/15 text-status-waiting"
          : /^Q\d+$/.test(tag)
            ? "border-status-running/40 bg-status-running/10 text-status-running"
            : "text-muted-foreground",
      )}
      data-testid="provenance-chip"
      data-tag={tag}
    >
      {tag}
    </span>
  );
}

/** A chat draft: a message, maybe about a question, a comment on plan lines (spec 27) or a pin on a mockup (spec 21). */
type Draft = { text: string; questionId?: string; anchor?: Anchor; pin?: Pin };

/** The workspace's tabs (design PlanFocus): the plan, the mockups, the canvas, and Comment. */
function WorkspaceTabs({
  view,
  tab,
  onTab,
  pinMode,
  onPinMode,
}: {
  view: PlanningView;
  tab: "plan" | "mockups" | "canvas";
  onTab: (tab: "plan" | "mockups" | "canvas") => void;
  pinMode: boolean;
  onPinMode: () => void;
}) {
  // Designs (spec 22) are text in their own notation, drawn in the System tab: not mockups.
  const mockups = view.artifacts.filter((a) => a.kind !== "design").length;
  return (
    <div
      className="flex h-11 flex-none items-center gap-2 border-line-soft border-b px-4"
      data-testid="workspace-tabs"
    >
      <ToggleGroup
        type="single"
        value={tab}
        onValueChange={(v) => v && onTab(v as "plan" | "mockups" | "canvas")}
        size="sm"
        variant="outline"
      >
        <ToggleGroupItem value="plan" className="px-3">
          Plan
        </ToggleGroupItem>
        <ToggleGroupItem value="mockups" className="gap-1.5 px-3" data-testid="tab-mockups">
          Mockups
          {mockups > 0 && <span className="font-mono text-ink-muted text-xs">{mockups}</span>}
        </ToggleGroupItem>
        <ToggleGroupItem value="canvas" className="px-3" data-testid="tab-canvas">
          Canvas
        </ToggleGroupItem>
      </ToggleGroup>
      <span className="grow" />
      {mockups > 0 && (
        <Button
          size="sm"
          variant={pinMode ? "default" : "outline"}
          onClick={onPinMode}
          title="Pin a comment to an element of a mockup"
          data-testid="comment-mode"
        >
          <MapPinIcon className="size-3.5" />
          {pinMode ? "Click a spot to comment" : "Comment"} <Kbd>C</Kbd>
        </Button>
      )}
    </div>
  );
}

/** Comments whose lines are no longer in the plan (review of #85): listed, never dropped. */
function OrphanedComments({ view, bodyMd }: { view: PlanningView; bodyMd: string }) {
  const orphaned = orphanedComments(view, bodyMd);
  if (!orphaned.length) return null;
  return (
    <div
      className="grid gap-1.5 rounded-lg bg-selected px-3 py-2 text-xs"
      data-testid="orphaned-comments"
    >
      <b className="font-medium">Comments on parts no longer in the plan</b>
      {orphaned.map((m) => (
        <div key={m.id} className="grid gap-0.5">
          <span className="truncate text-ink-muted italic">
            {m.anchor?.quote.replace(/^\s*[-*+]\s+/, "")}
          </span>
          <span>
            <b className="font-medium">{m.authorName}</b>: {m.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function Spec({
  view,
  workItemId,
  onComment,
  onOverturn,
  className,
}: {
  view: PlanningView;
  onOverturn: (assumption: string) => void;
  workItemId: string;
  /** Comment on plan lines (spec 27): opens the chat with the lines as the message's anchor. */
  onComment: (anchor: Anchor) => void;
  className?: string;
}) {
  const { spec, previousSpec } = view;
  const previous = useMemo(
    () =>
      previousSpec
        ? blocks(
            [
              previousSpec.bodyMd,
              ...previousSpec.acceptanceCriteria,
              ...previousSpec.assumptions,
            ].join("\n"),
          )
        : null,
    [previousSpec],
  );
  const me = useMe();
  const components: Components = {
    code: ({ children }) => {
      const tag = chipTag(String(children));
      return tag ? <Chip tag={tag} /> : <code>{children}</code>;
    },
  };
  const inline = (text: string) => (
    <Markdown components={{ ...components, p: ({ children }) => <>{children}</> }}>
      {markTags(text)}
    </Markdown>
  );
  return (
    <section className={cn("bg-panel", className)} data-testid="living-spec">
      <div className="sticky top-0 z-10 flex h-11 flex-wrap items-center gap-2 border-line-soft border-b bg-panel px-6">
        <div className="font-semibold">Plan</div>
        {spec && (
          <Badge variant="outline">
            rev {spec.version} ·{" "}
            {spec.status === "approved" ? "approved" : `updated ${ago(spec.createdAt)}`}
          </Badge>
        )}
        {spec?.summary && <span className="text-muted-foreground text-xs">{spec.summary}</span>}
      </div>
      {!spec ? (
        <div className="px-4 py-4 text-muted-foreground text-sm">
          No spec yet. The planning agent drafts it, then revises it as you answer.
        </div>
      ) : (
        <div className="mx-auto grid max-w-[760px] gap-4 px-8 py-6 leading-relaxed">
          <div className="[&_h1]:mb-3 [&_h1]:font-semibold [&_h1]:text-[20px] [&_h2]:mt-5 [&_h2]:mb-1 [&_h2]:font-medium [&_h2]:text-[11px] [&_h2]:text-ink-muted [&_h2]:uppercase [&_h2]:tracking-[0.06em] [&_h2]:mt-3 [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:my-1.5 [&_code]:font-mono [&_code]:text-xs">
            <PlanBody
              view={view}
              bodyMd={spec.bodyMd}
              specId={spec.id}
              previous={previous}
              components={components}
              workItemId={workItemId}
              me={me}
              onComment={onComment}
            />
          </div>
          {!/^#{1,4}\s*acceptance criteria/im.test(spec.bodyMd) && (
            <div>
              <b>Acceptance criteria</b>
              <ol className="mt-1.5 grid gap-1">
                {spec.acceptanceCriteria.map((c) => (
                  <li
                    key={c}
                    className={cn(
                      "ml-4 list-decimal",
                      isChanged(c, previous) && "border-status-running border-l-2 pl-2",
                    )}
                  >
                    {inline(c)}
                  </li>
                ))}
              </ol>
            </div>
          )}
          <OrphanedComments view={view} bodyMd={spec.bodyMd} />
          <YourEdits view={view} workItemId={workItemId} me={me} components={components} />
          {spec.assumptions.length > 0 && (
            <div data-testid="assumptions">
              <b>Assumptions</b>
              <span className="text-muted-foreground text-xs"> · reversible, overturn any</span>
              <ul className="mt-1.5 grid gap-1.5">
                {spec.assumptions.map((a) => (
                  <li
                    key={a}
                    className="flex items-start gap-2 rounded bg-status-waiting/10 px-2 py-1"
                    data-assumption="true"
                  >
                    <Chip tag="assumption" />
                    <span className="grow">{a.replace(/\s*\[assumption\]\s*/g, " ").trim()}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => onOverturn(a)}
                    >
                      overturn
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {spec.coverage.length > 0 && (
            <div data-testid="coverage">
              <b>Coverage</b>
              <ul className="mt-1.5 grid gap-1">
                {spec.coverage.map((c) => {
                  const item = c as {
                    category: string;
                    status: string;
                    questions?: number[];
                    note?: string;
                  };
                  return (
                    <li key={item.category} className="flex items-center gap-2">
                      <StatusDot
                        status={
                          item.status === "partial"
                            ? "waiting"
                            : item.status === "clear"
                              ? "done"
                              : "idle"
                        }
                      />
                      <span className="grow">{item.category}</span>
                      {item.questions?.map((n) => (
                        <Chip key={n} tag={`Q${n}`} />
                      ))}
                      <span className="text-muted-foreground text-xs">
                        {item.status === "partial" ? "open" : item.status}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {spec.clarifications.length > 0 && (
            <div data-testid="clarifications">
              <b>Clarifications</b>
              <ul className="mt-1.5 grid gap-1 text-xs">
                {spec.clarifications.map((c) => {
                  const item = c as { question?: number; q: string; a: string; date: string };
                  return (
                    <li key={`${item.date}:${item.q}`}>
                      <span className="text-muted-foreground">{item.date}</span>{" "}
                      {item.question && <Chip tag={`Q${item.question}`} />} {item.q} →{" "}
                      <b className="font-medium">{item.a}</b>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---- chat ----

function Chat({
  view,
  workItemId,
  draft,
  onDraft,
  onClose,
  className,
}: {
  view: PlanningView;
  workItemId: string;
  draft: Draft;
  onDraft: (d: Draft) => void;
  onClose?: (() => void) | undefined;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const numbers = new Map(view.questions.map((q) => [q.id, q.number]));
  const count = view.messages.length;
  useEffect(() => {
    if (count) end.current?.scrollIntoView({ block: "end" });
  }, [count]);
  const working =
    view.session && ["working", "yielding"].includes(view.session.status) && view.session.activity;
  const session = view.session;
  const canInterrupt = !!session?.canInterrupt;
  async function send(interrupt = false) {
    const text = draft.text.trim();
    if (!text) return;
    setBusy(true);
    try {
      const sent = await op(
        "chat.send",
        {
          workItemId,
          text,
          ...(draft.questionId ? { questionId: draft.questionId } : {}),
          ...(draft.anchor ? { anchor: draft.anchor } : {}),
          ...(draft.pin ? { pin: draft.pin } : {}),
          ...(interrupt ? { interrupt: true } : {}),
        },
        { idempotencyKey: submitKey() },
      );
      onDraft({ text: "" });
      // An interrupt that couldn't happen still delivers: say when (spec 26).
      if (interrupt && !sent.interrupted && sent.note) toast(capitalise(sent.note));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={cn("flex min-h-0 flex-col bg-panel", className)} data-testid="chat-pane">
      <div className="flex h-11 flex-none items-center gap-2 px-4 font-semibold">
        Chat
        <span className="grow" />
        {session && !["ended", "moved"].includes(session.status) && (
          <PauseButton workItemId={workItemId} paused={session.paused} />
        )}
        {onClose && (
          <button
            type="button"
            aria-label="Fold the chat"
            onClick={onClose}
            className="flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-selected"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-2">
        {view.messages.length === 0 && (
          <div className="text-muted-foreground text-xs">
            Ask the planning agent anything, or tell it what to change. It reads the chat while it
            works.
          </div>
        )}
        {view.messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              "grid gap-0.5 rounded-[10px] px-3 py-2",
              m.author === "agent"
                ? "bg-selected"
                : "ml-6 bg-ink text-window [&_.text-muted-foreground]:text-window/70 [&_.text-foreground]:text-window",
              m.kind === "gate" && "border border-status-waiting/50",
            )}
            data-testid={`message-${m.id}`}
          >
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span className="font-medium text-foreground">{m.authorName}</span>
              {m.kind === "gate" && <Badge variant="outline">spec gate: changes</Badge>}
              {m.questionId && <Chip tag={`Q${numbers.get(m.questionId) ?? "?"}`} />}
              {m.pin && <PinLabel view={view} pin={m.pin} testId="message-pin" />}
              {!m.pin && m.replyTo && pinOf(view, m.replyTo) && (
                <PinLabel
                  view={view}
                  pin={pinOf(view, m.replyTo)}
                  prefix="re "
                  testId="message-reply-pin"
                />
              )}
              {m.anchor && (
                <span className="flex items-center gap-0.5" title={m.anchor.quote}>
                  <MessageSquarePlusIcon className="size-3" /> on the plan
                </span>
              )}
              <span className="grow" />
              {m.author === "person" && <ReadReceipt at={m.deliveredAt} />}
              <span>{ago(m.createdAt)}</span>
            </div>
            <div className="[&_code]:font-mono [&_code]:text-xs [&_p]:my-0.5">
              <Markdown>{m.text}</Markdown>
            </div>
          </div>
        ))}
        {working && (
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs shadow-[0_0_0_1px_var(--line)]"
            data-testid="agent-activity"
          >
            <StatusDot status="running" />
            <span className="grow text-ink-3">{capitalise(String(view.session?.activity))}</span>
            {canInterrupt && <StopButton workItemId={workItemId} />}
          </div>
        )}
        {session?.paused && (
          <div className="text-status-waiting text-xs" data-testid="planner-paused">
            Paused: answers and messages wait until someone resumes it.
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="grid flex-none gap-1.5 border-line-soft border-t px-4 py-3">
        {draft.pin && (
          <div
            className="flex items-center gap-2 text-muted-foreground text-xs"
            data-testid="comment-pin"
          >
            <MapPinIcon className="size-3" />
            <span className="truncate">
              On {draft.pin.element} in{" "}
              {view.artifacts.find((a) => a.id === draft.pin?.artifactId)?.title ?? "a mockup"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-xs"
              onClick={() => onDraft({ text: draft.text })}
            >
              ✕
            </Button>
          </div>
        )}
        {draft.anchor && (
          <div
            className="flex items-center gap-2 text-muted-foreground text-xs"
            data-testid="comment-anchor"
          >
            <span className="truncate border-status-waiting border-l-2 pl-2 italic">
              {draft.anchor.quote.replace(/^\s*[-*+]\s+/, "")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-xs"
              onClick={() => onDraft({ text: draft.text })}
            >
              ✕
            </Button>
          </div>
        )}
        {draft.questionId && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            About <Chip tag={`Q${numbers.get(draft.questionId) ?? "?"}`} />
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-xs"
              onClick={() => onDraft({ text: draft.text })}
            >
              ✕
            </Button>
          </div>
        )}
        <Textarea
          rows={2}
          placeholder="Ask the planner, or tell it what to change…"
          value={draft.text}
          onChange={(e) => onDraft({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              // ⌘-Enter interrupts the planner's current step; Enter waits for it (spec 26).
              void send(e.metaKey && canInterrupt);
            }
          }}
          data-testid="chat-input"
        />
        <div
          className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-muted"
          data-testid="chat-hint"
        >
          <Kbd>↵</Kbd> after its step
          <span className="grow" />
          {canInterrupt ? (
            <>
              <Kbd>⌘↵</Kbd> interrupt
            </>
          ) : (
            <span title="This runner can't interrupt the planner: messages arrive after its step">
              no interrupt here
            </span>
          )}
          <Button
            size="sm"
            className="ml-1"
            disabled={!draft.text.trim() || busy}
            onClick={() => send(false)}
          >
            Send
          </Button>
        </div>
      </div>
    </section>
  );
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Stops the planner's current step (spec 26): the session stays, and it waits for you. */
function StopButton({ workItemId }: { workItemId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className="font-medium text-destructive hover:underline disabled:opacity-50"
      onClick={async () => {
        setBusy(true);
        try {
          const r = await op("planning.stop", { workItemId }, { idempotencyKey: submitKey() });
          if (!r.stopped && r.note) toast(capitalise(r.note));
        } catch (error) {
          toast.error(errorMessage(error));
        } finally {
          setBusy(false);
        }
      }}
      data-testid="stop-planner"
    >
      Stop
    </button>
  );
}

/** Pauses the planner (news waits) or resumes it (spec 26). */
function PauseButton({ workItemId, paused }: { workItemId: string; paused: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      className="h-6 px-2 font-normal text-xs"
      onClick={async () => {
        setBusy(true);
        try {
          await op(
            paused ? "planning.resume" : "planning.pause",
            { workItemId },
            {
              idempotencyKey: submitKey(),
            },
          );
        } catch (error) {
          toast.error(errorMessage(error));
        } finally {
          setBusy(false);
        }
      }}
      data-testid={paused ? "resume-planner" : "pause-planner"}
    >
      {paused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
      {paused ? "Resume" : "Pause"}
    </Button>
  );
}

/**
 * "Let the planner finish alone" (spec 26, ADR 0470): the recommended answers are accepted now and as
 * the planner asks, except security, privacy, irreversible and no-default questions; approval stays
 * yours. Shows who turned it on, and turns off on a click.
 */
function FinishAlone({ view, workItemId }: { view: PlanningView; workItemId: string }) {
  const [busy, setBusy] = useState(false);
  const on = view.session?.finishAlone ?? null;
  const set = async (value: boolean) => {
    setBusy(true);
    try {
      await op("planning.finishAlone", { workItemId, on: value }, { idempotencyKey: submitKey() });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  if (on) {
    return (
      <span className="flex items-center gap-2 text-sm" data-testid="finish-alone-on">
        <ZapIcon className="size-3.5 text-status-running" />
        Finishing alone · set by {on.byName} {ago(on.at)}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => set(false)}>
          Turn off
        </Button>
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      title="Accept the recommended answers now and as the planner asks. Security, privacy and irreversible questions still wait for you, and you still approve the plan."
      onClick={() => set(true)}
      data-testid="finish-alone"
    >
      <ZapIcon className="size-3.5" />
      Let the planner finish alone
    </Button>
  );
}

// ---- the gate bar ----

function GateBar({ view, detail }: { view: PlanningView; detail: WorkItemDetail }) {
  const { item } = detail;
  const { decide, pending } = useDecide();
  const [changes, setChanges] = useState(false);
  const open = view.questions.filter((q) => q.status === "open");
  const bulk = open.filter(bulkAcceptable).length;
  // Planning questions are bulk-accepted without Touch ID (spec 26); others stay a decision.
  const planningOnly = open.every((q) => q.planning);
  const acceptPlanning = async () => {
    try {
      const r = await op(
        "planning.acceptDefaults",
        { workItemId: item.id },
        { idempotencyKey: submitKey() },
      );
      toast.success(
        r.skipped.length
          ? `Accepted ${r.accepted.length}; ${r.skipped.length} must be answered one by one`
          : `Accepted ${r.accepted.length} recommended answer${r.accepted.length === 1 ? "" : "s"}`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const specGate = detail.gates.find((g) => g.kind === "spec" && g.status === "pending");
  const canApprove = !!specGate && detail.viewer.isApprover;
  // What approving writes (review of #130): the person sees the list before the button is live.
  const writeBack = useWriteBack(item.id, view, !!specGate);
  const partial = view.spec?.coverage.filter((c) => (c as { status: string }).status === "partial");
  return (
    <div
      className="flex flex-none flex-wrap items-center gap-2 border-line-soft border-t bg-panel px-[22px] py-2.5"
      data-testid="gate-bar"
    >
      <span className="text-muted-foreground text-sm" data-testid="planning-progress">
        {gateSummary(view)}
      </span>
      <EditsNotKept view={view} workItemId={item.id} />
      <CriticNotes view={view} />
      {specGate && partial && partial.length > 0 && (
        <span className="text-status-waiting text-xs">
          {partial.length} coverage categor{partial.length === 1 ? "y" : "ies"} still partial
        </span>
      )}
      <span className="grow" />
      {view.session && !["ended", "moved"].includes(view.session.status) && !specGate && (
        <FinishAlone view={view} workItemId={item.id} />
      )}
      {open.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          disabled={bulk === 0 || pending !== null}
          title={bulk === 0 ? "The open questions need an answer one by one" : undefined}
          onClick={() =>
            planningOnly
              ? acceptPlanning()
              : decide({ kind: "question.acceptDefaults", workItemId: item.id })
          }
          data-testid="accept-defaults"
        >
          Accept {bulk} recommended
        </Button>
      )}
      {specGate ? (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={!canApprove || pending !== null}
            onClick={() => setChanges(true)}
          >
            Request changes
          </Button>
          <Button
            size="sm"
            disabled={!canApprove || pending !== null || !writeBack}
            title={canApprove ? undefined : "Only an approver on this project can approve the spec"}
            onClick={() => decide({ kind: "spec.approve", workItemId: item.id })}
            data-testid="approve-spec"
          >
            {approveLabel(writeBack?.kimCount)}
          </Button>
        </>
      ) : (
        view.session && (
          <span className="text-muted-foreground text-xs">
            The agent asks for the spec gate when the spec is ready.
          </span>
        )
      )}
      <NoteDialog
        open={changes}
        onOpenChange={setChanges}
        title="Request changes to the spec"
        description="Your note goes into the same planning session as a message from you; the agent revises and asks for the gate again."
        confirm="Send to the planning agent"
        onConfirm={(note) => decide({ kind: "spec.requestChanges", workItemId: item.id, note })}
      />
    </div>
  );
}

/** The pin of the message `id` replies to, if that message is a pinned comment (spec 21, AC4). */
function pinOf(view: PlanningView, id: string): Pin | null {
  return view.messages.find((x) => x.id === id)?.pin ?? null;
}

/** A pinned comment's element, titled with its mockup; a reply to one says "re" it. */
function PinLabel({
  view,
  pin,
  prefix = "",
  testId,
}: {
  view: PlanningView;
  pin: Pin | null;
  prefix?: string;
  testId: string;
}) {
  if (!pin) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-0.5 truncate"
      title={view.artifacts.find((a) => a.id === pin.artifactId)?.title ?? "a mockup"}
      data-testid={testId}
    >
      <MapPinIcon className="size-3 flex-none" /> {prefix}
      {pin.element}
    </span>
  );
}

/**
 * The edits the plan doesn't keep word for word, at the gate bar (review of #85, round 2). They hold
 * the gate (`planning.ready` refuses), and no block of the plan shows them any more, so each is
 * listed here with "Let it reword": a person can always let the planner go on.
 */
function EditsNotKept({ view, workItemId }: { view: PlanningView; workItemId: string }) {
  const notKept = view.edits.filter((e) => !e.kept);
  if (notKept.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0 text-destructive"
          data-testid="edits-not-kept"
        >
          {notKept.length} edit{notKept.length === 1 ? "" : "s"} not in the plan as written
        </Button>
      </PopoverTrigger>
      <PopoverContent className="grid w-96 gap-3" data-testid="edits-not-kept-list">
        <div className="text-muted-foreground text-xs">
          The planner can't ask for the gate until the plan keeps these edits word for word, or the
          edit is released.
        </div>
        {notKept.map((e) => (
          <div key={e.id} className="grid gap-1 text-sm">
            <div className="text-muted-foreground text-xs">
              {e.authorName}, {ago(e.createdAt)}
            </div>
            <div className="line-clamp-4 whitespace-pre-wrap rounded bg-selected px-2 py-1">
              {e.after || <span className="text-muted-foreground">(deleted lines)</span>}
            </div>
            <Button
              variant="outline"
              size="xs"
              className="justify-self-start"
              onClick={() => releaseEdit(workItemId, e.id)}
              data-testid={`edit-release-${e.id}`}
            >
              Let it reword
            </Button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A person edited an open question's line in the plan (fourth review of #85): the planner records
 * an answer from an edit only when the change is exactly an option, so the person is offered a
 * one-tap confirm instead. Not for security, privacy or irreversible questions, which keep their
 * own answer path.
 */
function EditConfirm({
  question: q,
  view,
  me,
}: {
  question: PlanningQuestion;
  view: PlanningView;
  me: string | null;
}) {
  const [sending, setSending] = useState(false);
  if (q.status !== "open" || isSensitiveQuestion(q) || q.number === null) return null;
  const tag = `[Q${q.number}]`;
  const edit = [...view.edits].reverse().find((e) => e.authorId === me && e.after.includes(tag));
  const span = edit ? changedSpan(edit.before, edit.after, tag) : null;
  if (!edit || !span) return null;
  const line = (edit.after.split("\n").find((l) => l.includes(tag)) ?? "")
    .replace(tag, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/, "")
    .trim();
  const exact = editAnswer(span, q.options);
  const record = async (answer: string) => {
    setSending(true);
    try {
      await op(
        "planning.answer",
        { questionId: q.id, questionRevision: q.revision, answer },
        { idempotencyKey: submitKey() },
      );
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSending(false);
    }
  };
  return (
    <div
      className="grid gap-1.5 rounded-lg border border-status-running/30 bg-status-running/5 px-3 py-2 text-xs"
      data-testid={`edit-confirm-${q.id}`}
    >
      <span>
        You edited Q{q.number}'s line to “{line}”. Record that as your answer?
      </span>
      <span className="flex flex-wrap gap-1.5">
        {q.options.length > 0 ? (
          q.options.map((o) => (
            <Button
              key={o}
              size="xs"
              variant={o === exact ? "default" : "outline"}
              disabled={sending}
              onClick={() => record(o)}
            >
              {o}
            </Button>
          ))
        ) : (
          <Button size="xs" disabled={sending} onClick={() => record(span)}>
            Record “{span}”
          </Button>
        )}
      </span>
    </div>
  );
}

/**
 * The spec critic's notes on the plan at the gate (spec 23 part C): a second agent's reading, shown
 * to the person deciding. Notes only: they open and close nothing.
 */
function CriticNotes({ view }: { view: PlanningView }) {
  const critique = view.spec?.critique;
  if (!critique) return null;
  const label =
    critique.status === "timed_out"
      ? "Critic: didn't finish in time"
      : critique.status === "failed"
        ? "Critic: no notes (its run failed)"
        : `Critic: ${critique.notes.length} note${critique.notes.length === 1 ? "" : "s"}`;
  if (critique.status !== "done" || critique.notes.length === 0) {
    return (
      <span className="text-muted-foreground text-xs" data-testid="critic-notes">
        {label}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="link" size="xs" className="h-auto p-0" data-testid="critic-notes">
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="grid w-[26rem] gap-2 text-sm" data-testid="critic-notes-list">
        <div className="text-muted-foreground text-xs">
          A second agent read the plan and the repository. Its notes are for you and the planner;
          they decide nothing.
        </div>
        {critique.summary && <div className="font-medium">{critique.summary}</div>}
        <ul className="grid list-disc gap-1 pl-4">
          {critique.notes.map((n, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: notes are fixed text; two may read the same.
            <li key={i}>{n}</li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
