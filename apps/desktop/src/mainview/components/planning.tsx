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
  blocks,
  bulkAcceptable,
  chipTag,
  foldSpace,
  gateSummary,
  initialAnswer,
  isChanged,
  isSensitiveQuestion,
  markTags,
  type PlanningQuestion,
  type PlanningView,
  planBlocks,
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
import { RadioGroup, RadioGroupItem } from "@software-factory/ui/components/radio-group";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  CheckIcon,
  Maximize2Icon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PauseIcon,
  PencilIcon,
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
import { planningQuery } from "../lib/queries.ts";
import { answeredTag, holdsRecommendation, recommendedValues } from "../lib/question-card.ts";
import { setFocus, updateViewState } from "../lib/view-state.ts";
import { OpenTerminal } from "./open-terminal.tsx";

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
  const [draft, setDraft] = useState<Draft>({ text: "" });

  // F gives planning the whole window, Esc gives it back (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (document.querySelector("[role=dialog]")) return;
      if (e.key === "Escape" && focus) updateViewState((s) => setFocus(s, null));
      else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        updateViewState((s) => setFocus(s, focus ? null : item.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, item.id]);

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
          className={cn(
            "w-[300px] flex-none overflow-y-auto border-line-soft border-r px-3 py-3",
            focus && "w-[336px]",
          )}
        />
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
          className="min-w-0 flex-1 overflow-y-auto"
        />
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
  className,
}: {
  view: PlanningView;
  workItemId: string;
  onDiscuss: (questionId: string) => void;
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
            />
          ))}
        </div>
      )}
      {ordered.map((q) => (
        <QuestionCard
          key={`${q.id}:${q.revision}`}
          question={q}
          workItemId={workItemId}
          focused={q.id === focused}
          total={total}
          messages={view.messages.filter((m) => m.questionId === q.id).length}
          onDiscuss={() => onDiscuss(q.id)}
        />
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
}: {
  question: PlanningQuestion;
  workItemId: string;
  me: string | null;
  total: number;
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
}: {
  question: PlanningQuestion;
  workItemId: string;
  focused: boolean;
  total: number;
  /** Chat messages about this question. */
  messages: number;
  onDiscuss?: () => void;
  onDone?: () => void;
}) {
  const options = questionOptions(q);
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
      {q.kind === "number" && (
        <Input
          type="number"
          value={values[0] ?? ""}
          onChange={(e) => setValues([e.target.value])}
          aria-label={q.prompt}
        />
      )}
      {q.kind === "text" && (
        <Textarea
          rows={2}
          placeholder={q.defaultAnswer ?? "Your answer"}
          value={values[0] ?? ""}
          onChange={(e) => setValues([e.target.value])}
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

/** A hast node's text, for comparing a block with the previous revision. */
function hastText(node: unknown): string {
  const n = node as { value?: string; children?: unknown[] } | undefined;
  if (!n) return "";
  if (typeof n.value === "string") return n.value;
  return (n.children ?? []).map(hastText).join("");
}

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

/** A chat draft: a message, maybe about a question, maybe a comment on plan lines (spec 27). */
type Draft = { text: string; questionId?: string; anchor?: Anchor };
type Anchor = { specId: string; lineStart: number; lineEnd: number; quote: string };

/**
 * Whether a block is a person's edit: one of the blocks the edit wrote, exactly, as the server
 * compares them (ADR 0471, review of #85). Text the planner adds to it makes it the planner's.
 */
const matchesEdit = (raw: string, after: string) =>
  planBlocks(after).some((b) => b.text === foldSpace(raw));

/**
 * The comments anchored to a block: the same text, and when several blocks read the same, the one
 * nearest the lines the comment was made on (review of #85).
 */
function commentsOn(
  view: PlanningView,
  raw: string,
  lineStart: number,
  blocks: { text: string; lineStart: number }[],
) {
  const text = foldSpace(raw);
  const same = blocks.filter((b) => b.text === text);
  return view.messages.filter((m) => {
    if (!m.anchor || foldSpace(m.anchor.quote) !== text) return false;
    const nearest = same.reduce((best, b) =>
      Math.abs(b.lineStart - (m.anchor?.lineStart ?? 0)) <
      Math.abs(best.lineStart - (m.anchor?.lineStart ?? 0))
        ? b
        : best,
    );
    return nearest.lineStart === lineStart;
  });
}

/**
 * One block of the plan, with Edit and Comment (spec 27, design PlanFocus): Edit opens its source
 * lines in place and saves them as the person's edit; Comment starts a chat message anchored to
 * them. An edited block says who edited it and that the planner keeps their wording.
 */
function PlanBlock({
  Tag,
  className,
  data,
  raw,
  anchor,
  workItemId,
  edit,
  settled,
  comments,
  me,
  onComment,
  children,
}: {
  Tag: "li" | "div";
  className: string;
  data: Record<string, string | undefined>;
  raw: string;
  anchor: Anchor;
  workItemId: string;
  edit: PlanningView["edits"][number] | undefined;
  settled: PlanningQuestion[];
  comments: number;
  me: string | null;
  onComment: (anchor: Anchor) => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(raw);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await op(
        "spec.edit",
        {
          workItemId,
          specId: anchor.specId,
          lineStart: anchor.lineStart,
          lineEnd: anchor.lineEnd,
          before: raw,
          after: value,
        },
        { idempotencyKey: submitKey() },
      );
      setEditing(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const updated = edit ? settled.filter((q) => q.answeredViaEdit === edit.id) : [];
  return (
    <Tag
      className={cn(
        "group/block relative",
        className,
        edit && "-ml-2 rounded-md bg-status-running/8 pl-2 ring-1 ring-status-running/30",
      )}
      {...data}
      data-edited={edit ? "true" : undefined}
    >
      {editing ? (
        <span className="grid gap-1.5 py-1" data-testid="plan-block-editor">
          <Textarea
            rows={Math.max(1, value.split("\n").length)}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) void save();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label="Edit this part of the plan"
            className="font-mono text-[12.5px]"
            autoFocus
          />
          <span className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            The planner keeps your wording and updates the answers to match.
            <span className="grow" />
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving || value === raw} onClick={save}>
              Save <Kbd className="bg-transparent text-primary-foreground/70">⌘↵</Kbd>
            </Button>
          </span>
        </span>
      ) : (
        children
      )}
      {!editing && (
        <span className="absolute top-0 -right-1 hidden translate-x-full gap-0.5 pl-1 group-hover/block:flex">
          <button
            type="button"
            title="Edit this line"
            aria-label="Edit this line"
            className="flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-selected"
            onClick={() => {
              setValue(raw);
              setEditing(true);
            }}
            data-testid="plan-block-edit"
          >
            <PencilIcon className="size-3.5" />
          </button>
          <button
            type="button"
            title="Comment on this line"
            aria-label="Comment on this line"
            className="flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-selected"
            onClick={() => onComment(anchor)}
            data-testid="plan-block-comment"
          >
            <MessageSquarePlusIcon className="size-3.5" />
          </button>
        </span>
      )}
      {comments > 0 && !editing && (
        <button
          type="button"
          onClick={() => onComment(anchor)}
          className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-status-waiting/15 px-1.5 align-middle text-[10.5px] text-status-waiting"
          data-testid="plan-block-comments"
        >
          <MessageSquareIcon className="size-2.5" />
          {comments}
        </button>
      )}
      {edit && !editing && (
        <span
          className="mt-0.5 flex items-center gap-1 text-[11.5px] text-status-running"
          data-testid="plan-block-edited"
        >
          <PencilIcon className="size-3" />
          {edit.authorId === me ? "You" : edit.authorName} edited this line {ago(edit.createdAt)}.
          The planner keeps the wording
          {updated.length > 0
            ? ` and updated ${updated.map((q) => `Q${q.number ?? "?"}`).join(", ")} to match`
            : ""}
          .
          <button
            type="button"
            className="ml-1 underline"
            title="Let the planner reword it"
            onClick={async () => {
              try {
                await op(
                  "spec.releaseEdit",
                  { workItemId, editId: edit.id },
                  { idempotencyKey: submitKey() },
                );
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
            data-testid="plan-block-release"
          >
            Let it reword
          </button>
        </span>
      )}
    </Tag>
  );
}

/** Comments whose lines are no longer in the plan (review of #85): listed, never dropped. */
function OrphanedComments({ view, bodyMd }: { view: PlanningView; bodyMd: string }) {
  const present = new Set(planBlocks(bodyMd).map((b) => b.text));
  const orphaned = view.messages.filter((m) => m.anchor && !present.has(foldSpace(m.anchor.quote)));
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
  const sourceLines = spec ? spec.bodyMd.split("\n") : [];
  const block =
    (Tag: "p" | "li") =>
    ({ node, children }: { node?: unknown; children?: ReactNode }) => {
      const text = hastText(node);
      const className = cn(
        Tag === "p" && "my-1.5",
        text.includes("⟦assumption⟧") && "rounded bg-status-waiting/10 px-1",
        isChanged(text, previous) && "border-status-running border-l-2 pl-2",
      );
      const data = {
        "data-changed": isChanged(text, previous) ? "true" : undefined,
        "data-assumption": text.includes("⟦assumption⟧") ? "true" : undefined,
      };
      // Spec 27: a block's own source lines, for editing and commenting. A paragraph inside a
      // list item is the item's: only the item gets the controls.
      const pos = (node as { position?: { start: { line: number }; end: { line: number } } })
        ?.position;
      const lineStart = pos ? pos.start.line - 1 : -1;
      const lineEnd = pos ? pos.end.line - 1 : -1;
      const raw = lineStart >= 0 ? sourceLines.slice(lineStart, lineEnd + 1).join("\n") : "";
      const inItem = Tag === "p" && /^\s*([-*+]|\d+[.)])\s/.test(raw);
      if (!spec || lineStart < 0 || inItem) {
        return Tag === "li" ? (
          <li className={className} {...data}>
            {children}
          </li>
        ) : (
          <div className={className} {...data}>
            {children}
          </div>
        );
      }
      return (
        <PlanBlock
          Tag={Tag === "li" ? "li" : "div"}
          className={className}
          data={data}
          raw={raw}
          anchor={{ specId: spec.id, lineStart, lineEnd, quote: raw }}
          workItemId={workItemId}
          edit={view.edits.find((e) => matchesEdit(raw, e.after))}
          settled={view.questions.filter((q) => q.answeredViaEdit !== null)}
          comments={commentsOn(view, raw, lineStart, planBlocks(spec.bodyMd)).length}
          me={me}
          onComment={onComment}
        >
          {children}
        </PlanBlock>
      );
    };
  const components: Components = {
    code: ({ children }) => {
      const tag = chipTag(String(children));
      return tag ? <Chip tag={tag} /> : <code>{children}</code>;
    },
    p: block("p"),
    li: block("li"),
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
            <Markdown components={components}>{markTags(spec.bodyMd)}</Markdown>
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
  const partial = view.spec?.coverage.filter((c) => (c as { status: string }).status === "partial");
  return (
    <div
      className="flex flex-none flex-wrap items-center gap-2 border-line-soft border-t bg-panel px-[22px] py-2.5"
      data-testid="gate-bar"
    >
      <span className="text-muted-foreground text-sm" data-testid="planning-progress">
        {gateSummary(view)}
      </span>
      {view.edits.some((e) => !e.kept) && (
        <span className="text-destructive text-xs" data-testid="edits-not-kept">
          {view.edits.filter((e) => !e.kept).length} of your edits aren't in the plan as written
        </span>
      )}
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
            disabled={!canApprove || pending !== null}
            title={canApprove ? undefined : "Only an approver on this project can approve the spec"}
            onClick={() => decide({ kind: "spec.approve", workItemId: item.id })}
            data-testid="approve-spec"
          >
            Approve spec
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
