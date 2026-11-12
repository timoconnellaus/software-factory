// The Planning tab, layout A (spec 20; mockups planning-three-pane, planning-full-screen and
// planning-session-states): questions | spec | chat, the gate bar at the bottom, the session pill,
// a full-screen toggle (F / Esc) and tabs on a phone. Live: the engine pushes a Server-Sent Event per
// change and the tab re-reads the planning view; it also reports who has it open (presence).
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
import { Label } from "@software-factory/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@software-factory/ui/components/radio-group";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import { toast } from "sonner";
import { ago, errorMessage } from "#/lib/format";
import { op, submitKey } from "#/lib/op";
import type { WorkItemDetail } from "#/lib/ops";
import {
  answerText,
  blocks,
  bulkAcceptable,
  chipTag,
  gateSummary,
  initialAnswer,
  isChanged,
  markTags,
  type PlanningQuestion,
  type PlanningView,
  questionOptions,
  sessionPill,
} from "#/lib/planning";
import { planningQuery } from "#/lib/queries";
import { NoteDialog, useDecide } from "./decisions.tsx";

type Pane = "questions" | "spec" | "chat";
/** How often an open Planning tab says it is still here. */
const PRESENCE_MS = 20_000;

export function Planning({ detail }: { detail: WorkItemDetail }) {
  const { item } = detail;
  const planning = useQuery(planningQuery(item.id));
  useLive(item.id);
  usePresence(item.id);
  const [full, setFull] = useState(false);
  const [pane, setPane] = useState<Pane>("questions");
  const [draft, setDraft] = useState<{ text: string; questionId?: string }>({ text: "" });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "Escape") setFull(false);
      else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setFull((f) => !f);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const view = planning.data;
  if (!view) {
    return (
      <Card className="px-5 py-6 text-muted-foreground text-sm">
        {planning.error ? errorMessage(planning.error) : "Loading the planning view…"}
      </Card>
    );
  }
  const discuss = (questionId: string, text = "") => {
    setDraft({ text, questionId });
    setPane("chat");
  };

  return (
    <div
      className={cn(
        "grid gap-3",
        full && "fixed inset-0 z-50 grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-background p-4",
      )}
      data-testid="planning"
      data-fullscreen={full ? "true" : "false"}
    >
      <SessionHeader
        view={view}
        title={full ? `#${item.number} · ${item.title}` : null}
        full={full}
        onFull={() => setFull((f) => !f)}
        workItemId={item.id}
      />
      <div className="flex gap-1 md:hidden" role="tablist" data-testid="planning-phone-tabs">
        {(["questions", "spec", "chat"] as const).map((p) => (
          <Button
            key={p}
            size="sm"
            variant={pane === p ? "default" : "outline"}
            role="tab"
            aria-selected={pane === p}
            onClick={() => setPane(p)}
          >
            {p === "questions"
              ? `Questions ${view.questions.filter((q) => q.status === "open").length}`
              : p === "spec"
                ? "Spec"
                : "Chat"}
          </Button>
        ))}
      </div>
      <div
        className={cn(
          "grid gap-3 md:grid-cols-[minmax(240px,1fr)_minmax(0,1.6fr)] xl:grid-cols-[minmax(260px,1fr)_minmax(0,1.6fr)_minmax(260px,1fr)]",
          full && "min-h-0",
        )}
      >
        <Questions
          view={view}
          workItemId={item.id}
          onDiscuss={discuss}
          className={cn(pane !== "questions" && "hidden md:grid", full && "min-h-0 overflow-auto")}
        />
        <Spec
          view={view}
          onOverturn={(a) => {
            setDraft({ text: `Overturn this assumption and ask me instead: “${a}”` });
            setPane("chat");
          }}
          className={cn(pane !== "spec" && "hidden md:grid", full && "min-h-0 overflow-auto")}
        />
        <Chat
          view={view}
          workItemId={item.id}
          draft={draft}
          onDraft={setDraft}
          className={cn(
            pane !== "chat" && "hidden xl:grid",
            pane === "chat" && "md:col-span-2 xl:col-span-1",
            full && "min-h-0",
          )}
        />
      </div>
      <GateBar view={view} detail={detail} />
    </div>
  );
}

/** Re-reads the planning view (and the item, for its gates) whenever the engine says it changed. */
function useLive(workItemId: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/work/${workItemId}/planning/live`);
    const changed = () => {
      void queryClient.invalidateQueries({ queryKey: ["workItem", workItemId] });
    };
    source.addEventListener("changed", changed);
    return () => {
      source.removeEventListener("changed", changed);
      source.close();
    };
  }, [workItemId, queryClient]);
}

/** Tells the planning agent who has the Planning view open (spec 20, presence). */
function usePresence(workItemId: string) {
  useEffect(() => {
    let stopped = false;
    const say = (open: boolean) =>
      op("planning.presence", { workItemId, open }).catch(() => undefined);
    void say(true);
    const timer = setInterval(() => {
      if (!stopped && document.visibilityState === "visible") void say(true);
    }, PRESENCE_MS);
    const leave = () => void say(false);
    window.addEventListener("pagehide", leave);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      void say(false);
    };
  }, [workItemId]);
}

function SessionHeader({
  view,
  title,
  full,
  onFull,
  workItemId,
}: {
  view: PlanningView;
  title: string | null;
  full: boolean;
  onFull: () => void;
  workItemId: string;
}) {
  const pill = sessionPill(view.session, view.present.length);
  const [moving, setMoving] = useState(false);
  const canMove =
    !!view.session && (view.session.waitingForRunner || view.session.status === "interrupted");
  const dot =
    pill?.state === "attached" || pill?.state === "working"
      ? "running"
      : pill?.state === "waiting" || pill?.state === "gate"
        ? "waiting"
        : pill?.state === "ended"
          ? "done"
          : "idle";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {title && <div className="font-semibold">{title}</div>}
      {pill ? (
        <div
          className={cn(
            "flex items-center gap-2 rounded-full border px-3 py-1 text-sm",
            pill.state === "waiting" && "border-status-waiting/50 bg-status-waiting/10",
          )}
          data-testid="session-pill"
          data-state={pill.state}
          title={pill.detail ?? undefined}
        >
          <StatusDot status={dot} />
          {pill.label}
        </div>
      ) : (
        <span className="text-muted-foreground text-sm">
          No planning session: this item's spec was planned in one-shot rounds.
        </span>
      )}
      {pill?.detail && (
        <span className="text-muted-foreground text-xs" data-testid="session-detail">
          {pill.detail}
        </span>
      )}
      <span className="grow" />
      {view.present.length > 0 && (
        <span className="flex items-center gap-1 text-muted-foreground text-xs">
          <StatusDot status="done" /> {view.present.map((p) => p.name).join(", ")} here
        </span>
      )}
      {canMove && (
        <Button size="sm" variant="outline" onClick={() => setMoving(true)}>
          Continue on another runner…
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onFull} data-testid="fullscreen">
        {full ? "⤡ Exit full screen" : "⤢ Full screen"} <Kbd>{full ? "Esc" : "F"}</Kbd>
      </Button>
      <MoveDialog
        open={moving}
        onOpenChange={setMoving}
        runner={view.session?.runner?.name ?? null}
        workItemId={workItemId}
      />
    </div>
  );
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
  return (
    <section className={cn("grid content-start gap-3", className)} data-testid="questions-pane">
      <div className="font-semibold text-sm">
        Questions <span className="text-muted-foreground">· open {open.length}</span>
      </div>
      {view.questions.length === 0 && (
        <Card className="px-4 py-5 text-muted-foreground text-sm">
          No questions yet. The planning agent asks them as it drafts the spec.
        </Card>
      )}
      {ordered.map((q) => (
        <QuestionCard
          key={`${q.id}:${q.revision}`}
          question={q}
          workItemId={workItemId}
          focused={q.id === focused}
          onDiscuss={() => onDiscuss(q.id)}
        />
      ))}
      {answered.length > 0 && (
        <Card className="gap-1.5 px-4 py-3" data-testid="answered">
          <div className="font-semibold text-sm">Answered</div>
          {answered.map((q) => (
            <AnsweredRow key={`${q.id}:${q.answerRevision}`} question={q} workItemId={workItemId} />
          ))}
        </Card>
      )}
    </section>
  );
}

function AnsweredRow({ question, workItemId }: { question: PlanningQuestion; workItemId: string }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <QuestionCard
        question={question}
        workItemId={workItemId}
        focused={false}
        onDone={() => setEditing(false)}
      />
    );
  }
  const changed = !question.acceptedDefault && question.answer !== question.defaultAnswer;
  return (
    <div className="flex items-start gap-2 text-sm" data-testid={`answered-${question.id}`}>
      <StatusDot status="done" className="mt-1.5" />
      <div className="grow">
        <span className="text-muted-foreground">
          {question.number ?? "·"}. {question.prompt}
        </span>{" "}
        <b className="font-medium">{question.answer ?? "—"}</b>
        <span className="text-muted-foreground text-xs">
          {" "}
          · {changed ? "changed" : "default"}
          {question.answerRevision > 1 ? " · revised" : ""}
        </span>
        {question.note && (
          <div className="text-muted-foreground text-xs">Note: {question.note}</div>
        )}
      </div>
      {question.planning && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => setEditing(true)}
        >
          Change
        </Button>
      )}
    </div>
  );
}

function QuestionCard({
  question: q,
  workItemId,
  focused,
  onDiscuss,
  onDone,
}: {
  question: PlanningQuestion;
  workItemId: string;
  focused: boolean;
  onDiscuss?: () => void;
  onDone?: () => void;
}) {
  const options = questionOptions(q);
  const [values, setValues] = useState<string[]>(() => initialAnswer(q));
  const [other, setOther] = useState("");
  const [note, setNote] = useState(q.note ?? "");
  const [noting, setNoting] = useState(!!q.note);
  const { decide, pending } = useDecide();
  const choice = q.kind === "single-choice" || q.kind === "multiple-choice" || q.kind === "yes-no";
  const chosen = other.trim() ? [...values.filter((v) => options.includes(v)), other] : values;
  const answer = answerText(
    q.kind,
    q.kind === "multiple-choice" ? chosen : other.trim() ? [other] : values,
  );
  const toggle = (option: string) =>
    setValues((v) =>
      q.kind === "multiple-choice"
        ? v.includes(option)
          ? v.filter((x) => x !== option)
          : [...v, option]
        : [option],
    );
  return (
    <Card
      className={cn(
        "gap-2.5 px-4 py-3",
        q.status === "open" && "shadow-waiting",
        focused && "ring-2 ring-status-running/50",
      )}
      data-testid={`question-${q.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <span>Q{q.number ?? "?"}</span>
        <Badge variant="outline">{q.domain}</Badge>
        {q.blocking && <span>blocking</span>}
        {q.irreversible && (
          <span className="text-status-waiting">irreversible · answer it yourself</span>
        )}
        {q.escalated && <span className="text-status-waiting">escalated</span>}
        {focused && <span className="text-status-running">the agent asks this next</span>}
      </div>
      <div className="font-semibold text-sm">{q.prompt}</div>
      {q.context && (
        <div className="text-muted-foreground text-xs [&_p]:my-1">
          <Markdown>{q.context}</Markdown>
        </div>
      )}
      {choice && (
        <fieldset>
          <legend className="sr-only">{q.prompt}</legend>
          {q.kind === "multiple-choice" ? (
            <div className="grid gap-1.5">
              {options.map((option) => (
                <ChoiceRow key={option} option={option} question={q} values={values}>
                  <Checkbox
                    checked={values.includes(option)}
                    onCheckedChange={() => toggle(option)}
                  />
                </ChoiceRow>
              ))}
            </div>
          ) : (
            <RadioGroup className="gap-1.5" value={values[0] ?? ""} onValueChange={toggle}>
              {options.map((option) => (
                <ChoiceRow key={option} option={option} question={q} values={values}>
                  <RadioGroupItem value={option} />
                </ChoiceRow>
              ))}
            </RadioGroup>
          )}
        </fieldset>
      )}
      {q.kind === "number" && (
        <Input
          type="number"
          value={values[0] ?? ""}
          onChange={(e) => setValues([e.target.value])}
          aria-label={q.prompt}
        />
      )}
      {(q.kind === "text" || choice) && (
        <Textarea
          rows={q.kind === "text" ? 2 : 1}
          placeholder={q.kind === "text" ? (q.defaultAnswer ?? "Your answer") : "Other…"}
          value={q.kind === "text" ? (values[0] ?? "") : other}
          onChange={(e) =>
            q.kind === "text" ? setValues([e.target.value]) : setOther(e.target.value)
          }
          aria-label={q.kind === "text" ? q.prompt : "Another answer"}
        />
      )}
      {q.recommendationReason && (
        <div className="text-muted-foreground text-xs [&_p]:my-0.5">
          <Markdown>{q.recommendationReason}</Markdown>
        </div>
      )}
      {noting && (
        <Input
          placeholder="A note for the agent (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label="Note"
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!answer || pending !== null}
          onClick={async () => {
            const done = await decide({
              kind: "question.answer",
              workItemId,
              questionId: q.id,
              answer,
              ...(note.trim() ? { note: note.trim() } : {}),
            });
            if (done) onDone?.();
          }}
          data-testid={`answer-${q.id}`}
        >
          {q.status === "answered" ? "Change answer" : "Answer"}
        </Button>
        {!noting && (
          <Button size="sm" variant="ghost" onClick={() => setNoting(true)}>
            Add a note
          </Button>
        )}
        {onDiscuss && (
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

// ---- the living spec ----

/** A hast node's text, for comparing a block with the previous revision. */
function hastText(node: unknown): string {
  const n = node as { value?: string; children?: unknown[] } | undefined;
  if (!n) return "";
  if (typeof n.value === "string") return n.value;
  return (n.children ?? []).map(hastText).join("");
}

/** One answer option: a shadcn checkbox or radio inside a clickable, highlighted row. */
function ChoiceRow({
  option,
  question,
  values,
  children,
}: {
  option: string;
  question: PlanningQuestion;
  values: string[];
  children: ReactNode;
}) {
  return (
    <Label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 font-normal",
        values.includes(option) && "border-foreground/40 bg-accent",
      )}
    >
      {children}
      <span className="grow">{option}</span>
      {question.defaultValues?.includes(option) && (
        <span className="text-muted-foreground text-xs">recommended</span>
      )}
    </Label>
  );
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

function Spec({
  view,
  onOverturn,
  className,
}: {
  view: PlanningView;
  onOverturn: (assumption: string) => void;
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
  const block =
    (Tag: "p" | "li") =>
    ({ node, children }: { node?: unknown; children?: ReactNode }) => {
      const text = hastText(node);
      return (
        <Tag
          className={cn(
            text.includes("⟦assumption⟧") && "rounded bg-status-waiting/10 px-1",
            isChanged(text, previous) && "border-status-running border-l-2 pl-2",
          )}
          data-changed={isChanged(text, previous) ? "true" : undefined}
          data-assumption={text.includes("⟦assumption⟧") ? "true" : undefined}
        >
          {children}
        </Tag>
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
    <Card className={cn("content-start gap-0 py-0", className)} data-testid="living-spec">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 pt-3 pb-2">
        <div className="font-semibold text-sm">Spec</div>
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
        <div className="grid gap-4 px-4 py-3 text-sm">
          <div className="text-sm [&_h1]:font-semibold [&_h1]:text-base [&_h2]:mt-3 [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:my-1.5 [&_code]:font-mono [&_code]:text-xs">
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
    </Card>
  );
}

// ---- chat ----

function Chat({
  view,
  workItemId,
  draft,
  onDraft,
  className,
}: {
  view: PlanningView;
  workItemId: string;
  draft: { text: string; questionId?: string };
  onDraft: (d: { text: string; questionId?: string }) => void;
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
  async function send() {
    const text = draft.text.trim();
    if (!text) return;
    setBusy(true);
    try {
      await op(
        "chat.send",
        { workItemId, text, ...(draft.questionId ? { questionId: draft.questionId } : {}) },
        { idempotencyKey: submitKey() },
      );
      onDraft({ text: "" });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      className={cn("grid-rows-[auto_minmax(0,1fr)_auto] content-start gap-0 py-0", className)}
      data-testid="chat-pane"
    >
      <div className="border-b px-4 pt-3 pb-2 font-semibold text-sm">Chat</div>
      <div className="grid max-h-[60vh] content-start gap-2 overflow-auto px-4 py-3 text-sm">
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
              "grid gap-0.5 rounded-md px-3 py-2",
              m.author === "agent" ? "bg-muted" : "bg-accent",
              m.kind === "gate" && "border border-status-waiting/50",
            )}
            data-testid={`message-${m.id}`}
          >
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span className="font-medium text-foreground">{m.authorName}</span>
              {m.kind === "gate" && <Badge variant="outline">spec gate: changes</Badge>}
              {m.questionId && <Chip tag={`Q${numbers.get(m.questionId) ?? "?"}`} />}
              <span className="grow" />
              <span>{ago(m.createdAt)}</span>
            </div>
            <div className="[&_code]:font-mono [&_code]:text-xs [&_p]:my-0.5">
              <Markdown>{m.text}</Markdown>
            </div>
          </div>
        ))}
        {working && (
          <div className="text-muted-foreground text-xs italic" data-testid="agent-activity">
            Planning agent · {String(view.session?.activity)}…
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="grid gap-1.5 border-t px-4 py-3">
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
          placeholder="Ask the planning agent, or tell it what to change… (Enter to send)"
          value={draft.text}
          onChange={(e) => onDraft({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          data-testid="chat-input"
        />
        <div className="flex justify-end">
          <Button size="sm" disabled={!draft.text.trim() || busy} onClick={send}>
            Send
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---- the gate bar ----

function GateBar({ view, detail }: { view: PlanningView; detail: WorkItemDetail }) {
  const { item } = detail;
  const { decide, pending } = useDecide();
  const [changes, setChanges] = useState(false);
  const open = view.questions.filter((q) => q.status === "open");
  const bulk = open.filter(bulkAcceptable).length;
  const specGate = detail.gates.find((g) => g.kind === "spec" && g.status === "pending");
  const canApprove = !!specGate && detail.viewer.isApprover;
  const partial = view.spec?.coverage.filter((c) => (c as { status: string }).status === "partial");
  return (
    <Card className="flex-row flex-wrap items-center gap-2 px-4 py-2.5" data-testid="gate-bar">
      <span className="text-muted-foreground text-sm" data-testid="planning-progress">
        {gateSummary(view)}
      </span>
      {specGate && partial && partial.length > 0 && (
        <span className="text-status-waiting text-xs">
          {partial.length} coverage categor{partial.length === 1 ? "y" : "ies"} still partial
        </span>
      )}
      <span className="grow" />
      {open.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          disabled={bulk === 0 || pending !== null}
          title={bulk === 0 ? "The open questions need an answer one by one" : undefined}
          onClick={() => decide({ kind: "question.acceptDefaults", workItemId: item.id })}
          data-testid="accept-defaults"
        >
          Accept remaining defaults
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
    </Card>
  );
}
